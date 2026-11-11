// syncStore.test.js — one-time LAN transfer codes, bounds and expiry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyncStore,
  SYNC_MAX_ITEMS,
  SYNC_MAX_ITEM_BYTES,
  SYNC_MAX_FAILED_ATTEMPTS,
} from './server/services/syncStore.js';

function makeStore(nowRef = { t: Date.now() }) {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-sync-'));
  const store = new SyncStore({ dir, now: () => nowRef.t, ttlMs: 10 * 60 * 1000 });
  return { store, dir, nowRef, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a created code is six digits and valid until its TTL', () => {
  const { store, cleanup, nowRef } = makeStore();
  const created = store.create();
  assert.match(created.code, /^\d{6}$/);
  assert.equal(created.expiresAt - created.createdAt, 10 * 60 * 1000);
  assert.ok(store.session(created.code));
  assert.equal(store.session('abc123'), null);
  nowRef.t += 10 * 60 * 1000 + 1;
  assert.equal(store.session(created.code), null, 'an expired code stops working');
  cleanup();
});

test('a photo is stored and can be listed and read back', () => {
  const { store, cleanup } = makeStore();
  const { code } = store.create();
  const item = store.receive(code, { type: 'photo', name: '../unsafe<name>.jpg', payload: tinyPng });
  assert.equal(item.type, 'photo');
  assert.equal(item.name, 'unsafename.jpg', 'path characters are stripped');
  assert.ok(item.bytes > 0);

  const list = store.list(code);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, item.id);
  assert.equal(list.maxBytes > 0, true);

  const stored = store.get(code, item.id);
  assert.equal(stored.payload, tinyPng);
  assert.equal(store.get(code, 'missing'), null);
  cleanup();
});

test('non-image payloads and empty notes are refused', () => {
  const { store, cleanup } = makeStore();
  const { code } = store.create();
  assert.throws(() => store.receive(code, { type: 'photo', payload: 'data:text/html;base64,PHNjcmlwdD4=' }), /PNG, JPEG or WebP/);
  assert.throws(() => store.receive(code, { type: 'photo', payload: 'not a data url' }), /PNG, JPEG or WebP/);
  assert.throws(() => store.receive(code, { type: 'note', payload: '   ' }), /empty/);
  assert.equal(store.list(code).items.length, 0);
  cleanup();
});

test('a note is accepted and bounded', () => {
  const { store, cleanup } = makeStore();
  const { code } = store.create();
  const item = store.receive(code, { type: 'note', name: 'n', payload: 'back of the board' });
  assert.equal(item.type, 'note');
  assert.equal(store.get(code, item.id).payload, 'back of the board');
  const long = 'x'.repeat(20_000);
  const trimmed = store.receive(code, { type: 'note', name: 'long', payload: long });
  assert.equal(store.get(code, trimmed.id).payload.length, 8000, 'notes are truncated, not stored unbounded');
  cleanup();
});

test('a code stops accepting items at its item cap', () => {
  const { store, cleanup } = makeStore();
  const { code } = store.create();
  for (let i = 0; i < SYNC_MAX_ITEMS; i += 1) {
    store.receive(code, { type: 'photo', name: `p${i}.png`, payload: tinyPng });
  }
  assert.throws(() => store.receive(code, { type: 'photo', payload: tinyPng }), /already received/);
  cleanup();
});

test('an oversized item is refused before it is written', () => {
  const { store, dir, cleanup } = makeStore();
  const { code } = store.create();
  const huge = `data:image/png;base64,${'A'.repeat(SYNC_MAX_ITEM_BYTES + 64)}`;
  assert.throws(() => store.receive(code, { type: 'photo', payload: huge }), /limit is/);
  const codeDir = join(dir, code);
  const files = existsSync(codeDir) ? readdirSync(codeDir) : [];
  assert.deepEqual(files, []);
  cleanup();
});

test('invalid codes are never stored and failures are rate limited', () => {
  const { store, cleanup } = makeStore();
  assert.equal(store.session('123'), null);
  assert.equal(store.session('abcdef'), null);
  assert.equal(store.isBlocked('10.0.0.9'), false);
  for (let i = 0; i < SYNC_MAX_FAILED_ATTEMPTS; i += 1) {
    assert.equal(store.recordFailure('10.0.0.9'), true);
  }
  assert.equal(store.recordFailure('10.0.0.9'), false);
  assert.equal(store.isBlocked('10.0.0.9'), true);
  assert.equal(store.isBlocked('10.0.0.10'), false);
  cleanup();
});

test('removing a code deletes its files and invalidates it', () => {
  const { store, dir, cleanup } = makeStore();
  const { code } = store.create();
  store.receive(code, { type: 'photo', payload: tinyPng });
  assert.ok(existsSync(join(dir, code)));
  assert.equal(store.remove(code), true);
  assert.equal(store.session(code), null);
  assert.equal(existsSync(join(dir, code)), false);
  assert.equal(store.remove(code), false);
  cleanup();
});

test('sweepOrphans removes old folders but keeps fresh ones', () => {
  const { store, dir, cleanup } = makeStore();
  const oldCode = store.create().code;
  store.receive(oldCode, { type: 'photo', payload: tinyPng });
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(join(dir, oldCode), old, old);
  const freshCode = store.create().code;
  store.receive(freshCode, { type: 'photo', payload: tinyPng });
  const removed = store.sweepOrphans({ maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.equal(removed, 1);
  assert.equal(existsSync(join(dir, oldCode)), false);
  assert.equal(existsSync(join(dir, freshCode)), true);
  cleanup();
});
