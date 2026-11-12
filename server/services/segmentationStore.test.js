import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SegmentationStore } from './segmentationStore.js';

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'intentlens-seg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('masks round-trip through the disposable cache', () => {
  withTemp((dir) => {
    const store = new SegmentationStore({ dataDir: dir });
    const id = store.createId();
    assert.match(id, /^seg_[a-f0-9]{24}$/);
    store.save(id, 0, Buffer.from('png-bytes'));
    assert.equal(store.read(id, 0).toString(), 'png-bytes');
    assert.equal(store.read(id, 1), null);
    assert.equal(store.remove(id), true);
    assert.equal(store.read(id, 0), null);
  });
});

test('path-like ids and out-of-range mask indexes are rejected', () => {
  withTemp((dir) => {
    const store = new SegmentationStore({ dataDir: dir });
    assert.throws(() => store.save('../../etc', 0, Buffer.from('x')));
    assert.throws(() => store.save('seg_' + 'a'.repeat(24), 64, Buffer.from('x')));
    assert.throws(() => store.save('seg_' + 'a'.repeat(24), 0, Buffer.alloc(0)));
    assert.equal(store.read('seg_' + 'a'.repeat(24), 0), null);
    assert.equal(store.remove('not-an-id'), false);
  });
});

test('expired folders are swept and fresh folders are kept', () => {
  withTemp((dir) => {
    const now = 10_000_000;
    const store = new SegmentationStore({ dataDir: dir, ttlMs: 1000, now: () => now });
    const oldId = store.createId();
    const freshId = store.createId();
    store.save(oldId, 0, Buffer.from('old'));
    store.save(freshId, 0, Buffer.from('new'));
    const oldTime = (now - 5000) / 1000;
    utimesSync(join(store.folder(oldId)), oldTime, oldTime);
    assert.equal(store.sweep(), 1);
    assert.equal(store.read(oldId, 0), null);
    assert.equal(store.read(freshId, 0).toString(), 'new');
    assert.ok(statSync(store.folder(freshId)).isDirectory());
  });
});
