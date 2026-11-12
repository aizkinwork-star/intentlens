// server/services/segmentationStore.js — short-lived mask cache.
//
// Replicate mask URLs expire and are not same-origin. The PWA must be able to
// draw the exact mask with a normal <canvas>, so the server stores the returned
// PNGs under intentlens-data/segmentation/ and serves them from one origin.
//
// The cache is deliberately small and disposable:
//   - ids are random, never user-supplied paths
//   - only PNG bytes for a bounded mask index are stored
//   - entries older than ttlMs are swept on creation and at startup
//   - deleting a segmentation id removes the whole folder

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const SEGMENTATION_ID_RE = /^seg_[a-f0-9]{16,40}$/;
const MAX_MASK_INDEX = 63;

function validId(id) {
  return SEGMENTATION_ID_RE.test(String(id || ''));
}

function validIndex(index) {
  const n = Number(index);
  return Number.isInteger(n) && n >= 0 && n <= MAX_MASK_INDEX;
}

export class SegmentationStore {
  constructor({
    dataDir = process.env.DATA_DIR || './intentlens-data',
    ttlMs = 24 * 60 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.dataDir = dataDir;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  root() {
    return resolve(this.dataDir, 'segmentation');
  }

  createId() {
    return `seg_${randomBytes(12).toString('hex')}`;
  }

  folder(id) {
    if (!validId(id)) return null;
    return resolve(this.root(), id);
  }

  save(id, index, buffer) {
    if (!validId(id)) throw new Error('Invalid segmentation id.');
    if (!validIndex(index)) throw new Error('Invalid mask index.');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Mask buffer is empty.');
    const folder = this.folder(id);
    mkdirSync(folder, { recursive: true });
    const target = resolve(folder, `mask_${Number(index)}.png`);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, buffer, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    return target;
  }

  read(id, index) {
    if (!validId(id) || !validIndex(index)) return null;
    const file = resolve(this.folder(id), `mask_${Number(index)}.png`);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  remove(id) {
    if (!validId(id)) return false;
    const folder = this.folder(id);
    if (!existsSync(folder)) return false;
    rmSync(folder, { recursive: true, force: true });
    return true;
  }

  /** Remove expired folders. Returns the number removed. */
  sweep() {
    const root = this.root();
    if (!existsSync(root)) return 0;
    let removed = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      const folder = resolve(root, entry.name);
      try {
        const age = this.now() - statSync(folder).mtimeMs;
        if (age >= this.ttlMs) {
          rmSync(folder, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* best-effort cleanup */ }
    }
    return removed;
  }
}

export const segmentationStore = new SegmentationStore();

export default segmentationStore;
