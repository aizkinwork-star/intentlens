// Coordinate math + result validation. Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidPoint,
  isValidBox,
  clientToNormalized,
  modelPointToNormalized,
  modelBoxToNormalized,
  fitContain,
  rectToNormalized,
  isInsideNormalizedRect,
  boxCenter,
} from './grid.js';
import { validateResult } from './schema.js';

test('NaN and Infinity are invalid', () => {
  assert.equal(isValidPoint(NaN, 0.5), false);
  assert.equal(isValidPoint(0.5, Infinity), false);
  assert.equal(isValidPoint(0.5, 0.5), true);
});

// ---------------------------------------------------------------------------
// Model coordinates (0..1000) -> normalized (0..1)
// ---------------------------------------------------------------------------
test('model coordinates divide by 1000', () => {
  assert.deepEqual(modelPointToNormalized(600, 400), { x: 0.6, y: 0.4 });
  assert.deepEqual(modelPointToNormalized(0, 1000), { x: 0, y: 1 });
});
test('a small edge overshoot is clamped, a wild value is rejected', () => {
  assert.deepEqual(modelPointToNormalized(1001, 999), { x: 1, y: 0.999 });
  assert.equal(modelPointToNormalized(5000, 500), null);
  assert.equal(modelPointToNormalized(NaN, 500), null);
});
test('model box corners become a normalized x/y/width/height box', () => {
  const box = modelBoxToNormalized(560, 330, 640, 470);
  assert.ok(box);
  assert.equal(Number(box.x.toFixed(3)), 0.56);
  assert.equal(Number(box.width.toFixed(3)), 0.08);
  assert.equal(Number(box.height.toFixed(3)), 0.14);
});
test('reversed box corners are swapped, not rejected', () => {
  const box = modelBoxToNormalized(640, 470, 560, 330);
  assert.ok(box);
  assert.equal(Number(box.x.toFixed(3)), 0.56);
  assert.equal(Number(box.y.toFixed(3)), 0.33);
});
test('a degenerate box is rejected', () => {
  assert.equal(modelBoxToNormalized(500, 500, 500, 500), null);
});

// ---------------------------------------------------------------------------
// Boxes + letterboxing (§5.5)
// ---------------------------------------------------------------------------
test('box validity', () => {
  assert.equal(isValidBox({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), true);
  assert.equal(isValidBox({ x: 0.9, y: 0.9, width: 0.3, height: 0.1 }), false); // leaves the frame
  assert.equal(isValidBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 }), false);
});
test('box centre', () => {
  const c = boxCenter({ x: 0.2, y: 0.4, width: 0.2, height: 0.2 });
  assert.equal(Number(c.x.toFixed(3)), 0.3);
  assert.equal(Number(c.y.toFixed(3)), 0.5);
});

test('a 4:3 image letterboxes inside a 16:9 frame and keeps its aspect ratio', () => {
  const r = fitContain(4000, 3000, 1280, 720);
  assert.equal(r.height, 720);
  assert.equal(r.width, 960);
  assert.equal(r.left, 160);
  assert.equal(r.top, 0);
  // No cropping: the whole source is drawn.
  assert.ok(r.width <= 1280 && r.height <= 720);
});

test('the drawn image rect converts to normalized frame coordinates', () => {
  const r = fitContain(4000, 3000, 1280, 720);
  const n = rectToNormalized(r, 1280, 720);
  assert.equal(Number(n.x0.toFixed(3)), 0.125);
  assert.equal(n.y0, 0);
  assert.equal(Number(n.x1.toFixed(3)), 0.875);
  assert.equal(n.y1, 1);
});

test('a tap converts to normalized coordinates against the frame rect', () => {
  const p = clientToNormalized(150, 250, { left: 50, top: 50, width: 200, height: 400 });
  assert.deepEqual(p, { x: 0.5, y: 0.5 });
});

test('taps on the letterbox bars are outside the image rect', () => {
  const n = rectToNormalized(fitContain(4000, 3000, 1280, 720), 1280, 720);
  assert.equal(isInsideNormalizedRect(0.5, 0.5, n), true);
  assert.equal(isInsideNormalizedRect(0.05, 0.5, n), false); // left black bar
  assert.equal(isInsideNormalizedRect(0.95, 0.5, n), false); // right black bar
});

// ---------------------------------------------------------------------------
// Result validation (§8.5, §14.1)
// ---------------------------------------------------------------------------
const good = {
  requestId: 'req_1',
  frameId: 'frame_001',
  resultStatus: 'target_found',
  answerShort: 'This looks like the display connector.',
  target: {
    targetId: 'J2',
    label: 'display connector (proposed)',
    point: { x: 0.68, y: 0.74 },
    box: { x: 0.62, y: 0.69, width: 0.12, height: 0.1 },
    confidence: 0.71,
    freshness: 'current_frame',
  },
  uncertaintyNote: null,
  evidenceKind: 'visual_inference',
  evidence: [],
  needsConfirmation: false,
  requestedClarification: null,
};

test('validator accepts a well-formed result', () => {
  assert.equal(validateResult(good).ok, true);
});
test('validator rejects coordinates outside the image', () => {
  const r = structuredClone(good);
  r.target.point.x = 3;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a malformed box', () => {
  const r = structuredClone(good);
  r.target.box.width = -0.1;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a confidence outside [0,1]', () => {
  const r = structuredClone(good);
  r.target.confidence = 1.4;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a target that is not on the current frame', () => {
  const r = structuredClone(good);
  r.target.freshness = 'stale';
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a target with no position at all', () => {
  const r = structuredClone(good);
  delete r.target.point;
  delete r.target.box;
  assert.equal(validateResult(r).ok, false);
});
test('no marker is allowed when there is no target', () => {
  const r = { ...structuredClone(good), resultStatus: 'needs_clarification' };
  assert.equal(validateResult(r).ok, false, 'target present on a non-target result must be refused');
  r.target = null;
  assert.equal(validateResult(r).ok, true);
});
test('a stale frame id is refused, so an old overlay is never treated as current', () => {
  assert.equal(validateResult(good, { requestId: 'req_1', frameId: 'frame_002' }).ok, false);
  assert.equal(validateResult(good, { requestId: 'req_2', frameId: 'frame_001' }).ok, false);
  assert.equal(validateResult(good, { requestId: 'req_1', frameId: 'frame_001' }).ok, true);
});
test('evidence must be real, well-formed entries', () => {
  const r = structuredClone(good);
  r.evidence = [{ title: 'Manual', kind: 'web_source', claim: 'pin 1 is VBUS', url: 'javascript:alert(1)' }];
  assert.equal(validateResult(r).ok, false);
});
