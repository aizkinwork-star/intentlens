#!/usr/bin/env node
// scripts/eval-runtime-accuracy.mjs — end-to-end measured accuracy of the
// *shipped* recogniser: raw held-out crops -> JavaScript preprocessing ->
// onnxruntime -> top-1 label, compared with the dataset label.
//
// This is the number to quote for recognition accuracy. It never reads a
// provider key and never calls the network.
//
// Lighting robustness is measured by replaying the exact same crops at the
// training opacity stages (fraction of the original pixel value over black):
//   clean 1.0, slight 0.75, medium 0.50, low 0.30
// The stage numbers are the ones the robust model was trained for.
//
// Usage:
//   node scripts/eval-runtime-accuracy.mjs [--samples datasets/processed/eval_samples] \
//       [--model datasets/processed/cnn_resnet18_robust_v1] [--limit 300] \
//       [--min 0.90] [--min-stage 0.90] [--min-class 0.90] [--stages clean,slight,medium,low]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { createOnnxClassifier } from '../perception/learning/OnnxComponentClassifier.js';

export const OPACITY_STAGES = {
  clean: 1.0,
  slight: 0.75,
  medium: 0.5,
  low: 0.3,
};

const MODEL_CANDIDATES = [
  'datasets/processed/cnn_resnet18_finetuned_v1',
  'datasets/processed/cnn_resnet18_robust_v1',
  'datasets/processed/cnn_resnet18_v1',
];
const defaultModelDir = MODEL_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'classifier.json')))
  || MODEL_CANDIDATES[MODEL_CANDIDATES.length - 1];

const args = {
  samples: 'datasets/processed/eval_samples',
  model: defaultModelDir,
  limit: 0,
  min: 0.9,
  minStage: 0.9,
  minClass: 0.9,
  stages: Object.keys(OPACITY_STAGES),
  out: path.join('datasets', 'processed', 'runtime_accuracy.json'),
};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token === '--samples') args.samples = process.argv[++i];
  else if (token === '--model') args.model = process.argv[++i];
  else if (token === '--limit') args.limit = Number(process.argv[++i]);
  else if (token === '--min') args.min = Number(process.argv[++i]);
  else if (token === '--min-stage') args.minStage = Number(process.argv[++i]);
  else if (token === '--min-class') args.minClass = Number(process.argv[++i]);
  else if (token === '--stages') args.stages = String(process.argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  else if (token === '--out') args.out = process.argv[++i];
  else throw new Error(`Unknown argument: ${token}`);
}

for (const stage of args.stages) {
  if (!(stage in OPACITY_STAGES)) throw new Error(`Unknown stage "${stage}". Use: ${Object.keys(OPACITY_STAGES).join(', ')}`);
}

const sampleDir = args.samples;
const modelDir = args.model;
const metaPath = path.join(modelDir, 'classifier.json');
const modelPath = path.join(modelDir, 'component_classifier.onnx');
for (const file of [metaPath, modelPath, path.join(sampleDir, 'samples.json'), path.join(sampleDir, 'crops.rgba')]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run scripts/train_robust_classifier.py + export_classifier_onnx.py + export_test_crops.py first.`);
    process.exit(2);
  }
}

ort.env.wasm.wasmPaths = pathToFileURL(path.resolve('node_modules/onnxruntime-web/dist') + path.sep).href;
ort.env.wasm.numThreads = 1;

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const sampleMeta = JSON.parse(fs.readFileSync(path.join(sampleDir, 'samples.json'), 'utf8'));
const crops = fs.readFileSync(path.join(sampleDir, 'crops.rgba'));
const session = await ort.InferenceSession.create(fs.readFileSync(modelPath), {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
const classifier = createOnnxClassifier({ session, meta, ort });

const samples = args.limit > 0 ? sampleMeta.samples.slice(0, args.limit) : sampleMeta.samples;
// Offsets are sequential in the raw file; precompute once.
let cursor = 0;
const offsets = new Map();
for (const sample of sampleMeta.samples) {
  offsets.set(sample.index, cursor);
  cursor += sample.width * sample.height * 4;
}

/** Copy a crop and dim its RGB channels, matching training's blend toward black. */
function dimCrop(sample, opacity) {
  const bytes = sample.width * sample.height * 4;
  const offset = offsets.get(sample.index) || 0;
  const source = crops.subarray(offset, offset + bytes);
  if (opacity >= 1) return new Uint8ClampedArray(source);
  const data = new Uint8ClampedArray(bytes);
  for (let i = 0; i < bytes; i += 4) {
    data[i] = source[i] * opacity;
    data[i + 1] = source[i + 1] * opacity;
    data[i + 2] = source[i + 2] * opacity;
    data[i + 3] = source[i + 3];
  }
  return data;
}

function emptyStats() {
  return { correct: 0, samples: 0, perClass: new Map(), errors: [] };
}

const stageStats = Object.fromEntries(args.stages.map((stage) => [stage, emptyStats()]));
const started = Date.now();
for (const sample of samples) {
  for (const stage of args.stages) {
    const stats = stageStats[stage];
    const data = dimCrop(sample, OPACITY_STAGES[stage]);
    const imageData = { data, width: sample.width, height: sample.height };
    const result = await classifier.classify(imageData, { x: 0, y: 0, width: 1, height: 1 }, { topK: 3 });
    const ok = result.label === sample.className;
    stats.samples += 1;
    if (ok) stats.correct += 1;
    else if (stats.errors.length < 40) {
      stats.errors.push({ expected: sample.className, predicted: result.label, confidence: Number(result.confidence.toFixed(3)), stage });
    }
    const classStats = stats.perClass.get(sample.className) || { support: 0, correct: 0 };
    classStats.support += 1;
    if (ok) classStats.correct += 1;
    stats.perClass.set(sample.className, classStats);
  }
}
const elapsedMs = Date.now() - started;

const stageReports = {};
for (const stage of args.stages) {
  const stats = stageStats[stage];
  const accuracy = stats.correct / Math.max(1, stats.samples);
  const perClass = Object.fromEntries([...stats.perClass.entries()].map(([name, value]) => [name, {
    support: value.support,
    correct: value.correct,
    recall: value.correct / value.support,
  }]));
  const classesBelow = Object.entries(perClass)
    .filter(([, value]) => value.support > 0 && value.recall < args.minClass)
    .map(([name, value]) => ({ name, recall: value.recall, support: value.support }))
    .sort((a, b) => a.recall - b.recall);
  stageReports[stage] = {
    opacity: OPACITY_STAGES[stage],
    accuracy,
    correct: stats.correct,
    samples: stats.samples,
    passed: accuracy >= args.minStage,
    minClassRecall: Math.min(...Object.values(perClass).filter((v) => v.support > 0).map((v) => v.recall)),
    classesBelow: classesBelow.length,
    classesBelowList: classesBelow,
    perClass,
    errors: stats.errors,
  };
}

const overallPassed = args.stages.every((stage) => stageReports[stage].passed);
const worst = args.stages.reduce((a, b) => (stageReports[a].accuracy <= stageReports[b].accuracy ? a : b));
const report = {
  measured: {
    accuracy: stageReports[args.stages[0]].accuracy,
    correct: stageReports[args.stages[0]].correct,
    samples: samples.length,
    trustworthy: samples.length >= 30,
    minRequired: args.min,
    minStageRequired: args.minStage,
    minClassRequired: args.minClass,
    passed: overallPassed && stageReports[args.stages[0]].accuracy >= args.min,
    worstStage: worst,
    worstStageAccuracy: stageReports[worst].accuracy,
    elapsedMs,
    msPerCrop: Number((elapsedMs / Math.max(1, samples.length * args.stages.length)).toFixed(1)),
  },
  model: { dir: modelDir, backbone: meta.backbone, featureVersion: meta.featureVersion, classes: meta.classCount },
  dataset: sampleMeta.dataset,
  trainingAccuracy: meta.measured,
  stages: stageReports,
  perClass: stageReports[args.stages[0]].perClass,
  errors: stageReports[args.stages[0]].errors,
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(`runtime accuracy per lighting stage (${samples.length} held-out crops):`);
for (const stage of args.stages) {
  const value = stageReports[stage];
  console.log(
    `  ${stage.padEnd(7)} opacity=${value.opacity.toFixed(2)} ` +
    `accuracy=${(value.accuracy * 100).toFixed(2)}% (${value.correct}/${value.samples}) ` +
    `minClass=${(value.minClassRecall * 100).toFixed(1)}% below${(args.minClass * 100).toFixed(0)}=${value.classesBelow}` +
    (value.passed ? '' : '  <-- BELOW STAGE GATE'),
  );
}
console.log(`wrote ${args.out}`);
if (!report.measured.passed) {
  console.error(
    `FAIL: overall=${(stageReports[args.stages[0]].accuracy * 100).toFixed(2)}% ` +
    `gate=${(args.min * 100).toFixed(0)}%, per-stage gate=${(args.minStage * 100).toFixed(0)}%`,
  );
  process.exit(1);
}
