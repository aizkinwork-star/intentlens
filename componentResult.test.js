import test from 'node:test';
import assert from 'node:assert/strict';
import { toComponentResult, validateNormalizedComponentResult } from './componentResult.js';

const validRaw = (overrides = {}) => ({
  component: {
    name: 'LED',
    identity_status: 'ai_candidate',
    evidence: ['small clear dome with two leads'],
    uncertainty: 'medium',
    ...(overrides.component || {}),
  },
  location: overrides.location === undefined ? {
    center: { x: 500, y: 500 },
    corners: [
      { x: 400, y: 400 },
      { x: 600, y: 400 },
      { x: 600, y: 600 },
      { x: 400, y: 600 },
    ],
  } : overrides.location,
  next_action: overrides.next_action || 'instruction',
  instruction: overrides.instruction || 'Check the longer lead before connecting power.',
});

test('converts 0..1000 model coordinates to normalized 0..1 and derives the grid cell', () => {
  const out = toComponentResult(validRaw(), { gridSize: 64 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.result.location.center, { x: 0.5, y: 0.5 });
  assert.equal(out.result.location.grid_cell, 'R33C33');
  assert.equal(out.result.component.identity_status, 'ai_candidate');
});

test('rejects a coordinate outside the model grid instead of clamping it', () => {
  const raw = validRaw({ location: { center: { x: 1200, y: 500 }, corners: [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }, { x: 400, y: 600 }] } });
  const out = toComponentResult(raw, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /between 0 and 1000/i);
});

test('rejects fewer than four corners', () => {
  const raw = validRaw({ location: { center: { x: 500, y: 500 }, corners: [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }] } });
  const out = toComponentResult(raw, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /exactly four/i);
});

test('rejects a center outside the corner outline', () => {
  const raw = validRaw({ location: { center: { x: 900, y: 900 }, corners: [{ x: 400, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 600 }, { x: 400, y: 600 }] } });
  const out = toComponentResult(raw, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /outside the corner outline/i);
});

test('rejects a self-crossing bow-tie corner order', () => {
  const raw = validRaw({ location: { center: { x: 500, y: 500 }, corners: [{ x: 400, y: 400 }, { x: 600, y: 600 }, { x: 600, y: 400 }, { x: 400, y: 600 }] } });
  const out = toComponentResult(raw, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /consistent/i);
});

test('the model cannot mark its own identification as user-confirmed', () => {
  const raw = validRaw({ component: { identity_status: 'confirmed_by_user' } });
  const out = toComponentResult(raw, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /user-confirmed/i);
});

test('a null location is allowed when the model cannot locate the part', () => {
  const out = toComponentResult(validRaw({ location: null }), { gridSize: 64 });
  assert.equal(out.ok, true);
  assert.equal(out.result.location, null);
});

test('normalized result validation rejects out-of-range corners', () => {
  const out = validateNormalizedComponentResult({
    component: { name: 'LED', identity_status: 'ai_candidate', evidence: [], uncertainty: 'low' },
    location: {
      grid_cell: 'R33C33',
      center: { x: 0.5, y: 0.5 },
      corners: [{ x: 1.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }],
    },
    next_action: 'instruction',
    instruction: 'Check it.',
  }, { gridSize: 64 });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /within 0\.\.1/i);
});
