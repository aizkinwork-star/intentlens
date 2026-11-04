import test from 'node:test';
import assert from 'node:assert/strict';
import { toUnverifiedCandidates, lookupCandidates } from './localReferenceLookup.js';

test('local matcher results are unverified candidates, never probabilities', () => {
  const candidates = toUnverifiedCandidates({
    label: 'resistor',
    reason: 'ok',
    neighbors: [
      { label: 'resistor', dist: 12.5 },
      { label: 'resistor', dist: 14.1 },
      { label: 'capacitor', dist: 20.2 },
    ],
  });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].name, 'resistor');
  assert.equal(candidates[0].distance, 12.5);
  assert.equal(candidates[0].status, 'unverified_candidate');
  assert.equal(candidates[0].scoreKind, 'uncalibrated_distance');
  assert.match(candidates[0].note, /not a probability/i);
  assert.ok(!('probability' in candidates[0]));
  assert.ok(!('confidence' in candidates[0]));
});

test('a matcher rejection still exposes neighbours as unverified context', () => {
  const candidates = toUnverifiedCandidates({
    label: 'unknown',
    reason: 'ambiguous',
    neighbors: [{ label: 'LED', dist: 45.2 }],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'LED');
  assert.equal(candidates[0].status, 'unverified_candidate');
});

test('missing reference index is reported as unavailable, not as a detection', () => {
  const out = lookupCandidates({ tracker: null, imageData: null });
  assert.equal(out.available, false);
  assert.deepEqual(out.candidates, []);
});
