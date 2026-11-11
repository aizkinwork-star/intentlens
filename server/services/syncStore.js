// server/services/syncStore.js — short-lived LAN transfer codes for photos.
//
// Why this exists: the GitHub Pages PWA and a desktop on the same Wi-Fi have no
// shared backend. Live video sync is blocked by browser security (an HTTPS page
// cannot POST to a plain-HTTP LAN server, and getUserMedia needs a secure
// context). A gallery file upload does not need a secure context, so the honest
// feature is: the desktop shows a one-time code, the phone opens the
// desktop-served upload page and sends a photo over the LAN.
//
// Security model:
//   - Codes are 6 digits from crypto.randomInt, valid for 10 minutes.
//   - Codes live in memory only: a server restart invalidates every code.
//   - Failed receives are limited per client address.
//   - Payloads must be image data URLs (bounded) or a short text note.
//   - Files are written under intentlens-data/sync/<code>/ with 0600.
//   - No key material, prompts or credentials are ever stored here.

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SYNC_CODE_TTL_MS = 10 * 60 * 1000;
export const SYNC_MAX_ITEMS = 25;
export const SYNC_MAX_ITEM_BYTES = 8 * 1024 * 1024;
export const SYNC_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const SYNC_MAX_FAILED_ATTEMPTS = 20;
export const SYNC_FAILED_WINDOW_MS = 10 * 60 * 1000;
export const SYNC_TYPES = ['photo', 'note'];

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;

function normalizeName(value, fallback) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f<>"/\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return name || fallback;
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

export class SyncStore {
  constructor({ dir, now = () => Date.now(), ttlMs = SYNC_CODE_TTL_MS } = {}) {
    this.dir = resolve(dir || './intentlens-data/sync');
    this.now = now;
    this.ttlMs = ttlMs;
    this.sessions = new Map(); // code -> { code, createdAt, expiresAt, items: Map }
    this.failures = new Map(); // clientKey -> { count, since }
  }

  _prune() {
    const now = this.now();
    for (const [code, session] of this.sessions) {
      if (session.expiresAt <= now) this.remove(code);
    }
    for (const [key, record] of this.failures) {
      if (now - record.since > SYNC_FAILED_WINDOW_MS) this.failures.delete(key);
    }
  }

  _newCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!this.sessions.has(code)) return code;
    }
    throw new Error('Could not allocate a unique sync code.');
  }

  create({ ttlMs = this.ttlMs } = {}) {
    this._prune();
    const code = this._newCode();
    const createdAt = this.now();
    const session = {
      code,
      createdAt,
      expiresAt: createdAt + Math.max(60_000, Number(ttlMs) || this.ttlMs),
      items: new Map(),
      bytes: 0,
    };
    this.sessions.set(code, session);
    return { code, createdAt, expiresAt: session.expiresAt, maxItems: SYNC_MAX_ITEMS, maxItemBytes: SYNC_MAX_ITEM_BYTES };
  }

  /** Validate a code without revealing whether a near-miss is close. */
  session(code) {
    this._prune();
    const key = String(code || '').trim();
    if (!/^\d{6}$/.test(key)) return null;
    return this.sessions.get(key) || null;
  }

  /**
   * Track a failed redeem. Returns false once the client is blocked for the
   * current window. The caller returns the same 404 for a bad code either way.
   */
  recordFailure(clientKey = 'unknown') {
    const now = this.now();
    const key = String(clientKey || 'unknown').slice(0, 120);
    const record = this.failures.get(key);
    if (!record || now - record.since > SYNC_FAILED_WINDOW_MS) {
      this.failures.set(key, { count: 1, since: now });
      return true;
    }
    record.count += 1;
    return record.count <= SYNC_MAX_FAILED_ATTEMPTS;
  }

  isBlocked(clientKey = 'unknown') {
    const record = this.failures.get(String(clientKey || 'unknown').slice(0, 120));
    if (!record) return false;
    if (this.now() - record.since > SYNC_FAILED_WINDOW_MS) {
      this.failures.delete(clientKey);
      return false;
    }
    return record.count > SYNC_MAX_FAILED_ATTEMPTS;
  }

  /**
   * Store one item. Throws a plain Error with a user-safe message; the route
   * turns it into a 400 without leaking internals.
   */
  receive(code, body = {}) {
    const session = this.session(code);
    if (!session) {
      const err = new Error('That upload code is invalid or has expired.');
      err.code = 'SYNC_CODE_INVALID';
      throw err;
    }
    if (session.items.size >= SYNC_MAX_ITEMS) {
      const err = new Error(`This code already received ${SYNC_MAX_ITEMS} items. Create a new code.`);
      err.code = 'SYNC_FULL';
      throw err;
    }

    const type = SYNC_TYPES.includes(body.type) ? body.type : 'photo';
    let payload;
    let name;
    if (type === 'photo') {
      payload = String(body.payload || '');
      if (!DATA_URL_RE.test(payload)) {
        const err = new Error('Only PNG, JPEG or WebP image data is accepted.');
        err.code = 'SYNC_BAD_PAYLOAD';
        throw err;
      }
      name = normalizeName(body.name, `photo-${session.items.size + 1}.jpg`);
    } else {
      payload = String(body.payload || '').slice(0, 8000);
      if (!payload.trim()) {
        const err = new Error('The note is empty.');
        err.code = 'SYNC_BAD_PAYLOAD';
        throw err;
      }
      name = normalizeName(body.name, 'note.txt');
    }

    const bytes = byteLength(payload);
    if (bytes > SYNC_MAX_ITEM_BYTES) {
      const err = new Error(`That item is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${SYNC_MAX_ITEM_BYTES / 1024 / 1024} MB.`);
      err.code = 'SYNC_TOO_LARGE';
      throw err;
    }
    if (session.bytes + bytes > SYNC_MAX_TOTAL_BYTES) {
      const err = new Error('This code has reached its total transfer limit. Create a new code.');
      err.code = 'SYNC_FULL';
      throw err;
    }

    const receivedAt = this.now();
    const id = `${receivedAt.toString(36)}-${randomInt(0, 1_000_000).toString(36)}`;
    const record = { id, type, name, bytes, receivedAt, payload };

    const codeDir = join(this.dir, session.code);
    mkdirSync(codeDir, { recursive: true });
    const file = join(codeDir, `${id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);

    session.items.set(id, { id, type, name, bytes, receivedAt });
    session.bytes += bytes;
    return { id, type, name, bytes, receivedAt };
  }

  list(code) {
    const session = this.session(code);
    if (!session) return null;
    return {
      code: session.code,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      bytes: session.bytes,
      maxBytes: SYNC_MAX_TOTAL_BYTES,
      items: [...session.items.values()].sort((a, b) => b.receivedAt - a.receivedAt),
    };
  }

  get(code, id) {
    const session = this.session(code);
    if (!session) return null;
    const meta = session.items.get(String(id || ''));
    if (!meta) return null;
    const file = join(this.dir, session.code, `${meta.id}.json`);
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      return { ...meta, payload: stored.payload };
    } catch {
      return null;
    }
  }

  remove(code) {
    const key = String(code || '');
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    const dir = join(this.dir, key);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
    return Boolean(session);
  }

  /**
   * Remove code folders older than `maxAgeMs`. Called at startup so a crash
   * cannot leave orphaned photos around forever.
   */
  sweepOrphans({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
    if (!existsSync(this.dir)) return 0;
    const now = this.now();
    let removed = 0;
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(this.dir, entry.name);
      try {
        if (now - statSync(full).mtimeMs > maxAgeMs) {
          rmSync(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* ignore */ }
    }
    return removed;
  }
}

export const syncStore = new SyncStore({ dir: resolve(process.env.DATA_DIR || './intentlens-data', 'sync') });
