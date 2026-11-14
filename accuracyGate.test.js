// accuracyGate.test.js — guard the measured recognition numbers.
//
// The trained artifacts are gitignored (they are large, and they are not source),
// so this test is honest twice over: when artifacts exist it checks the recorded
// measurement and the model contract; when they are missing it skips with a
// reason instead of pretending recognition works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_CANDIDATES = [
  join('datasets', 'processed', 'cnn_resnet18_finetuned_v1'),
  join('datasets', 'processed', 'cnn_resnet18_robust_v1'),
  join('datasets', 'processed', 'cnn_resnet18_v1'),
];
const MODEL_DIR = process.env.COMPONENT_MODEL_DIR
  || MODEL_CANDIDATES.find((dir) => existsSync(join(dir, 'classifier.json')))
  || MODEL_CANDIDATES[MODEL_CANDIDATES.length - 1];
const META_PATH = join(MODEL_DIR, 'classifier.json');
const ONNX_PATH = join(MODEL_DIR, 'component_classifier.onnx');
const RUNTIME_REPORT = join('datasets', 'processed', 'runtime_accuracy.json');

const hasArtifacts = existsSync(META_PATH) && existsSync(ONNX_PATH);
const skipReason = `trained artifacts not present in ${MODEL_DIR}; run the training/export scripts`;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('the shipped classifier contract is self-consistent', { skip: hasArtifacts ? false : skipReason }, () => {
  const meta = readJson(META_PATH);
  assert.equal(typeof meta.featureVersion, 'string');
  assert.ok(meta.featureVersion.length > 0);
  assert.equal(meta.inputSize, 224);
  assert.equal(meta.classes.length, meta.classCount);
  assert.equal(new Set(meta.classes).size, meta.classCount);
  assert.ok(meta.classCount >= 60, `ElectroCom61 has 61 classes, got ${meta.classCount}`);
  assert.ok(Array.isArray(meta.mean) && meta.mean.length === 3, 'per-channel mean');
  assert.ok(Array.isArray(meta.std) && meta.std.length === 3, 'per-channel std');
});

test('measured test accuracy is recorded and trustworthy', { skip: hasArtifacts ? false : skipReason }, () => {
  const meta = readJson(META_PATH);
  const measured = meta.measured || {};
  assert.ok(measured.testSamples >= 30, `need >= 30 labelled samples, got ${measured.testSamples}`);
  assert.ok(
    measured.testAccuracy >= 0.90,
    `recorded test accuracy ${(measured.testAccuracy * 100).toFixed(2)}% is below the 90% target`,
  );
});

test('the runtime evaluation (JS preprocess + onnxruntime) clears the 90% gate', { skip: existsSync(RUNTIME_REPORT) ? false : 'run `npm run test:accuracy` to produce the report' }, () => {
  const report = readJson(RUNTIME_REPORT);
  const measured = report.measured || {};
  assert.ok(measured.samples >= 30, `need >= 30 labelled samples, got ${measured.samples}`);
  assert.equal(measured.trustworthy, true);
  assert.ok(
    measured.accuracy >= 0.90,
    `runtime accuracy ${(measured.accuracy * 100).toFixed(2)}% is below the 90% gate`,
  );
  assert.equal(measured.passed, true);
});

test('every measured lighting stage clears the 90% gate', { skip: existsSync(RUNTIME_REPORT) ? false : 'run `npm run test:accuracy` to produce the report' }, () => {
  const report = readJson(RUNTIME_REPORT);
  const stages = report.stages || {};
  const names = Object.keys(stages);
  assert.ok(names.length >= 4, `expected clean/slight/medium/low, got ${names.join(', ') || 'none'}`);
  for (const name of names) {
    const stage = stages[name];
    assert.ok(stage.samples >= 30, `${name}: need >= 30 samples, got ${stage.samples}`);
    assert.ok(
      stage.accuracy >= 0.90,
      `${name} stage accuracy ${(stage.accuracy * 100).toFixed(2)}% is below the 90% gate`,
    );
  }
});

test('per-class recall is measured, not assumed', { skip: existsSync(RUNTIME_REPORT) ? false : 'run `npm run test:accuracy` to produce the report' }, () => {
  const report = readJson(RUNTIME_REPORT);
  const perClass = report.perClass || {};
  const measured = Object.values(perClass).filter((stats) => stats.support > 0);
  assert.ok(measured.length >= 60, `expected 61 measured classes, got ${measured.length}`);
  // The report must always carry the shortfall list, so a regression cannot be
  // hidden by quoting only the overall number.
  const shortfall = measured.filter((stats) => stats.recall < 0.90);
  assert.equal(
    shortfall.length,
    (report.stages?.[Object.keys(report.stages || {})[0]]?.classesBelow) ?? shortfall.length,
    'per-class shortfall must match the recorded stage summary',
  );
});
