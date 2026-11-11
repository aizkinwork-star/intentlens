// perception/pcb/gridConfidence.js — confidence scoring and honest measurement.
//
// Two separate jobs live here:
//
// 1. Score a geometry hypothesis (a board quad, a component box, a grid snap)
//    so the UI can decide whether to draw it, hedge it, or ask for a closer
//    photo. These are heuristics with documented weights.
//
// 2. Measure detection quality against known ground truth, with precision,
//    recall, IoU matching, Brier score and calibration error. This module never
//    invents an "85% accuracy" number: if there are no labelled samples it
//    returns null, and it flags a sample as too small to trust.
//
// All boxes and points are normalized 0..1. Pure functions only.

export const CONFIDENCE_LABELS = ['low', 'medium', 'high'];
export const MEASUREMENT_MIN_SAMPLES = 30;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** A well-formed normalized box. */
export function isValidBox(box) {
  return Boolean(
    box
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0,
  );
}

export function boxArea(box) {
  return isValidBox(box) ? box.width * box.height : 0;
}

export function boxCenter(box) {
  if (!isValidBox(box)) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function intersectionArea(a, b) {
  if (!isValidBox(a) || !isValidBox(b)) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/** Intersection-over-union for two normalized boxes. */
export function iou(a, b) {
  if (!isValidBox(a) || !isValidBox(b)) return 0;
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? clamp01(inter / union) : 0;
}

/**
 * Greedy one-to-one matching by descending IoU. A prediction may match one
 * ground-truth box only, so duplicates count as false positives instead of
 * inflating recall.
 */
export function matchBoxes(predictions = [], groundTruth = [], { iouThreshold = 0.5 } = {}) {
  const pairs = [];
  for (let p = 0; p < predictions.length; p += 1) {
    for (let g = 0; g < groundTruth.length; g += 1) {
      const overlap = iou(predictions[p], groundTruth[g]);
      if (overlap >= iouThreshold && overlap > 0) pairs.push({ predictionIndex: p, truthIndex: g, iou: overlap });
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);

  const usedPredictions = new Set();
  const usedTruth = new Set();
  const matches = [];
  for (const pair of pairs) {
    if (usedPredictions.has(pair.predictionIndex) || usedTruth.has(pair.truthIndex)) continue;
    usedPredictions.add(pair.predictionIndex);
    usedTruth.add(pair.truthIndex);
    matches.push(pair);
  }

  const unmatchedPredictions = predictions.map((_, i) => i).filter((i) => !usedPredictions.has(i));
  const unmatchedTruth = groundTruth.map((_, i) => i).filter((i) => !usedTruth.has(i));
  return { matches, unmatchedPredictions, unmatchedTruth, iouThreshold };
}

/**
 * Precision/recall/F1 against labelled boxes.
 *
 * `accuracy` is the symmetric match rate 2*match / (predictions + truth).
 * It is a strict measure: duplicates and misses both lower it. When there is
 * nothing to evaluate, it is null rather than a flattering 1.
 */
export function evaluateDetections(predictions = [], groundTruth = [], { iouThreshold = 0.5 } = {}) {
  const result = matchBoxes(predictions, groundTruth, { iouThreshold });
  const matched = result.matches.length;
  const totalPredictions = predictions.length;
  const totalTruth = groundTruth.length;
  const precision = totalPredictions ? matched / totalPredictions : (totalTruth ? 0 : null);
  const recall = totalTruth ? matched / totalTruth : (totalPredictions ? 0 : null);
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : (precision === 0 || recall === 0 ? 0 : null);
  const accuracy = totalPredictions + totalTruth > 0
    ? (2 * matched) / (totalPredictions + totalTruth)
    : null;
  const meanIou = matched
    ? result.matches.reduce((sum, m) => sum + m.iou, 0) / matched
    : 0;

  return {
    ...result,
    matched,
    predictions: totalPredictions,
    truth: totalTruth,
    falsePositives: totalPredictions - matched,
    falseNegatives: totalTruth - matched,
    precision,
    recall,
    f1,
    accuracy,
    meanIou,
  };
}

/** Distance from a point to the nearest grid-cell centre, in cell units. */
export function gridCellResidual(point, gridSize = 64) {
  if (!isPoint(point) || !Number.isFinite(gridSize) || gridSize <= 0) return null;
  const u = Math.max(0, Math.min(1, point.x)) * gridSize;
  const v = Math.max(0, Math.min(1, point.y)) * gridSize;
  const du = Math.abs(u - (Math.floor(u) + 0.5));
  const dv = Math.abs(v - (Math.floor(v) + 0.5));
  return Math.hypot(du, dv) / Math.SQRT1_2; // 0 at centre, 1 at a cell corner
}

/**
 * How consistently a set of points snaps to grid-cell centres, 0..1.
 * Useful for checking that a model respected the grid it was asked to use.
 */
export function gridSnapScore(points = [], { gridSize = 64 } = {}) {
  const residuals = points.map((p) => gridCellResidual(p, gridSize)).filter((r) => r != null);
  if (!residuals.length) return null;
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  return clamp01(1 - mean);
}

/** How close points are to grid lines (cell boundaries), 0..1. */
export function gridLineAlignmentScore(points = [], { gridSize = 64 } = {}) {
  if (!points.length) return null;
  let sum = 0;
  let count = 0;
  for (const point of points) {
    if (!isPoint(point)) continue;
    const u = Math.max(0, Math.min(1, point.x)) * gridSize;
    const v = Math.max(0, Math.min(1, point.y)) * gridSize;
    const du = Math.abs(u - Math.round(u));
    const dv = Math.abs(v - Math.round(v));
    sum += Math.hypot(du, dv) / Math.SQRT1_2; // 0 on a line, ~1 at a cell centre
    count += 1;
  }
  return count ? clamp01(1 - sum / count) : null;
}

/**
 * Geometric sanity of a four-corner board projection. Rejects bow-ties and
 * slivers rather than drawing a confident-looking impossible quad.
 */
export function boardQuadQuality(corners = []) {
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every(isPoint)) {
    return { ok: false, reason: 'need-four-points', score: 0, area: 0 };
  }
  let signedArea = 0;
  let sign = 0;
  let convex = true;
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    signedArea += a.x * b.y - b.x * a.y;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) {
      const next = Math.sign(cross);
      if (sign === 0) sign = next;
      else if (sign !== next) convex = false;
    }
  }
  const area = Math.abs(signedArea) / 2;
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const bboxW = Math.max(...xs) - Math.min(...xs);
  const bboxH = Math.max(...ys) - Math.min(...ys);
  const aspect = bboxW > 0 && bboxH > 0 ? Math.max(bboxW, bboxH) / Math.min(bboxW, bboxH) : 0;
  const areaScore = clamp01(Math.sqrt(area) / 0.6);
  const aspectScore = aspect > 0 ? clamp01(1 - Math.max(0, aspect - 4) / 8) : 0;
  const score = clamp01(0.65 * areaScore + 0.35 * aspectScore) * (convex ? 1 : 0.15);
  return {
    ok: convex && area > 0.005 && aspect > 0,
    reason: convex ? null : 'self-intersecting',
    score,
    area,
    aspect,
    convex,
  };
}

/**
 * Combine independent evidence for one component into a single confidence.
 * Weights are declared so the number can be explained, not just displayed.
 */
export function componentConfidence({
  similarity = 0,
  sharpness = 0,
  presence = 0.5,
  positionError = null,
  iou: overlap = null,
} = {}) {
  const focus = clamp01(sharpness / 180);
  let position = null;
  if (Number.isFinite(overlap)) position = clamp01(overlap);
  else if (Number.isFinite(positionError)) position = clamp01(1 - positionError / 0.25);

  const parts = [
    { key: 'similarity', weight: 0.45, value: clamp01((similarity + 1) / 2) },
    { key: 'focus', weight: 0.2, value: focus },
    { key: 'presence', weight: 0.35, value: clamp01(presence) },
  ];
  if (position != null) parts.push({ key: 'position', weight: 0.1, value: position });

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = totalWeight > 0
    ? parts.reduce((sum, p) => sum + p.weight * p.value, 0) / totalWeight
    : 0;
  const clamped = clamp01(score);
  return {
    score: clamped,
    label: clamped >= 0.75 ? 'high' : clamped >= 0.5 ? 'medium' : 'low',
    parts: Object.fromEntries(parts.map((p) => [p.key, p.value])),
  };
}

/** Mean/median/min/max of component confidences. */
export function aggregateConfidence(scores = []) {
  const values = scores.filter((v) => Number.isFinite(v)).map(clamp01).sort((a, b) => a - b);
  if (!values.length) return { count: 0, mean: null, median: null, min: null, max: null };
  const sum = values.reduce((a, b) => a + b, 0);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return { count: values.length, mean: sum / values.length, median, min: values[0], max: values[values.length - 1] };
}

function normalizeCalibrationRecords(records) {
  const valid = [];
  let invalid = 0;
  for (const record of records || []) {
    const confidence = Number(record?.confidence);
    const correct = record?.correct === true ? 1 : record?.correct === false ? 0 : Number(record?.correct);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !(correct === 0 || correct === 1)) {
      invalid += 1;
      continue;
    }
    valid.push({ confidence, correct });
  }
  return { valid, invalid };
}

/**
 * Brier score and expected calibration error. Lower is better. Brier 0 is
 * perfect; a confident wrong answer costs more than an unsure wrong answer.
 */
export function calibrationReport(records = [], { bins = 10 } = {}) {
  const { valid, invalid } = normalizeCalibrationRecords(records);
  if (!valid.length) return { count: 0, invalid, brier: null, ece: null, bins: [] };

  const bucketCount = Math.max(1, bins | 0);
  const buckets = Array.from({ length: bucketCount }, () => ({ count: 0, confidence: 0, correct: 0 }));
  let brierSum = 0;
  for (const record of valid) {
    brierSum += (record.confidence - record.correct) ** 2;
    const index = Math.min(bucketCount - 1, Math.floor(record.confidence * bucketCount));
    buckets[index].count += 1;
    buckets[index].confidence += record.confidence;
    buckets[index].correct += record.correct;
  }

  let ece = 0;
  const rows = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const bucket = buckets[i];
    if (!bucket.count) continue;
    const avgConfidence = bucket.confidence / bucket.count;
    const accuracy = bucket.correct / bucket.count;
    ece += (bucket.count / valid.length) * Math.abs(avgConfidence - accuracy);
    rows.push({
      from: i / bucketCount,
      to: (i + 1) / bucketCount,
      count: bucket.count,
      avgConfidence,
      accuracy,
    });
  }

  return {
    count: valid.length,
    invalid,
    brier: brierSum / valid.length,
    ece,
    bins: rows,
  };
}

/**
 * Accuracy of *confident* predictions, with coverage and a sample-size warning.
 * `accuracy` is correct/selected at the threshold, and null when nothing clears
 * it. No number is returned for an empty sample.
 */
export function accuracyReport(records = [], { confidenceThreshold = 0.5, minSamples = MEASUREMENT_MIN_SAMPLES } = {}) {
  const { valid, invalid } = normalizeCalibrationRecords(records);
  if (!valid.length) {
    return {
      count: 0,
      invalid,
      threshold: confidenceThreshold,
      selected: 0,
      coverage: null,
      accuracy: null,
      overallAccuracy: null,
      brier: null,
      trustworthy: false,
      reason: 'no labelled samples',
    };
  }
  const selected = valid.filter((r) => r.confidence >= confidenceThreshold);
  const correctSelected = selected.filter((r) => r.correct === 1).length;
  const correctAll = valid.filter((r) => r.correct === 1).length;
  const calibration = calibrationReport(valid);
  return {
    count: valid.length,
    invalid,
    threshold: confidenceThreshold,
    selected: selected.length,
    coverage: selected.length / valid.length,
    accuracy: selected.length ? correctSelected / selected.length : null,
    overallAccuracy: correctAll / valid.length,
    brier: calibration.brier,
    ece: calibration.ece,
    trustworthy: valid.length >= minSamples,
    reason: valid.length >= minSamples
      ? null
      : `${valid.length} labelled samples is below the ${minSamples} needed to quote an accuracy figure`,
  };
}

export default { iou, evaluateDetections, componentConfidence, accuracyReport };
