// tracker.test.js — synthetic tests for TargetTracker. Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetTracker, TRACKER_STATES } from './tracker.js';

// Full-frame ImageData with a horizontal colour gradient inside a box.
// Position is encoded in colour, so the tracker can distinguish left vs right.
// `box` is normalized 0..1.
function frameWithGradientBox(frameW, frameH, box, bg = { r: 20, g: 30, b: 40 }) {
  const data = new Uint8ClampedArray(frameW * frameH * 4);
  const x0 = box.x * frameW, x1 = (box.x + box.width) * frameW;
  const y0 = box.y * frameH, y1 = (box.y + box.height) * frameH;
  const bw = x1 - x0;
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const i = (y * frameW + x) * 4;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        // Gradient from red (left) to blue (right) within the box.
        const t = (x - x0) / bw;
        data[i] = Math.round(255 * (1 - t));     // r
        data[i + 1] = 40;                        // g
        data[i + 2] = Math.round(255 * t);       // b
      } else {
        data[i] = bg.r; data[i + 1] = bg.g; data[i + 2] = bg.b;
      }
      data[i + 3] = 255;
    }
  }
  return { data, width: frameW, height: frameH };
}

test('tracker states include the full state machine', () => {
  assert.deepEqual(TRACKER_STATES, ['INACTIVE', 'INITIALIZING', 'TRACKING', 'LOW_CONFIDENCE', 'LOST', 'REACQUIRING']);
});

test('init moves INACTIVE -> TRACKING and reports anchor/box', () => {
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const anchor = { x: 0.35, y: 0.475 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor, box, appearance });
  assert.equal(t.state, 'TRACKING');
  assert.equal(t.targetId, 'O1');
  assert.deepEqual(t.anchor, anchor);
  assert.ok(t.confidence > 0.9);
});

test('tracking a stationary box keeps high confidence', () => {
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const anchor = { x: 0.35, y: 0.475 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor, box, appearance });
  let now = 1000;
  const snap = t.update(frameWithGradientBox(320, 240, box), now);
  assert.equal(snap.state, 'TRACKING');
  assert.ok(snap.confidence > 0.7, 'expected high confidence, got ' + snap.confidence);
});

test('tracking a moved box follows toward the new position over several frames', () => {
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const anchor = { x: 0.35, y: 0.475 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor, box, appearance });

  const moved = { x: 0.5, y: 0.4, width: 0.1, height: 0.15 };
  let snap = null;
  let now = 1000;
  // Simulate several frames of the object at the new position (200 ms apart).
  for (let i = 0; i < 10; i++) {
    snap = t.update(frameWithGradientBox(320, 240, moved), now);
    now += 200;
  }
  assert.equal(snap.state, 'TRACKING');
  // Smoothed box should have moved toward 0.5 (not stuck at 0.3).
  assert.ok(snap.box.x > 0.35, 'tracker did not follow: ' + JSON.stringify(snap.box));
  assert.ok(snap.box.x < 0.55, 'tracker overshot: ' + JSON.stringify(snap.box));
});

test('a target that leaves the frame is marked LOST, not stale-locked', () => {
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const anchor = { x: 0.35, y: 0.475 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor, box, appearance });

  // Target gone: background-only frame.
  let snap = null;
  let now = 1000;
  for (let i = 0; i < 10; i++) {
    snap = t.update(frameWithGradientBox(320, 240, { x: 0.9, y: 0.9, width: 0.001, height: 0.001 }), now);
    now += 200;
  }
  assert.ok(['LOW_CONFIDENCE', 'LOST', 'REACQUIRING'].includes(snap.state),
    'expected degraded state, got ' + snap.state);
  assert.ok(snap.confidence < 0.7);
});

test('reset returns to INACTIVE and clears target', () => {
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor: { x: 0.35, y: 0.475 }, box, appearance });
  t.reset();
  assert.equal(t.state, 'INACTIVE');
  assert.equal(t.targetId, null);
  assert.equal(t.box, null);
  assert.equal(t.update(frameWithGradientBox(320, 240, box)), null);
});

test('onStateChange fires on transitions', () => {
  const changes = [];
  const t = new TargetTracker({ frameWidth: 320, frameHeight: 240, onStateChange: (c) => changes.push(c) });
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.15 };
  const appearance = TargetTracker.buildAppearance(frameWithGradientBox(320, 240, box), box);
  t.init({ targetId: 'O1', anchor: { x: 0.35, y: 0.475 }, box, appearance });
  assert.ok(changes.some((c) => c.next === 'TRACKING'));
  assert.equal(changes[changes.length - 1].targetId, 'O1');
});
