#!/usr/bin/env node
// scripts/eval-accuracy.mjs — reproducible reference selection + honest accuracy.
//
// Pipeline:
//   1. Read labelled feature JSONL rows. Train never touches validation or test.
//   2. Select references from TRAIN with deterministic k-medoids.
//   3. Sweep k / maxDist / separation / voting on VALIDATION only.
//   4. Freeze the winning configuration and evaluate TEST exactly once.
//
// It refuses to quote a number without labelled held-out data, and every metric
// carries the shared MEASUREMENT_MIN_SAMPLES trust flag. It never reads a model
// key or calls a network provider.
//
// Usage:
//   node scripts/eval-accuracy.mjs --train train.jsonl --valid valid.jsonl --test test.jsonl
//   node scripts/eval-accuracy.mjs --features all.jsonl --out datasets/processed/accuracy.json
//
// A single --features file must contain a `split` field with train / valid / test.

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import {
  buildDistanceMatrix,
  calibrateOperatingPoint,
  classifyFromDistances,
  classificationMetrics,
  prepareReferences,
} from '../perception/learning/KnnLab.js';
import { selectMedoids, buildReferenceSet } from '../perception/learning/ReferenceSelector.js';

const HELP = `Usage:
  node scripts/eval-accuracy.mjs --train <jsonl> --valid <jsonl> --test <jsonl> [options]
  node scripts/eval-accuracy.mjs --features <jsonl-with-split-field> [options]

Options:
  --per-class <n>      References kept per class (default 5)
  --seed <n>           Deterministic medoid seed (default 1)
  --min-coverage <x>   Validation coverage floor for calibration (default 0.5)
  --max-valid <n>      Use the first n validation rows (default: all)
  --out <file>         Write the JSON report here
  --grid <name>        default | compact (default: default)
  --help               Show this text

Fields per line: "features" plus "className" (or class_name / label) and,
for a single file, "split".`;

function parseArgs(argv) {
  const args = { perClass: 5, seed: 1, minCoverage: 0.5, maxValid: 0, grid: 'default' };
  const takesValue = new Set(['train', 'valid', 'test', 'features', 'per-class', 'seed', 'min-coverage', 'max-valid', 'out', 'grid']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!takesValue.has(name)) throw new Error(`Unknown option: ${token}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    i += 1;
    if (name === 'per-class') args.perClass = Number(value);
    else if (name === 'seed') args.seed = Number(value);
    else if (name === 'min-coverage') args.minCoverage = Number(value);
    else if (name === 'max-valid') args.maxValid = Number(value);
    else args[name] = value;
  }
  if (!args.help) {
    if (!args.features && !(args.train && args.valid && args.test)) {
      throw new Error('Provide --train --valid --test, or a single --features file.');
    }
    if (args.features && (args.train || args.valid || args.test)) {
      throw new Error('--features cannot be combined with --train/--valid/--test.');
    }
    if (!Number.isFinite(args.perClass) || args.perClass < 1) throw new Error('--per-class must be >= 1');
    if (!Number.isFinite(args.seed)) throw new Error('--seed must be a number');
    if (!Number.isFinite(args.minCoverage) || args.minCoverage < 0 || args.minCoverage > 1) {
      throw new Error('--min-coverage must be between 0 and 1');
    }
  }
  return args;
}

const GRIDS = {
  default: {
    k: [1, 3, 5],
    maxDist: [50.6, 80, 100, 120, 150, Infinity],
    separation: [1.0, 1.25, 1.5],
    weighted: [true],
    classBalanced: [false, true],
    localScaling: [false, true],
    localScaleK: 7,
  },
  compact: {
    k: [1, 3, 5, 7],
    maxDist: [45, 50.6, 60, 80, 100],
    separation: [1.0, 1.25, 1.5, 2.0],
    weighted: [true, false],
    classBalanced: [false, true],
    localScaling: [false, true],
    localScaleK: 7,
  },
};

function labelOf(record) {
  return record.className ?? record.class_name ?? record.label ?? record.classId ?? null;
}

function splitOf(record) {
  return String(record.split ?? '').toLowerCase();
}

async function readJsonl(file, forcedSplit = null) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const records = { train: [], valid: [], test: [] };
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let malformed = 0;
  let dim = null;

  for await (const line of reader) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const features = record.features;
    if (!Array.isArray(features) || !features.length) {
      malformed += 1;
      continue;
    }
    if (dim == null) dim = features.length;
    if (features.length !== dim) throw new Error(`${file}:${lineNumber} has ${features.length} features; expected ${dim}`);
    const vector = Float32Array.from(features);
    const label = labelOf(record);
    if (label == null || String(label).trim() === '') {
      malformed += 1;
      continue;
    }
    const split = forcedSplit || normalizeSplit(splitOf(record));
    if (!split) continue;
    records[split].push({ vector, label: String(label) });
  }

  if (malformed) console.error(`${file}: skipped ${malformed} malformed or unlabelled rows.`);
  return { ...records, dim };
}

function normalizeSplit(value) {
  if (value === 'train' || value === 'training') return 'train';
  if (value === 'valid' || value === 'validation' || value === 'val') return 'valid';
  if (value === 'test' || value === 'testing' || value === 'holdout') return 'test';
  return null;
}

function vectorsOf(rows) {
  return rows.map((row) => row.vector);
}

function labelsOf(rows) {
  return rows.map((row) => row.label);
}

function classCounts(labels) {
  const counts = {};
  for (const label of labels) counts[label] = (counts[label] || 0) + 1;
  return counts;
}

function summarizeSplit(name, rows) {
  return { name, samples: rows.length, classes: Object.keys(classCounts(labelsOf(rows))).length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  let trainRows;
  let validRows;
  let testRows;
  let dim;
  if (args.features) {
    const all = await readJsonl(args.features);
    trainRows = all.train;
    validRows = all.valid;
    testRows = all.test;
    dim = all.dim;
  } else {
    const train = await readJsonl(args.train, 'train');
    const valid = await readJsonl(args.valid, 'valid');
    const test = await readJsonl(args.test, 'test');
    trainRows = train.train;
    validRows = valid.valid;
    testRows = test.test;
    dim = train.dim ?? valid.dim ?? test.dim;
    if (train.dim && valid.dim && train.dim !== valid.dim) throw new Error('Train and validation feature dimensions differ.');
    if (train.dim && test.dim && train.dim !== test.dim) throw new Error('Train and test feature dimensions differ.');
  }

  if (!trainRows.length) throw new Error('No train rows with features and labels were found.');
  if (!validRows.length) throw new Error('No validation rows. Calibration without validation would be tuning on test or guessing.');
  if (!testRows.length) throw new Error('No test rows. Refusing to report accuracy without a held-out split.');
  if (args.maxValid > 0) validRows = validRows.slice(0, args.maxValid);

  console.log(`Feature dimension: ${dim}`);
  for (const [name, rows] of [['train', trainRows], ['valid', validRows], ['test', testRows]]) {
    console.log(`${name}: ${rows.length} samples, ${Object.keys(classCounts(labelsOf(rows))).length} classes`);
  }

  const started = Date.now();
  const selection = selectMedoids(vectorsOf(trainRows), labelsOf(trainRows), {
    perClass: args.perClass,
    seed: args.seed,
  });
  const references = buildReferenceSet(vectorsOf(trainRows), labelsOf(trainRows), selection);
  console.log(`Selected ${selection.total} references from train (seed ${args.seed}, ${args.perClass}/class).`);

  const grid = GRIDS[args.grid];
  if (!grid) throw new Error(`Unknown --grid: ${args.grid} (use default or compact)`);

  const result = calibrateOperatingPoint({
    references,
    validVectors: vectorsOf(validRows),
    validLabels: labelsOf(validRows),
    grid,
    minCoverage: args.minCoverage,
  });

  // Frozen: one call, test split only once.
  const testPrepared = prepareReferences(references.vectors, references.labels, {
    localScaling: result.config.localScaling,
    localScaleK: result.config.localScaleK,
  });
  const testMatrix = buildDistanceMatrix(vectorsOf(testRows), testPrepared, { localScaleK: result.config.localScaleK });
  const testPredictions = testMatrix.rows.map((row, index) => (
    classifyFromDistances(row, testPrepared, result.config, testMatrix.querySigmas[index])
  ));
  const testMetrics = classificationMetrics(labelsOf(testRows), testPredictions);

  const report = {
    generatedAt: new Date().toISOString(),
    tool: 'scripts/eval-accuracy.mjs',
    rules: {
      selection: 'deterministic class-stratified k-medoids on train only',
      calibration: 'validation only',
      test: 'single frozen evaluation',
      minimumTrustedSamples: testMetrics.minSamples,
    },
    data: {
      dim,
      train: summarizeSplit('train', trainRows),
      valid: summarizeSplit('valid', validRows),
      test: summarizeSplit('test', testRows),
      classCounts: classCounts(labelsOf(testRows)),
    },
    selection: {
      perClass: selection.perClass,
      seed: selection.seed,
      total: selection.total,
      perClassCounts: selection.perClassCounts,
    },
    calibration: {
      grid: args.grid,
      tried: result.tried,
      metCoverage: result.metCoverage,
      minCoverage: result.minCoverage,
      config: {
        ...result.config,
        // JSON has no Infinity literal; keep the report machine-readable.
        maxDist: Number.isFinite(result.config.maxDist) ? result.config.maxDist : 'Infinity',
      },
      metrics: result.metrics,
    },
    test: testMetrics,
    durationMs: Date.now() - started,
  };

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), `${json}\n`);
    console.log(`Wrote ${path.resolve(args.out)}`);
  } else {
    console.log(json);
  }

  console.log('\nFrozen configuration:', JSON.stringify(result.config));
  if (!testMetrics.trustworthy) {
    console.log(`WARNING: ${testMetrics.reason}. Do not quote this as an accuracy figure.`);
  } else {
    console.log(`Test overall accuracy: ${(testMetrics.overallAccuracy * 100).toFixed(2)}% (${testMetrics.correct}/${testMetrics.count})`);
    console.log(`Test accepted accuracy: ${(testMetrics.acceptedAccuracy * 100).toFixed(2)}% at ${(testMetrics.coverage * 100).toFixed(2)}% coverage`);
  }
}

main().catch((error) => {
  console.error(`eval-accuracy: ${error?.message || error}`);
  process.exitCode = 1;
});
