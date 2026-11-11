// perception/learning/KnnLab.js — configurable k-NN plus honest measurement.
//
// The runtime KNNClassifier is intentionally simple. This module is the place to
// try the changes that actually move accuracy, and to measure them without
// fooling yourself:
//
//   - class-balanced voting, so a class with 200 references does not drown one
//     with 20,
//   - optional local distance scaling (Zelnik-Manor & Perona style), so a dense
//     cluster and a sparse cluster are compared on their own scale,
//   - a margin-based rejection rule that prefers "unknown" to a confident wrong
//     answer,
//   - calibration on VALIDATION only, then one TEST evaluation.
//
// It never reports accuracy from unlabelled data: empty input yields null, and a
// sample below MEASUREMENT_MIN_SAMPLES is flagged untrustworthy.

import { MEASUREMENT_MIN_SAMPLES } from '../pcb/gridConfidence.js';

export const DEFAULT_KNN_GRID = {
  k: [1, 3, 5, 7],
  maxDist: [Infinity, 80, 100, 120, 150],
  separation: [1.0, 1.1, 1.25, 1.5],
  weighted: [true],
  classBalanced: [false, true],
  localScaling: [false, true],
  localScaleK: 7,
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function assertDataset(vectors, labels) {
  if (!Array.isArray(vectors) || !Array.isArray(labels)) {
    throw new TypeError('vectors and labels must be arrays');
  }
  if (vectors.length !== labels.length) {
    throw new Error(`vectors (${vectors.length}) and labels (${labels.length}) must be the same length`);
  }
  if (!vectors.length) throw new Error('the dataset is empty');
}

/** Distance to the k-th nearest other vector, used as a local scale. */
function kthNearestDistance(vectors, index, k, distance) {
  if (vectors.length <= 1) return 1;
  const keep = Math.max(1, Math.min(k | 0, vectors.length - 1));
  const best = [];
  for (let other = 0; other < vectors.length; other += 1) {
    if (other === index) continue;
    const d = distance(vectors[index], vectors[other]);
    if (best.length < keep) {
      best.push(d);
      best.sort((a, b) => a - b);
    } else if (d < best[best.length - 1]) {
      best[best.length - 1] = d;
      best.sort((a, b) => a - b);
    }
  }
  return best.length ? best[best.length - 1] : 1;
}

/**
 * Precompute class counts and local scales once per reference set.
 * `sigmas[i]` is the distance from reference i to its localScaleK-th neighbour.
 */
export function prepareReferences(vectors, labels, {
  localScaling = false,
  localScaleK = 7,
  distance,
} = {}) {
  assertDataset(vectors, labels);
  const dist = distance || ((a, b) => {
    if (a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  });
  const classCounts = {};
  for (const label of labels) classCounts[String(label)] = (classCounts[String(label)] || 0) + 1;
  const sigmas = localScaling
    ? vectors.map((_, index) => kthNearestDistance(vectors, index, localScaleK, dist))
    : null;
  return { vectors, labels: labels.map(String), classCounts, sigmas, localScaling, localScaleK, distance: dist };
}

function querySigmaFromDistances(distances, localScaleK) {
  if (!distances.length) return 1;
  const values = Array.from(distances).sort((a, b) => a - b);
  const index = Math.max(0, Math.min(values.length - 1, (localScaleK | 0) - 1));
  return values[index] || 1;
}

function effective(distance, sigmaQuery, sigmaReference) {
  const scale = Math.sqrt(Math.max(sigmaQuery * sigmaReference, 1e-12));
  return distance / scale;
}

/**
 * Compute every query-to-reference distance once.
 *
 * Calibration sweeps hundreds of k / threshold / voting combinations over the
 * same validation vectors. Recomputing 2,027-dimensional distances for every
 * combination is the dominant cost; this matrix is reused instead. Two matrices
 * exist at most (plain and locally-scaled), and each row is a Float64Array.
 */
export function buildDistanceMatrix(queries, prepared, { localScaleK = 7 } = {}) {
  if (!prepared?.vectors?.length) throw new Error('prepared references are required');
  const rows = [];
  const querySigmas = [];
  for (const query of queries) {
    const row = new Float64Array(prepared.vectors.length);
    for (let index = 0; index < prepared.vectors.length; index += 1) {
      row[index] = prepared.distance(query, prepared.vectors[index]);
    }
    rows.push(row);
    querySigmas.push(prepared.localScaling ? querySigmaFromDistances(row, localScaleK) : 1);
  }
  return { rows, querySigmas };
}

/**
 * Classify from a precomputed raw distance row. This is the single decision
 * path: `classify` builds one row and delegates here, so calibration and
 * production cannot drift apart.
 */
export function classifyFromDistances(rawDistances, prepared, {
  k = 3,
  maxDist = Infinity,
  separation = 1.0,
  weighted = true,
  classBalanced = false,
  localScaling = false,
  localScaleK = 7,
} = {}, sigmaQuery = 1) {
  if (!prepared || !prepared.vectors?.length) {
    return { label: 'unknown', accepted: false, reason: 'no_references', nearestDist: null, margin: 0, confidence: 0, neighbors: [], votes: {} };
  }
  const neighbourCount = Math.max(1, Math.min(k | 0, prepared.vectors.length));
  const scale = localScaling ? sigmaQuery || querySigmaFromDistances(rawDistances, localScaleK) : 1;
  const top = [];

  for (let index = 0; index < prepared.vectors.length; index += 1) {
    const raw = rawDistances[index];
    const sigmaReference = localScaling ? (prepared.sigmas?.[index] || 1) : 1;
    const adjusted = localScaling ? effective(raw, scale, sigmaReference) : raw;
    const entry = { index, raw, adjusted, label: prepared.labels[index] };
    if (top.length < neighbourCount) {
      top.push(entry);
      top.sort((a, b) => a.adjusted - b.adjusted);
    } else if (adjusted < top[top.length - 1].adjusted) {
      top[top.length - 1] = entry;
      top.sort((a, b) => a.adjusted - b.adjusted);
    }
  }

  const votes = {};
  for (const entry of top) {
    let weight = weighted ? 1 / (entry.adjusted + 1e-6) : 1;
    if (classBalanced) weight /= Math.max(1, prepared.classCounts[entry.label] || 1);
    votes[entry.label] = (votes[entry.label] || 0) + weight;
  }
  const sortedVotes = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const bestLabel = sortedVotes[0]?.[0] ?? 'unknown';
  const bestScore = sortedVotes[0]?.[1] ?? 0;
  const secondScore = sortedVotes[1]?.[1] ?? 0;
  const nearestDist = top[0]?.adjusted ?? null;
  const margin = bestScore + secondScore > 0 ? (bestScore - secondScore) / (bestScore + secondScore) : 0;

  let accepted = true;
  let reason = 'ok';
  if (nearestDist != null && nearestDist > maxDist) {
    accepted = false;
    reason = 'too_far';
  } else if (separation > 1 && secondScore > 0 && bestScore / (secondScore + 1e-6) < separation) {
    accepted = false;
    reason = 'ambiguous';
  }

  return {
    label: accepted ? bestLabel : 'unknown',
    candidateLabel: bestLabel,
    accepted,
    reason,
    nearestDist,
    rawNearestDist: top[0]?.raw ?? null,
    margin: clamp01(margin),
    confidence: clamp01(margin),
    neighbors: top.map((entry) => ({ label: entry.label, dist: entry.adjusted, rawDist: entry.raw })),
    votes,
  };
}

/**
 * Classify one vector. `prepared` comes from prepareReferences.
 *
 * `nearestDist` is in effective units (raw units when localScaling is off), so a
 * maxDist grid tuned on validation is applied consistently.
 */
export function classify(query, prepared, config = {}) {
  if (!prepared || !prepared.vectors?.length) {
    return { label: 'unknown', accepted: false, reason: 'no_references', nearestDist: null, margin: 0, confidence: 0, neighbors: [], votes: {} };
  }
  const raw = new Float64Array(prepared.vectors.length);
  for (let index = 0; index < prepared.vectors.length; index += 1) {
    raw[index] = prepared.distance(query, prepared.vectors[index]);
  }
  const sigmaQuery = config.localScaling ? querySigmaFromDistances(raw, config.localScaleK ?? 7) : 1;
  return classifyFromDistances(raw, prepared, config, sigmaQuery);
}

function normalizePrediction(prediction) {
  if (prediction && typeof prediction === 'object') {
    const label = String(prediction.label ?? 'unknown');
    return { label, accepted: prediction.accepted !== false && label !== 'unknown' };
  }
  const label = String(prediction ?? 'unknown');
  return { label, accepted: label !== 'unknown' };
}

/**
 * Classification metrics with explicit unknown handling.
 *
 * - overallAccuracy counts an unknown as wrong.
 * - acceptedAccuracy and coverage describe only answered predictions.
 * - Macro averages are over classes present in the truth labels.
 */
export function classificationMetrics(truth = [], predictions = [], { minSamples = MEASUREMENT_MIN_SAMPLES } = {}) {
  if (truth.length !== predictions.length) {
    throw new Error('truth and predictions must be the same length');
  }
  const count = truth.length;
  if (!count) {
    return {
      count: 0,
      minSamples,
      trustworthy: false,
      accepted: 0,
      correct: 0,
      coverage: null,
      unknownRate: null,
      acceptedAccuracy: null,
      overallAccuracy: null,
      macroPrecision: null,
      macroRecall: null,
      macroF1: null,
      perClass: {},
      reason: 'no labelled samples',
    };
  }

  const normalized = predictions.map(normalizePrediction);
  const classes = [...new Set(truth.map(String))].sort();
  let correct = 0;
  let accepted = 0;
  let correctAccepted = 0;
  const perClass = Object.fromEntries(classes.map((label) => [
    label,
    { support: 0, tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null },
  ]));

  for (let i = 0; i < count; i += 1) {
    const expected = String(truth[i]);
    const { label, accepted: answered } = normalized[i];
    if (perClass[expected]) perClass[expected].support += 1;
    if (label === expected) {
      correct += 1;
      if (perClass[expected]) perClass[expected].tp += 1;
    } else if (answered) {
      if (perClass[expected]) perClass[expected].fn += 1;
      if (perClass[label]) perClass[label].fp += 1;
    } else if (perClass[expected]) {
      perClass[expected].fn += 1;
    }
    if (answered) {
      accepted += 1;
      if (label === expected) correctAccepted += 1;
    }
  }

  const f1Values = [];
  const precisionValues = [];
  const recallValues = [];
  for (const label of classes) {
    const row = perClass[label];
    row.precision = row.tp + row.fp > 0 ? row.tp / (row.tp + row.fp) : 0;
    row.recall = row.tp + row.fn > 0 ? row.tp / (row.tp + row.fn) : 0;
    row.f1 = row.precision + row.recall > 0
      ? (2 * row.precision * row.recall) / (row.precision + row.recall)
      : 0;
    precisionValues.push(row.precision);
    recallValues.push(row.recall);
    f1Values.push(row.f1);
  }

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    count,
    minSamples,
    trustworthy: count >= minSamples,
    reason: count >= minSamples ? null : `${count} labelled samples is below the ${minSamples} needed to quote an accuracy figure`,
    accepted,
    correct,
    coverage: accepted / count,
    unknownRate: (count - accepted) / count,
    acceptedAccuracy: accepted ? correctAccepted / accepted : null,
    overallAccuracy: correct / count,
    macroPrecision: mean(precisionValues),
    macroRecall: mean(recallValues),
    macroF1: mean(f1Values),
    perClass,
  };
}

export function predictAll(vectors, prepared, config = {}) {
  return vectors.map((vector) => classify(vector, prepared, config));
}

export function evaluateSplit({ references, vectors, labels, config = {} }) {
  const prepared = references.sigmas !== undefined
    ? references
    : prepareReferences(references.vectors, references.labels, {
      localScaling: config.localScaling === true,
      localScaleK: config.localScaleK,
    });
  return classificationMetrics(labels, predictAll(vectors, prepared, config));
}

function configKey(config) {
  return [
    config.k, config.maxDist, config.separation,
    config.weighted ? 1 : 0, config.classBalanced ? 1 : 0,
    config.localScaling ? 1 : 0, config.localScaleK,
  ].join(':');
}

/**
 * Sweep candidate configurations on the validation split only.
 *
 * Selection rule: among configurations that reach `minCoverage`, take the
 * highest accepted accuracy (then macro F1, then coverage). If none reaches the
 * coverage floor, take the highest overall accuracy and say so with
 * `metCoverage: false`. Test data is never passed to this function.
 */
export function calibrateOperatingPoint({
  references,
  validVectors,
  validLabels,
  grid = DEFAULT_KNN_GRID,
  minCoverage = 0.5,
} = {}) {
  if (!validVectors?.length) throw new Error('validation vectors are required');
  if (validVectors.length !== validLabels.length) throw new Error('validation vectors and labels must match');

  const preparedCache = new Map();
  const matrixCache = new Map();
  const localScaleK = grid.localScaleK ?? 7;
  const preparedFor = (localScaling) => {
    const key = localScaling ? 'scaled' : 'plain';
    if (!preparedCache.has(key)) {
      preparedCache.set(key, references.sigmas !== undefined
        ? references
        : prepareReferences(references.vectors, references.labels, {
          localScaling,
          localScaleK,
        }));
    }
    return preparedCache.get(key);
  };
  // Distance rows depend on the query and the reference set, not on k or a
  // threshold, so each scaling mode is built once for the whole sweep.
  const matrixFor = (localScaling) => {
    const key = localScaling ? 'scaled' : 'plain';
    if (!matrixCache.has(key)) {
      matrixCache.set(key, buildDistanceMatrix(validVectors, preparedFor(localScaling), { localScaleK }));
    }
    return matrixCache.get(key);
  };

  const configs = [];
  for (const k of grid.k) {
    for (const maxDist of grid.maxDist) {
      for (const separation of grid.separation) {
        for (const weighted of grid.weighted) {
          for (const classBalanced of grid.classBalanced) {
            for (const localScaling of grid.localScaling) {
              configs.push({ k, maxDist, separation, weighted, classBalanced, localScaling, localScaleK });
            }
          }
        }
      }
    }
  }

  let best = null;
  let metCoverage = false;
  const tried = [];
  for (const config of configs) {
    const prepared = preparedFor(config.localScaling);
    const matrix = matrixFor(config.localScaling);
    const predictions = matrix.rows.map((row, index) => (
      classifyFromDistances(row, prepared, config, matrix.querySigmas[index])
    ));
    const metrics = classificationMetrics(validLabels, predictions);
    const reachesCoverage = (metrics.coverage ?? 0) >= minCoverage;
    const entry = { config, metrics, reachesCoverage };
    tried.push(entry);

    const score = (candidate) => {
      const m = candidate.metrics;
      if (candidate.reachesCoverage) {
        return [1, m.acceptedAccuracy ?? -1, m.macroF1 ?? -1, m.coverage ?? -1];
      }
      return [0, m.overallAccuracy ?? -1, m.macroF1 ?? -1, m.coverage ?? -1];
    };
    if (!best || compareScores(score(entry), score(best)) > 0) {
      best = entry;
      metCoverage = reachesCoverage;
    }
  }

  return {
    config: best.config,
    metrics: best.metrics,
    metCoverage,
    minCoverage,
    tried: tried.length,
    // Keep the records so a caller can plot the coverage/accuracy trade-off.
    results: tried,
  };
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? -Infinity;
    const right = b[i] ?? -Infinity;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/** One-shot evaluation of a frozen configuration on the test split. */
export function evaluateFrozen({ references, vectors, labels, config }) {
  return evaluateSplit({ references, vectors, labels, config });
}

/** Confidence/correct records for calibrationReport. */
export function toCalibrationRecords(truth = [], predictions = []) {
  return predictions.map((prediction, index) => {
    const normalized = normalizePrediction(prediction);
    return {
      // A rejected prediction must not carry the margin of its best candidate:
      // that would look like a confident wrong answer.
      confidence: normalized.accepted ? clamp01(prediction?.confidence ?? prediction?.margin ?? 0) : 0,
      correct: normalized.label === String(truth[index]) && normalized.accepted ? 1 : 0,
    };
  });
}

export default {
  DEFAULT_KNN_GRID,
  prepareReferences,
  buildDistanceMatrix,
  classify,
  classifyFromDistances,
  classificationMetrics,
  calibrateOperatingPoint,
  evaluateFrozen,
  toCalibrationRecords,
};
