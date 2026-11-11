// gridConfidence.test.js — IoU matching, confidence heuristics and honest
// accuracy measurement. These fixtures are labelled on purpose: the module is
// the place that would produce an accuracy claim, so it must refuse to guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEASUREMENT_MIN_SAMPLES,
  accuracyReport,
  aggregateConfidence,
  boardQuadQuality,
  boxCenter,
  calibrationReport,
  componentConfidence,
  evaluateDetections,
  gridCellResidual,
  gridLineAlignmentScore,
  gridSnapScore,
  iou,
  isValidBox,
  matchBoxes,
} from './perception/pcb/gridConfidence.js';

const box = (x, y, width, height) => ({ x, y, width, height });

test('IoU is exact for identical, disjoint and partially overlapping boxes', () => {
  assert.equal(iou(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2)), 1);
  assert.equal(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1)), 0);
  const partial = iou(box(0, 0, 0.5, 0.5), box(0.25, 0.25, 0.5, 0.5));
  assert.ok(Math.abs(partial - 0.0625 / 0.4375) < 1e-9, String(partial));
  assert.equal(iou(null, box(0, 0, 1, 1)), 0);
  assert.equal(iou(box(0, 0, 0, 1), box(0, 0, 1, 1)), 0);
});

test('box helpers reject malformed geometry instead of repairing it', () => {
  assert.equal(isValidBox(box(0, 0, 1, 1)), true);
  assert.equal(isValidBox(box(0, 0, 0, 1)), false);
  assert.equal(isValidBox(box(NaN, 0, 1, 1)), false);
  assert.equal(isValidBox(null), false);
  const centre = boxCenter(box(0.2, 0.4, 0.2, 0.2));
  assert.ok(Math.abs(centre.x - 0.3) < 1e-12);
  assert.equal(centre.y, 0.5);
  assert.equal(boxCenter(null), null);
});

test('one-to-one matching counts a duplicate prediction as a false positive', () => {
  const truth = [box(0.2, 0.2, 0.2, 0.2)];
  const predictions = [box(0.2, 0.2, 0.2, 0.2), box(0.21, 0.21, 0.2, 0.2)];
  const result = evaluateDetections(predictions, truth, { iouThreshold: 0.5 });
  assert.equal(result.matched, 1);
  assert.deepEqual(result.unmatchedPredictions, [1]);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 1);
  assert.ok(Math.abs(result.accuracy - 2 / 3) < 1e-9);
});

test('a missed component lowers recall and accuracy, never precision alone', () => {
  const predictions = [box(0.2, 0.2, 0.2, 0.2)];
  const truth = [box(0.2, 0.2, 0.2, 0.2), box(0.6, 0.6, 0.1, 0.1)];
  const result = evaluateDetections(predictions, truth, { iouThreshold: 0.5 });
  assert.equal(result.matched, 1);
  assert.deepEqual(result.unmatchedTruth, [1]);
  assert.equal(result.falseNegatives, 1);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 0.5);
  assert.ok(Math.abs(result.accuracy - 2 / 3) < 1e-9);
  assert.equal(result.meanIou, 1);
});

test('an empty evaluation reports null, not a perfect score', () => {
  const result = evaluateDetections([], [], { iouThreshold: 0.5 });
  assert.equal(result.matched, 0);
  assert.equal(result.precision, null);
  assert.equal(result.recall, null);
  assert.equal(result.accuracy, null);
  assert.equal(result.f1, null);
});

test('grid snapping is 1 at cell centres and lower under jitter', () => {
  const size = 64;
  const centers = [];
  for (let i = 0; i < 8; i += 1) centers.push({ x: (i + 0.5) / size, y: (i + 0.5) / size });
  assert.equal(gridCellResidual(centers[0], size), 0);
  assert.equal(gridSnapScore(centers, { gridSize: size }), 1);

  const jittered = centers.map((p) => ({ x: p.x + 0.25 / size, y: p.y + 0.25 / size }));
  const jitterScore = gridSnapScore(jittered, { gridSize: size });
  assert.ok(jitterScore < 0.7, String(jitterScore));
  assert.equal(gridSnapScore([], { gridSize: size }), null);
});

test('grid-line alignment is the complement of snapping to centres', () => {
  const size = 64;
  const lines = [];
  for (let i = 0; i <= 4; i += 1) lines.push({ x: (i * 8) / size, y: (i * 8) / size });
  assert.equal(gridLineAlignmentScore(lines, { gridSize: size }), 1);
  const centers = lines.map((p) => ({ x: p.x + 0.5 / size, y: p.y + 0.5 / size }));
  assert.ok(gridLineAlignmentScore(centers, { gridSize: size }) < 0.01);
  assert.equal(gridLineAlignmentScore([]), null);
});

test('board quads must be convex and non-degenerate', () => {
  const square = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
  const good = boardQuadQuality(square);
  assert.equal(good.ok, true);
  assert.ok(good.score > 0.8, String(good.score));
  assert.equal(good.convex, true);
  assert.ok(Math.abs(good.area - 0.64) < 1e-9);

  const bowTie = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const bad = boardQuadQuality(bowTie);
  assert.equal(bad.ok, false);
  assert.equal(bad.convex, false);
  assert.equal(bad.reason, 'self-intersecting');

  assert.equal(boardQuadQuality([{ x: 0, y: 0 }]).ok, false);
  assert.equal(boardQuadQuality([]).reason, 'need-four-points');
});

test('component confidence combines declared evidence and never exceeds 1', () => {
  const high = componentConfidence({ similarity: 0.95, sharpness: 200, presence: 1, iou: 0.9 });
  assert.equal(high.label, 'high');
  assert.ok(high.score > 0.85 && high.score <= 1, String(high.score));

  const low = componentConfidence({ similarity: 0.1, sharpness: 4, presence: 0.1, iou: 0.1 });
  assert.equal(low.label, 'low');
  assert.ok(low.score < 0.3, String(low.score));

  const mid = componentConfidence({ similarity: 0.5, sharpness: 90, presence: 0.5 });
  assert.equal(mid.label, 'medium');

  const better = componentConfidence({ similarity: 0.8, sharpness: 120, presence: 0.9 });
  const worse = componentConfidence({ similarity: 0.8, sharpness: 120, presence: 0.2 });
  assert.ok(better.score > worse.score);
});

test('aggregate confidence is honest about an empty set', () => {
  assert.deepEqual(aggregateConfidence([]), { count: 0, mean: null, median: null, min: null, max: null });
  const stats = aggregateConfidence([0.2, 0.9, 0.5, 0.5]);
  assert.equal(stats.count, 4);
  assert.ok(Math.abs(stats.mean - 0.525) < 1e-9);
  assert.equal(stats.median, 0.5);
  assert.equal(stats.min, 0.2);
  assert.equal(stats.max, 0.9);
});

test('calibration rewards confidence that matches outcomes', () => {
  const perfect = calibrationReport([
    { confidence: 1, correct: true },
    { confidence: 0, correct: false },
  ]);
  assert.equal(perfect.count, 2);
  assert.equal(perfect.brier, 0);
  assert.equal(perfect.ece, 0);

  const overconfident = calibrationReport(Array.from({ length: 10 }, () => ({ confidence: 0.9, correct: false })));
  assert.ok(Math.abs(overconfident.brier - 0.81) < 1e-9);
  assert.ok(Math.abs(overconfident.ece - 0.9) < 1e-9);

  const empty = calibrationReport([]);
  assert.equal(empty.brier, null);
  assert.equal(empty.ece, null);
});

test('invalid calibration rows are counted, not silently trusted', () => {
  const report = calibrationReport([
    { confidence: 1.5, correct: true },
    { confidence: 0.5, correct: 'yes' },
    { confidence: 0.8, correct: true },
  ]);
  assert.equal(report.count, 1);
  assert.equal(report.invalid, 2);
});

test('accuracy is measured only on labelled samples, with a sample-size warning', () => {
  const small = Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 8 }));
  const report = accuracyReport(small, { confidenceThreshold: 0.5 });
  assert.equal(report.count, 10);
  assert.equal(report.selected, 10);
  assert.equal(report.accuracy, 0.8);
  assert.equal(report.overallAccuracy, 0.8);
  assert.equal(report.trustworthy, false);
  assert.match(report.reason, new RegExp(String(MEASUREMENT_MIN_SAMPLES)));

  const enough = Array.from({ length: 40 }, (_, i) => ({ confidence: 0.8, correct: i < 34 }));
  const trusted = accuracyReport(enough, { confidenceThreshold: 0.5 });
  assert.equal(trusted.trustworthy, true);
  assert.equal(trusted.reason, null);
  assert.equal(trusted.accuracy, 34 / 40);
});

test('the confidence threshold changes coverage and accuracy explicitly', () => {
  const records = [
    { confidence: 0.9, correct: true },
    { confidence: 0.9, correct: true },
    { confidence: 0.2, correct: false },
    { confidence: 0.2, correct: true },
  ];
  const strict = accuracyReport(records, { confidenceThreshold: 0.8 });
  assert.equal(strict.selected, 2);
  assert.equal(strict.coverage, 0.5);
  assert.equal(strict.accuracy, 1);
  assert.equal(strict.overallAccuracy, 0.75);
});

test('no samples means no accuracy claim at all', () => {
  const report = accuracyReport([]);
  assert.equal(report.accuracy, null);
  assert.equal(report.overallAccuracy, null);
  assert.equal(report.coverage, null);
  assert.equal(report.trustworthy, false);
  assert.match(report.reason, /no labelled samples/i);
});

test('an unidentifiable sample set cannot claim 85 percent by construction', () => {
  // The module only returns a number when labelled `correct` values exist.
  const fabricated = accuracyReport([{ confidence: 0.85 }]);
  assert.equal(fabricated.count, 0);
  assert.equal(fabricated.accuracy, null);
  assert.equal(fabricated.invalid, 1);
});
