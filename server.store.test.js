// server.store.test.js — SQLite store tests. Uses a temp dir. Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './server/store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'intentlens-store-test-'));
}

function withStore(dir, fn) {
  const store = new Store({ dataDir: dir });
  store.open();
  try { return fn(store); } finally { store.close(); }
}

test('create + get object assigns O1/O2 ids and serializes normalized coords', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test project');
      const obj = store.createObject({
        projectId: 'p1',
        userLabel: 'battery connector',
        aiLabel: 'connector (proposed)',
        kind: 'conn',
        originalImagePath: 'images/a.jpg',
        cropImagePath: 'crops/O1_crop.jpg',
        sourceFrameId: 'frame_001',
        anchor: { x: 0.35, y: 0.475 },
        box: { x: 0.3, y: 0.4, width: 0.1, height: 0.15 },
        appearance: { colourSummary: 'gold', shapeSummary: 'rect' },
        partNumber: 'J1',
        confidence: 0.85,
        identityStatus: 'proposed',
        currentTrackingState: 'tracking',
        evidence: [{ title: 'Manual', url: 'https://example.com/m', claim: 'pin 1', kind: 'web_source' }],
      });
      assert.equal(obj.id, 'O1');
      assert.equal(obj.userLabel, 'battery connector');
      assert.deepEqual(obj.anchor, { x: 0.35, y: 0.475 });
      assert.deepEqual(obj.box, { x: 0.3, y: 0.4, width: 0.1, height: 0.15 });
      assert.equal(obj.evidence.length, 1);
      assert.equal(obj.evidence[0].kind, 'web_source');

      const obj2 = store.createObject({
        projectId: 'p1', userLabel: 'RAM', kind: 'chip',
        anchor: { x: 0.6, y: 0.4 }, box: { x: 0.55, y: 0.32, width: 0.09, height: 0.14 },
      });
      assert.equal(obj2.id, 'O2');

      const got = store.getObject('O1');
      assert.ok(got);
      assert.equal(got.aiLabel, 'connector (proposed)');
      assert.equal(got.currentTrackingState, 'tracking');

      const list = store.listObjects('p1');
      assert.equal(list.length, 2);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('updateObject changes fields and bumps updatedAt', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test project');
      store.createObject({ projectId: 'p1', userLabel: 'x', kind: 'chip' });
      const before = store.getObject('O1').updatedAt;
      const updated = store.updateObject('O1', { userLabel: 'battery connector', confidence: 0.9 });
      assert.equal(updated.userLabel, 'battery connector');
      assert.equal(updated.confidence, 0.9);
      assert.ok(updated.updatedAt >= before);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteObject removes the object', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test project');
      store.createObject({ projectId: 'p1', userLabel: 'x', kind: 'chip' });
      assert.ok(store.getObject('O1'));
      store.deleteObject('O1');
      assert.equal(store.getObject('O1'), null);
      assert.equal(store.listObjects('p1').length, 0);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('image cap: keeps latest 5 unless pinned, deletes oldest', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test project');
      const ids = [];
      for (let i = 0; i < 7; i++) {
        writeFileSync(join(dir, 'images', `img${i}.jpg`), 'x');
        ids.push(store.addImage('p1', `images/img${i}.jpg`, i === 6)); // last one pinned
      }
      const list = store.listImages('p1');
      assert.equal(list.length, 5, 'expected 5 images after cap, got ' + list.length);
      assert.ok(list.some((i) => i.id === ids[6]), 'pinned image missing');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('task cap: keeps latest 15, archives oldest into project summary', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test');
      for (let i = 0; i < 17; i++) {
        store.createTask({
          projectId: 'p1', userCommand: `cmd ${i}`, answerShort: `ans ${i}`,
          providerUsed: 'ollama-cloud', fallbackOccurred: false,
        });
      }
      const tasks = store.listTasks('p1');
      assert.equal(tasks.length, 15, 'expected 15 tasks, got ' + tasks.length);
      assert.equal(tasks[0].userCommand, 'cmd 16');
      const project = store.db.prepare('SELECT summary FROM projects WHERE id = ?').get('p1');
      assert.ok(project.summary.includes('cmd 0'), 'oldest task should be archived into summary');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getProjectContext returns summary, tasks, objects, images', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Board inspection');
      store.createObject({ projectId: 'p1', userLabel: 'SoC', kind: 'chip' });
      store.createTask({ projectId: 'p1', userCommand: 'where is SoC', answerShort: 'centre', providerUsed: 'mock' });
      const ctx = store.getProjectContext('p1');
      assert.equal(ctx.project.name, 'Board inspection');
      assert.equal(ctx.tasks.length, 1);
      assert.equal(ctx.objects.length, 1);
      assert.equal(ctx.objects[0].userLabel, 'SoC');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteProject removes project, objects and tasks', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'x');
      store.createObject({ projectId: 'p1', userLabel: 'x', kind: 'chip' });
      store.createTask({ projectId: 'p1', userCommand: 'c', answerShort: 'a', providerUsed: 'mock' });
      store.deleteProject('p1');
      assert.equal(store.getProjectContext('p1'), null);
      assert.equal(store.listObjects('p1').length, 0);
      assert.equal(store.listTasks('p1').length, 0);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
