// server/services/vectorStore.test.js — Vector store tests.
// Run with: node --test server/services/vectorStore.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorStore, cosineSimilarity, normalizeVector } from './vectorStore.js';

// ---------------------------------------------------------------------------
// cosineSimilarity tests
// ---------------------------------------------------------------------------

test('cosineSimilarity: identical vectors = 1', () => {
  const v = [1, 2, 3];
  assert.strictEqual(cosineSimilarity(v, v), 1);
});

test('cosineSimilarity: orthogonal vectors = 0', () => {
  assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: opposite vectors = -1', () => {
  assert.strictEqual(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test('cosineSimilarity: same direction different magnitude = 1', () => {
  assert.strictEqual(Math.abs(cosineSimilarity([1, 2], [2, 4]) - 1) < 1e-10, true);
});

test('cosineSimilarity: zero vector = 0', () => {
  assert.strictEqual(cosineSimilarity([0, 0], [1, 2]), 0);
  assert.strictEqual(cosineSimilarity([1, 2], [0, 0]), 0);
  assert.strictEqual(cosineSimilarity([0, 0], [0, 0]), 0);
});

test('cosineSimilarity: different lengths = 0', () => {
  assert.strictEqual(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test('cosineSimilarity: empty vectors = 0', () => {
  assert.strictEqual(cosineSimilarity([], []), 0);
  assert.strictEqual(cosineSimilarity([], [1]), 0);
});

// ---------------------------------------------------------------------------
// normalizeVector tests
// ---------------------------------------------------------------------------

test('normalizeVector: unit vector unchanged', () => {
  const v = [1, 0, 0];
  const n = normalizeVector(v);
  assert.deepEqual(n, [1, 0, 0]);
});

test('normalizeVector: normalizes to unit length', () => {
  const v = [3, 4];
  const n = normalizeVector(v);
  assert.strictEqual(n.length, 2);
  assert.strictEqual(Math.abs(n[0] - 0.6) < 1e-10, true);
  assert.strictEqual(Math.abs(n[1] - 0.8) < 1e-10, true);
  // Verify unit length
  const len = Math.sqrt(n[0] * n[0] + n[1] * n[1]);
  assert.strictEqual(Math.abs(len - 1) < 1e-10, true);
});

test('normalizeVector: zero vector unchanged', () => {
  const v = [0, 0, 0];
  const n = normalizeVector(v);
  assert.deepEqual(n, [0, 0, 0]);
});

test('normalizeVector: empty vector unchanged', () => {
  const v = [];
  const n = normalizeVector(v);
  assert.deepEqual(n, []);
});

// ---------------------------------------------------------------------------
// VectorStore tests
// ---------------------------------------------------------------------------

test('VectorStore: add and search single vector', () => {
  const store = new VectorStore();
  const id = store.add('vec-1', [1, 0, 0], { label: 'x-axis' });
  assert.equal(id, 'vec-1');
  const results = store.search([1, 0, 0], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'vec-1');
  assert.ok(results[0].score > 0.99);
});

test('VectorStore: ranks by similarity (highest first)', () => {
  const store = new VectorStore();
  store.add('a', [1, 0, 0], { label: 'x-axis' });
  store.add('b', [0.9, 0.1, 0], { label: 'near-x' });
  store.add('c', [0, 1, 0], { label: 'y-axis' });

  const results = store.search([1, 0, 0], 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 'a'); // exact match first
  assert.ok(results[0].score > results[1].score); // descending order
  assert.ok(results[1].score > results[2].score);
});

test('VectorStore: topK limits results', () => {
  const store = new VectorStore();
  store.add('a', [1, 0, 0], { label: 'a' });
  store.add('b', [0.9, 0.1, 0], { label: 'b' });
  store.add('c', [0, 1, 0], { label: 'c' });

  const results = store.search([1, 0, 0], 2);
  assert.equal(results.length, 2);
});

test('VectorStore: delete removes vector', () => {
  const store = new VectorStore();
  store.add('a', [1, 0, 0], { label: 'a' });
  store.add('b', [0, 1, 0], { label: 'b' });

  store.delete('a');
  const results = store.search([1, 0, 0], 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'b');
});

test('VectorStore: count and clear', () => {
  const store = new VectorStore();
  assert.equal(store.count(), 0);
  store.add('a', [1, 0, 0], { label: 'a' });
  store.add('b', [0, 1, 0], { label: 'b' });
  assert.equal(store.count(), 2);
  store.clear();
  assert.equal(store.count(), 0);
});

test('VectorStore: empty store search returns empty', () => {
  const store = new VectorStore();
  const results = store.search([1, 0, 0], 5);
  assert.equal(results.length, 0);
});
