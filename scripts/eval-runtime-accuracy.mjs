#!/usr/bin/env node
// scripts/eval-runtime-accuracy.mjs — end-to-end measured accuracy of the
// *shipped* recogniser: raw held-out crops -> JavaScript preprocessing ->
// onnxruntime -> top-1 label, compared with the dataset label.
//
// This is the number to quote for recognition accuracy. It never reads a
// provider key and never calls the network.
//
// Usage:
//   node scripts/eval-runtime-accuracy.mjs [--samples datasets/processed/eval_samples] \
//       [--model datasets/processed/cnn_resnet18_v1] [--limit 300] [--min 0.85]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';
import { createOnnxClassifier } from '../perception/learning/OnnxComponentClassifier.js';

const args = { samples: 'datasets/processed/eval_samples', model: 'datasets/processed/cnn_resnet18_v1', limit: 0, min: 0.85 };
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token === '--samples') args.samples = process.argv[++i];
  else if (token === '--model') args.model = process.argv[++i];
  else if (token === '--limit') args.limit = Number(process.argv[++i]);
  else if (token === '--min') args.min = Number(process.argv[++i]);
  else throw new Error(`Unknown argument: ${token}`);
}

const sampleDir = args.samples;
const modelDir = args.model;
const metaPath = path.join(modelDir, 'classifier.json');
const modelPath = path.join(modelDir, 'component_classifier.onnx');
for (const file of [metaPath, modelPath, path.join(sampleDir, 'samples.json'), path.join(sampleDir, 'crops.rgba')]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run scripts/train_cnn_classifier.py + export_classifier_onnx.py + export_test_crops.py first.`);
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
let correct = 0;
const perClass = new Map();
const confusion = [];
const started = Date.now();
for (const sample of samples) {
  const bytes = sample.width * sample.height * 4;
  const offset = offsets.get(sample.index) || 0;
  const data = new Uint8ClampedArray(crops.buffer, crops.byteOffset + offset, bytes);
  const imageData = { data, width: sample.width, height: sample.height };
  const result = await classifier.classify(imageData, { x: 0, y: 0, width: 1, height: 1 }, { topK: 3 });
  const ok = result.label === sample.className;
  if (ok) correct += 1;
  else confusion.push({ expected: sample.className, predicted: result.label, confidence: Number(result.confidence.toFixed(3)) });
  const stats = perClass.get(sample.className) || { support: 0, correct: 0 };
  stats.support += 1;
  if (ok) stats.correct += 1;
  perClass.set(sample.className, stats);
}
const accuracy = correct / samples.length;
const elapsedMs = Date.now() - started;
const report = {
  measured: {
    accuracy,
    correct,
    samples: samples.length,
    trustworthy: samples.length >= 30,
    minRequired: args.min,
    passed: accuracy >= args.min,
    elapsedMs,
    msPerCrop: Number((elapsedMs / samples.length).toFixed(1)),
  },
  model: { dir: modelDir, backbone: meta.backbone, featureVersion: meta.featureVersion, classes: meta.classCount },
  dataset: sampleMeta.dataset,
  trainingAccuracy: meta.measured,
  perClass: Object.fromEntries([...perClass.entries()].map(([name, stats]) => [name, {
    support: stats.support,
    correct: stats.correct,
    recall: stats.correct / stats.support,
  }])),
  errors: confusion.slice(0, 40),
};
const out = path.join('datasets', 'processed', 'runtime_accuracy.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`runtime accuracy: ${(accuracy * 100).toFixed(2)}% (${correct}/${samples.length}) in ${elapsedMs}ms`);
console.log(`training (frozen, sklearn) accuracy: ${(meta.measured.testAccuracy * 100).toFixed(2)}% on ${meta.measured.testSamples} samples`);
console.log(`wrote ${out}`);
if (accuracy < args.min) {
  console.error(`FAIL: runtime accuracy ${(accuracy * 100).toFixed(2)}% is below the ${(args.min * 100).toFixed(0)}% gate.`);
  process.exit(1);
}
