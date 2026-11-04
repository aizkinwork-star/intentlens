// Regression: the generated Float32 reference index (not the legacy JSON) is a
// complete k-NN database on its own. Before this guard, validateReady() only
// accepted user-added examples and rejected the shipped index.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LooseObjectTracker } from './looseObjectTracker.js';
import { isPlaceholderCredential } from './server/config.js';

test('compact reference index alone satisfies validateReady', () => {
  const tracker = new LooseObjectTracker();
  tracker.scalerLoaded = true;
  tracker.scaler = { mean: [], std: [] };
  tracker.refDbLoaded = true;
  tracker.classifier.setCompactReferences({
    vectors: new Float32Array(2027),
    labels: new Uint16Array([0]),
    classNames: ['resistor'],
    dim: 2027,
    featureVersion: '4.0',
  });

  assert.equal(tracker.classifier.referenceCount, 1);
  assert.equal(tracker.validateReady(), true);
});

test('an empty tracker is still rejected', () => {
  const tracker = new LooseObjectTracker();
  tracker.scalerLoaded = true;
  tracker.scaler = { mean: [], std: [] };
  tracker.refDbLoaded = true;
  assert.throws(() => tracker.validateReady(), /empty/);
});

test('placeholder credentials are never treated as configured keys', () => {
  assert.equal(isPlaceholderCredential('your_cloudflare_account_id'), true);
  assert.equal(isPlaceholderCredential('nvapi-your-key-here'), true);
  assert.equal(isPlaceholderCredential('<paste key>'), true);
  assert.equal(isPlaceholderCredential(''), true);
  assert.equal(isPlaceholderCredential('nvapi-abcdefghijklmnopqrstuvwxyz0123456789'), false);
});
