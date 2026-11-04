// server/store.compress.test.js — store compressContext tests.
// Run with: node --test store.compress.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './server/store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'intentlens-store-compress-test-'));
}

function withStore(dir, fn) {
  const store = new Store({ dataDir: dir });
  store.open();
  try { return fn(store); } finally { store.close(); }
}

test('compressContext archives older tasks beyond keepRecent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test');
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        store.createTask({
          projectId: 'p1',
          userCommand: `command ${i}`,
          answerShort: `answer ${i}`,
          providerUsed: 'meta',
          fallbackOccurred: false,
        });
      }
      // Compress keeping only 2 recent
      const result = store.compressContext('p1', 2);
      assert.equal(result.archived, 3);
      assert.equal(result.kept, 2);
      const tasks = store.listTasks('p1');
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].userCommand, 'command 4');
      assert.equal(tasks[1].userCommand, 'command 3');
      // Summary should contain archived tasks
      const project = store.db.prepare('SELECT summary FROM projects WHERE id = ?').get('p1');
      assert.ok(project.summary.includes('command 0'));
      assert.ok(project.summary.includes('command 1'));
      assert.ok(project.summary.includes('command 2'));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compressContext does nothing when tasks <= keepRecent', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test');
      store.createTask({ projectId: 'p1', userCommand: 'cmd', answerShort: 'ans', providerUsed: 'meta', fallbackOccurred: false });
      const result = store.compressContext('p1', 5);
      assert.equal(result.archived, 0);
      assert.equal(result.kept, 1);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compressContext default keepRecent is 3', () => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      store.getOrCreateProject('p1', 'Test');
      for (let i = 0; i < 5; i++) {
        store.createTask({
          projectId: 'p1', userCommand: `cmd ${i}`, answerShort: `ans ${i}`,
          providerUsed: 'meta', fallbackOccurred: false,
        });
      }
      const result = store.compressContext('p1'); // default keepRecent=3
      assert.equal(result.archived, 2);
      assert.equal(result.kept, 3);
      const tasks = store.listTasks('p1');
      assert.equal(tasks.length, 3);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
