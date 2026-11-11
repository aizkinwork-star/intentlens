// HingeTracker.test.js — synthetic hinge geometry and orientation fixtures.
// No camera, DOM or OpenCV is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HINGE_STATES,
  HingeTracker,
  angleDifferenceDeg,
  classifyHinge,
  dominantOrientations,
  edgeAngleDeg,
  edgeGeometryQuality,
  estimateHingeFromFrame,
  hingeAngleDeg,
} from './perception/tracking/HingeTracker.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const v = fn(x, y);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

// Smooth sinusoidal stripes running at `angleDeg`. A sinusoid keeps the
// gradient direction coherent instead of quantising a hard binary edge.
function stripes(width, height, angleDeg, period = 10) {
  const rad = (angleDeg * Math.PI) / 180;
  return makeImage(width, height, (x, y) => {
    const s = Math.sin(((2 * Math.PI) / period) * (x * Math.cos(rad) + y * Math.sin(rad)));
    return Math.round(128 + 90 * s);
  });
}

// Two regions with different orientations, blended gradually so the seam does
// not create a third, stronger orientation of its own.
function twoOrientations(width, height, angleA, angleB, period = 10) {
  const a = (angleA * Math.PI) / 180;
  const b = (angleB * Math.PI) / 180;
  return makeImage(width, height, (x, y) => {
    const sa = Math.sin(((2 * Math.PI) / period) * (x * Math.cos(a) + y * Math.sin(a)));
    const sb = Math.sin(((2 * Math.PI) / period) * (x * Math.cos(b) + y * Math.sin(b)));
    // Blend over the middle fifth of the frame.
    const t = Math.max(0, Math.min(1, (y - height * 0.4) / (height * 0.2)));
    return Math.round(128 + 90 * ((1 - t) * sa + t * sb));
  });
}

function midVectors(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  // `upper` always points straight up; `lower` is angleDeg away from it.
  return {
    upper: { near: { x: 0.5, y: 0.5 }, far: { x: 0.5, y: 0.3 } },
    lower: { near: { x: 0.5, y: 0.5 }, far: { x: 0.5 + 0.2 * Math.sin(rad), y: 0.5 - 0.2 * Math.cos(rad) } },
  };
}

test('hinge angle is closed at 0, right-angled at 90 and flat at 180', () => {
  assert.ok(Math.abs(hingeAngleDeg(midVectors(0).upper, midVectors(0).lower) - 0) < 0.01);
  assert.ok(Math.abs(hingeAngleDeg(midVectors(90).upper, midVectors(90).lower) - 90) < 0.01);
  assert.ok(Math.abs(hingeAngleDeg(midVectors(180).upper, midVectors(180).lower) - 180) < 0.01);
  assert.equal(hingeAngleDeg(null, null), null);
  assert.equal(hingeAngleDeg({ near: { x: 0.5, y: 0.5 }, far: { x: 0.5, y: 0.5 } }, midVectors(90).lower), null);
});

test('edge angle and undirected difference wrap correctly', () => {
  assert.equal(edgeAngleDeg({ a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }), 0);
  assert.equal(edgeAngleDeg({ a: { x: 0, y: 1 }, b: { x: 0, y: 0 } }), 90);
  assert.equal(angleDifferenceDeg(170, 10), 20);
  assert.equal(angleDifferenceDeg(10, 170), 20);
  assert.equal(angleDifferenceDeg(90, 0), 90);
  assert.equal(angleDifferenceDeg(0, 0), 0);
});

test('hinge bands classify closed, partially open and open', () => {
  assert.equal(classifyHinge(0), 'closed');
  assert.equal(classifyHinge(20), 'closed');
  assert.equal(classifyHinge(21), 'partially_open');
  assert.equal(classifyHinge(149), 'partially_open');
  assert.equal(classifyHinge(150), 'open');
  assert.equal(classifyHinge(180), 'open');
  assert.equal(classifyHinge(null), 'unknown');
});

test('edge geometry quality rewards long, well-angled board edges', () => {
  const long = edgeGeometryQuality(midVectors(90).upper, midVectors(90).lower);
  const short = edgeGeometryQuality(
    { near: { x: 0.5, y: 0.5 }, far: { x: 0.5, y: 0.49 } },
    { near: { x: 0.5, y: 0.5 }, far: { x: 0.51, y: 0.5 } },
  );
  assert.ok(long > 0.6, String(long));
  assert.ok(short < 0.2, String(short));
  assert.equal(edgeGeometryQuality(null, null), 0);
});

test('two synthetic stripe orientations are recovered within one bin', () => {
  // Two coherent orientations at 15 and 75 degrees => undirected difference 60.
  const combined = twoOrientations(160, 160, 15, 75);
  const { orientations, confidence } = dominantOrientations(combined);
  assert.ok(orientations.length >= 2, `found ${orientations.length}`);
  const found = angleDifferenceDeg(orientations[0].deg, orientations[1].deg);
  assert.ok(Math.abs(found - 60) <= 8, `expected ~60, got ${found}`);
  assert.ok(confidence > 0.3, `confidence ${confidence}`);
});

test('a single orientation cannot claim a hinge angle', () => {
  const frame = stripes(120, 120, 35);
  const estimate = estimateHingeFromFrame(frame);
  assert.ok(estimate.confidence < 0.5, `confidence ${estimate.confidence}`);
  assert.equal(estimate.method, 'orientation');
});

test('a tracker follows a closing lid smoothly and reports velocity', () => {
  const changes = [];
  const tracker = new HingeTracker({ smoothing: 0.35, lostAfterMs: 900, onStateChange: (e) => changes.push(e) });
  assert.equal(tracker.state, 'INACTIVE');

  let snap = tracker.update({ ...midVectors(90), timestamp: 0 });
  assert.equal(snap.state, 'TRACKING');
  assert.ok(Math.abs(snap.angleDeg - 90) < 0.01);
  assert.equal(snap.position, 'partially_open');

  snap = tracker.update({ ...midVectors(70), timestamp: 100 });
  assert.ok(snap.angleDeg < 90 && snap.angleDeg > 70, `smoothed ${snap.angleDeg}`);
  assert.ok(snap.velocityDegPerSec < 0, `velocity ${snap.velocityDegPerSec}`);

  snap = tracker.update({ ...midVectors(40), timestamp: 200 });
  assert.ok(snap.angleDeg < 90, `angle ${snap.angleDeg}`);
  assert.ok(snap.samples >= 3);
  assert.ok(changes.some((c) => c.next === 'TRACKING'));
});

test('low-confidence observations degrade the state but keep the last angle', () => {
  const tracker = new HingeTracker({ smoothing: 0.4, lostAfterMs: 900 });
  tracker.update({ ...midVectors(100), timestamp: 0 });
  const held = tracker.angleDeg;

  const snap = tracker.update({ ...midVectors(30), confidence: 0.1, timestamp: 100 });
  assert.equal(snap.state, 'LOW_CONFIDENCE');
  assert.equal(snap.angleDeg, held, 'a bad frame must not move the angle');
  assert.ok(snap.missed >= 1);
});

test('a tracker reports LOST after the timeout and reacquires on a good frame', () => {
  const tracker = new HingeTracker({ smoothing: 0.4, lostAfterMs: 500 });
  tracker.update({ ...midVectors(90), timestamp: 0 });
  const lost = tracker.update({ timestamp: 900 });
  assert.equal(lost.state, 'LOST');

  const back = tracker.update({ ...midVectors(150), timestamp: 1000 });
  assert.equal(back.state, 'TRACKING');
  assert.ok(Math.abs(back.angleDeg - 150) < 0.01, 'reacquisition snaps to the measurement');
  assert.equal(back.position, 'open');
});

test('a single absurd jump is clamped instead of snapping the angle', () => {
  const tracker = new HingeTracker({ smoothing: 0.5, maxJumpDeg: 65, maxVelocityDegPerSec: 200, lostAfterMs: 5000 });
  tracker.update({ ...midVectors(20), timestamp: 0 });
  const snap = tracker.update({ ...midVectors(170), timestamp: 50 });
  assert.ok(snap.angleDeg < 100, `clamped angle ${snap.angleDeg}`);
  assert.equal(snap.state, 'TRACKING');
});

test('out-of-order frames are ignored', () => {
  const tracker = new HingeTracker({ smoothing: 0.5 });
  tracker.update({ ...midVectors(90), timestamp: 1000 });
  const before = tracker.angleDeg;
  const snap = tracker.update({ ...midVectors(20), timestamp: 500 });
  assert.equal(snap.angleDeg, before);
});

test('reset clears state and predict uses velocity', () => {
  const tracker = new HingeTracker({ smoothing: 1 });
  tracker.update({ ...midVectors(90), timestamp: 0 });
  tracker.update({ ...midVectors(80), timestamp: 100 });
  const predicted = tracker.predict(100);
  assert.ok(predicted <= 80.01, `predicted ${predicted}`);
  tracker.reset();
  assert.equal(tracker.state, 'INACTIVE');
  assert.equal(tracker.angleDeg, null);
  assert.equal(tracker.predict(100), null);
});

test('every advertised tracker state is reachable', () => {
  const seen = new Set();
  const tracker = new HingeTracker({ lostAfterMs: 100 });
  seen.add(tracker.state);
  tracker.update({ ...midVectors(90), timestamp: 0 });
  seen.add(tracker.state);
  tracker.update({ ...midVectors(90), confidence: 0, timestamp: 50 });
  seen.add(tracker.state);
  tracker.update({ timestamp: 500 });
  seen.add(tracker.state);
  for (const state of seen) assert.ok(HINGE_STATES.includes(state), state);
  assert.equal(seen.size, HINGE_STATES.length);
});
