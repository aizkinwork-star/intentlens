// knnLab.test.js — measured, reproducible k-NN calibration on synthetic data.
//
// These fixtures are synthetic clusters, not photographs. They prove the
// pipeline and the failure modes; they are not a claim about real component
// accuracy. Every number below is computed by the code in this run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrateOperatingPoint,
  classificationMetrics,
  classify,
  evaluateFrozen,
  evaluateSplit,
  prepareReferences,
  toCalibrationRecords,
} from './perception/learning/KnnLab.js';
import { selectMedoids, buildReferenceSet, createRandom } from './perception/learning/ReferenceSelector.js';
import { calibrationReport, MEASUREMENT_MIN_SAMPLES } from './perception/pcb/gridConfidence.js';

const CENTERS = [
  [0, 0], [10, 0], [0, 10], [10, 10], [-10, 0], [0, -10],
];
const LABELS = CENTERS.map((_, index) => `class-${index}`);

function makeSplit(perClass, spread, seed) {
  const random = createRandom(seed);
  const vectors = [];
  const labels = [];
  for (let c = 0; c < CENTERS.length; c += 1) {
    for (let i = 0; i < perClass; i += 1) {
      vectors.push(CENTERS[c].map((value) => value + (random() - 0.5) * spread));
      labels.push(LABELS[c]);
    }
  }
  return { vectors, labels };
}

function referenceFrom(train, perClass = 5, seed = 1) {
  const selection = selectMedoids(train.vectors, train.labels, { perClass, seed });
  return buildReferenceSet(train.vectors, train.labels, selection);
}

test('a separable reference set accepts the right label with a positive margin', () => {
  const train = makeSplit(20, 1.2, 1);
  const refs = referenceFrom(train);
  const prepared = prepareReferences(refs.vectors, refs.labels);
  const prediction = classify(CENTERS[2], prepared, { k: 3, maxDist: Infinity, separation: 1.0 });
  assert.equal(prediction.accepted, true);
  assert.equal(prediction.label, 'class-2');
  assert.ok(prediction.margin > 0.5, `margin ${prediction.margin}`);
});

test('validation-only calibration rejects a grid that would answer nothing', () => {
  const train = makeSplit(30, 1.0, 2);
  const valid = makeSplit(20, 1.0, 3);
  const testSplit = makeSplit(20, 1.0, 4);
  const refs = referenceFrom(train, 5, 2);

  // The 1e-9 cap rejects every query; the sweep must not choose it.
  const calibrated = calibrateOperatingPoint({
    references: refs,
    validVectors: valid.vectors,
    validLabels: valid.labels,
    minCoverage: 0.5,
    grid: {
      k: [1, 3, 5],
      maxDist: [1e-9, Infinity],
      separation: [1.0, 1.5],
      weighted: [true],
      classBalanced: [false, true],
      localScaling: [false],
      localScaleK: 7,
    },
  });

  assert.equal(calibrated.metCoverage, true);
  assert.ok(calibrated.metrics.coverage >= 0.5, `coverage ${calibrated.metrics.coverage}`);
  assert.ok(calibrated.metrics.acceptedAccuracy > 0.9, `accepted ${calibrated.metrics.acceptedAccuracy}`);

  const frozen = evaluateFrozen({
    references: refs,
    vectors: testSplit.vectors,
    labels: testSplit.labels,
    config: calibrated.config,
  });
  assert.equal(frozen.count, testSplit.vectors.length);
  assert.equal(frozen.trustworthy, true);
  assert.ok(frozen.acceptedAccuracy > 0.9, `test accepted ${frozen.acceptedAccuracy}`);
  assert.ok(frozen.coverage > 0.5, `test coverage ${frozen.coverage}`);
});

test('class-balanced voting stops a large class from drowning a small one', () => {
  // Five references of the majority class sit next to the query; 95 more sit
  // far away, giving that class a 100:1 count advantage. One minority reference
  // is farther than the near majority points.
  const vectors = [
    ...Array.from({ length: 5 }, () => [0.2, 0]),
    ...Array.from({ length: 95 }, () => [50, 0]),
    [2, 0],
  ];
  const labels = [...Array(100).fill('major'), 'minor'];
  const prepared = prepareReferences(vectors, labels);
  const plain = classify([0, 0], prepared, { k: 6, maxDist: Infinity, separation: 1.0 });
  const balanced = classify([0, 0], prepared, { k: 6, maxDist: Infinity, separation: 1.0, classBalanced: true });
  assert.equal(plain.label, 'major');
  assert.equal(balanced.label, 'minor');
});

test('local scaling produces per-reference scales and still classifies clean data', () => {
  const train = makeSplit(20, 0.4, 5);
  const refs = referenceFrom(train, 5, 5);
  const prepared = prepareReferences(refs.vectors, refs.labels, { localScaling: true, localScaleK: 3 });
  assert.ok(Array.isArray(prepared.sigmas));
  assert.equal(prepared.sigmas.length, refs.vectors.length);
  assert.ok(prepared.sigmas.every((value) => Number.isFinite(value) && value > 0));
  const prediction = classify(CENTERS[0], prepared, {
    k: 3, maxDist: Infinity, separation: 1.0, localScaling: true, localScaleK: 3,
  });
  assert.equal(prediction.label, 'class-0');
  assert.equal(prediction.accepted, true);
});

test('a low separation threshold keeps ambiguous answers out instead of guessing', () => {
  // Two labels occupy the same point, so neither can win by distance.
  const vectors = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const labels = ['a', 'a', 'b', 'b'];
  const prepared = prepareReferences(vectors, labels);
  const loose = classify([0, 0], prepared, { k: 4, maxDist: Infinity, separation: 1.0 });
  const strict = classify([0, 0], prepared, { k: 4, maxDist: Infinity, separation: 1.5 });
  assert.equal(loose.accepted, true);
  assert.equal(strict.accepted, false);
  assert.equal(strict.reason, 'ambiguous');
  assert.equal(strict.label, 'unknown');
});

test('metrics count an unknown as wrong but exclude it from accepted accuracy', () => {
  const report = classificationMetrics(
    ['a', 'a', 'b', 'b'],
    ['a', 'unknown', 'b', 'a'],
  );
  assert.equal(report.count, 4);
  assert.equal(report.accepted, 3);
  assert.equal(report.coverage, 0.75);
  assert.ok(Math.abs(report.acceptedAccuracy - 2 / 3) < 1e-9);
  assert.equal(report.overallAccuracy, 0.5);
  assert.equal(report.perClass.a.tp, 1);
  assert.equal(report.perClass.a.fp, 1);
  assert.equal(report.perClass.a.fn, 1);
  assert.ok(Math.abs(report.perClass.b.f1 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(report.macroPrecision - 0.75) < 1e-9);
  assert.ok(Math.abs(report.macroRecall - 0.5) < 1e-9);
});

test('an empty or small sample never becomes a trusted accuracy claim', () => {
  const empty = classificationMetrics([], []);
  assert.equal(empty.acceptedAccuracy, null);
  assert.equal(empty.overallAccuracy, null);
  assert.equal(empty.trustworthy, false);

  const small = classificationMetrics(Array(MEASUREMENT_MIN_SAMPLES - 1).fill('a'), Array(MEASUREMENT_MIN_SAMPLES - 1).fill('a'));
  assert.equal(small.overallAccuracy, 1);
  assert.equal(small.trustworthy, false);
  assert.match(small.reason, /below/);

  const trusted = classificationMetrics(Array(MEASUREMENT_MIN_SAMPLES).fill('a'), Array(MEASUREMENT_MIN_SAMPLES).fill('a'));
  assert.equal(trusted.trustworthy, true);
});

test('rejected predictions carry zero confidence into calibration', () => {
  const prepared = prepareReferences([[0, 0], [100, 100]], ['a', 'b']);
  const prediction = classify([10, 10], prepared, { k: 1, maxDist: 1, separation: 1.0 });
  assert.equal(prediction.accepted, false);
  assert.equal(prediction.reason, 'too_far');
  const records = toCalibrationRecords(['a'], [prediction]);
  assert.equal(records[0].confidence, 0);
  assert.equal(records[0].correct, 0);
  const calibration = calibrationReport(records);
  assert.equal(calibration.brier, 0);
});

test('evaluateSplit accepts a raw reference set and reports every split count', () => {
  const train = makeSplit(15, 0.8, 6);
  const refs = referenceFrom(train, 4, 6);
  const report = evaluateSplit({
    references: { vectors: refs.vectors, labels: refs.labels },
    vectors: train.vectors,
    labels: train.labels,
    config: { k: 3, maxDist: Infinity, separation: 1.0 },
  });
  assert.equal(report.count, train.vectors.length);
  assert.ok(report.acceptedAccuracy > 0.9);
});
