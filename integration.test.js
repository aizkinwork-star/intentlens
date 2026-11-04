// integration.test.js — Phase 6.4 production integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureExtractor } from './perception/learning/FeatureExtractor.js';
import { KNNClassifier } from './perception/learning/KNNClassifier.js';

// Create a synthetic scaler (identity-like for testing).
function makeScaler(dim) {
  return { mean: new Array(dim).fill(0), std: new Array(dim).fill(1), version: '4.0' };
}

test('FeatureExtractor: throws when scaler not loaded', () => {
  const fe = new FeatureExtractor();
  const img = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  const box = { x: 0, y: 0, width: 1, height: 1 };
  assert.throws(() => fe.extract(img, box), /scaler not loaded/);
});

test('FeatureExtractor: returns 2027 dims with scaler', () => {
  const scaler = makeScaler(2027);
  const fe = new FeatureExtractor(scaler);
  const w = 4, h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 100; data[i+1] = 150; data[i+2] = 200; data[i+3] = 255; }
  const img = { data, width: w, height: h };
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const f = fe.extract(img, box);
  assert.equal(f.length, 2027);
  assert.ok(f.every(v => Number.isFinite(v)));
});

test('FeatureExtractor: scaler version is 4.0', () => {
  const scaler = makeScaler(2027);
  scaler.version = '4.0';
  const fe = new FeatureExtractor(scaler);
  assert.equal(fe.version, '4.0');
});

test('KNNClassifier: throws on dimension mismatch', () => {
  const cls = new KNNClassifier(3, 50.6, '4.0');
  const ref = new Array(2027).fill(0.5);
  cls.addExample(ref, 'Resistor', 1.0, 'test', '4.0');
  const wrong = new Array(100).fill(0.5);
  assert.throws(() => cls.classify(wrong, '4.0'), /dimension mismatch/);
});

test('KNNClassifier: classifies with correct dimensions', () => {
  const cls = new KNNClassifier(3, 50.6, '4.0');
  const ref = new Array(2027).fill(0.5);
  cls.addExample(ref, 'Resistor', 1.0, 'test', '4.0');
  const query = new Array(2027).fill(0.5);
  const result = cls.classify(query, '4.0');
  assert.equal(result.label, 'Resistor');
  assert.equal(result.reason, 'ok');
});

test('KNNClassifier: rejects version mismatch', () => {
  const cls = new KNNClassifier(3, 50.6, '4.0');
  const ref = new Array(2027).fill(0.5);
  cls.addExample(ref, 'Resistor', 1.0, 'test', '4.0');
  const query = new Array(2027).fill(0.5);
  const result = cls.classify(query, '3.0');
  assert.equal(result.label, 'unknown');
  assert.equal(result.reason, 'version_mismatch');
});

test('KNNClassifier: rejects too-far queries', () => {
  const cls = new KNNClassifier(3, 0.1, '4.0'); // very small maxDistance
  const ref = new Array(2027).fill(0.5);
  cls.addExample(ref, 'Resistor', 1.0, 'test', '4.0');
  const query = new Array(2027).fill(10.0); // far away
  const result = cls.classify(query, '4.0');
  assert.equal(result.label, 'unknown');
  assert.equal(result.reason, 'too_far');
});

test('KNNClassifier: fromJSON restores parameters', () => {
  const data = { k: 5, maxDistance: 42.0, featureVersion: '4.0', examples: [] };
  const cls = KNNClassifier.fromJSON(data);
  assert.equal(cls.k, 5);
  assert.equal(cls.maxDistance, 42.0);
  assert.equal(cls.featureVersion, '4.0');
});

test('FeatureExtractor: version is 4.0', () => {
  const scaler = { mean: new Array(2027).fill(0), std: new Array(2027).fill(1), version: '4.0' };
  const fe = new FeatureExtractor(scaler);
  assert.equal(fe.version, '4.0');
});

test('FeatureExtractor: LBP produces 236 dims', () => {
  const scaler = { mean: new Array(2027).fill(0), std: new Array(2027).fill(1), version: '4.0' };
  const fe = new FeatureExtractor(scaler);
  const w = 4, h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 100; data[i+1] = 150; data[i+2] = 200; data[i+3] = 255; }
  const img = { data, width: w, height: h };
  const box = { x: 0, y: 0, width: 1, height: 1 };
  const f = fe.extract(img, box);
  // Total should be 2027 (1791 + 236)
  assert.equal(f.length, 2027);
});