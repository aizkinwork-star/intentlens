// referenceSelector.test.js — deterministic, reproducible reference selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReferenceSet,
  createRandom,
  distortionOf,
  groupByLabel,
  selectMedoids,
} from './perception/learning/ReferenceSelector.js';

function rng(seed) {
  const random = createRandom(seed);
  return () => random();
}

function cluster(center, count, spread, random) {
  return Array.from({ length: count }, () => center.map((value) => value + (random() - 0.5) * spread));
}

test('grouping is stable and keeps every sample of a small class', () => {
  const vectors = [[0], [1], [2], [3], [4]];
  const labels = ['b', 'a', 'b', 'a', 'b'];
  const groups = groupByLabel(labels);
  assert.deepEqual([...groups.keys()], ['a', 'b']);
  assert.deepEqual(groups.get('a'), [1, 3]);
  assert.deepEqual(groups.get('b'), [0, 2, 4]);

  const selection = selectMedoids(vectors, labels, { perClass: 10 });
  assert.equal(selection.total, 5);
  assert.deepEqual(selection.perClassCounts, { a: 2, b: 3 });
});

test('selection is deterministic for the same data and seed', () => {
  const random = rng(7);
  const vectors = [
    ...cluster([0, 0], 40, 0.6, random),
    ...cluster([5, 5], 40, 0.6, random),
    ...cluster([-5, 4], 40, 0.6, random),
  ];
  const labels = [
    ...Array(40).fill('a'),
    ...Array(40).fill('b'),
    ...Array(40).fill('c'),
  ];
  const first = selectMedoids(vectors, labels, { perClass: 5, seed: 11 });
  const second = selectMedoids(vectors, labels, { perClass: 5, seed: 11 });
  assert.deepEqual(first.indices, second.indices);
  assert.deepEqual(first.perClassCounts, { a: 5, b: 5, c: 5 });
  assert.equal(first.total, 15);
});

test('medoids avoid a gross outlier instead of representing it', () => {
  const random = rng(3);
  const vectors = cluster([0, 0], 25, 0.3, random);
  vectors.push([100, 100]); // a bad crop that must not become a reference
  const labels = [...Array(25).fill('part'), 'part'];
  const selection = selectMedoids(vectors, labels, { perClass: 3 });
  assert.equal(selection.indices.length, 3);
  assert.equal(selection.indices.includes(25), false, 'the outlier was selected');
  const medoids = selection.indices.map((index) => vectors[index]);
  // Every medoid should sit near the real cluster, not halfway to the outlier.
  for (const medoid of medoids) {
    assert.ok(Math.hypot(medoid[0], medoid[1]) < 1, `medoid ${medoid} is outside the cluster`);
  }
});

test('a class with exactly the budget is copied unchanged', () => {
  const vectors = [[0], [1], [2]];
  const labels = ['x', 'x', 'x'];
  const selection = selectMedoids(vectors, labels, { perClass: 3 });
  assert.deepEqual(selection.indices, [0, 1, 2]);
  assert.equal(distortionOf(vectors, [0, 1, 2], selection.indices), 0);
});

test('buildReferenceSet materialises detached vectors and the run record', () => {
  const vectors = [[0, 0], [1, 1], [5, 5]];
  const labels = ['a', 'a', 'b'];
  const selection = selectMedoids(vectors, labels, { perClass: 1, seed: 4 });
  const refs = buildReferenceSet(vectors, labels, selection);
  assert.equal(refs.total, 2);
  assert.equal(refs.seed, 4);
  assert.equal(refs.vectors.length, 2);
  assert.ok(refs.vectors[0] instanceof Float64Array);
  assert.deepEqual(refs.labels, ['a', 'b']);
});

test('malformed datasets throw instead of being silently repaired', () => {
  assert.throws(() => selectMedoids([[0], [1]], ['a'], {}), /same length/);
  assert.throws(() => selectMedoids([[0, 1], [1]], ['a', 'b'], {}), /dimension/);
  assert.throws(() => selectMedoids([[0, NaN]], ['a'], {}), /non-finite/);
  assert.throws(() => selectMedoids([], [], {}), /empty/);
});
