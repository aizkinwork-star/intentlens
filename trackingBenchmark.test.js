// trackingBenchmark.test.js — measured tracking gates on synthetic scenes.
//
// Uses the same scene generator as scripts/bench-tracking.mjs, but only the
// scenarios that run fast enough for the default suite. The full benchmark
// (node scripts/bench-tracking.mjs) is the number to quote.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetTracker } from './tracker.js';
import { sequence, runSequence } from './scripts/tracking-scenes.mjs';

const FRAMES = 20;

test('clean light: follows a moving component (tracked rate, IoU)', () => {
  const result = runSequence(sequence({ frames: FRAMES }), { TargetTracker });
  assert.ok(result.trackedRate >= 0.9, `tracked rate ${(result.trackedRate * 100).toFixed(1)}%`);
  assert.ok(result.meanIou >= 0.6, `mean IoU ${(result.meanIou * 100).toFixed(1)}%`);
});

test('dim light (50%): chromaticity descriptor keeps the target', () => {
  const result = runSequence(sequence({ frames: FRAMES, opacity: 0.5 }), { TargetTracker });
  assert.ok(result.trackedRate >= 0.9, `tracked rate ${(result.trackedRate * 100).toFixed(1)}%`);
  assert.ok(result.meanIou >= 0.6, `mean IoU ${(result.meanIou * 100).toFixed(1)}%`);
});

test('lights dropping mid-track does not lose the target', () => {
  const result = runSequence(sequence({ frames: FRAMES, opacityAfter: 0.4 }), { TargetTracker });
  assert.ok(result.trackedRate >= 0.9, `tracked rate ${(result.trackedRate * 100).toFixed(1)}%`);
});

test('occlusion is reported honestly and recovered', () => {
  const result = runSequence(sequence({ frames: 24, occlude: [8, 13] }), { TargetTracker });
  assert.equal(result.falseTrackRate, 0, 'no occluded frame may be reported as TRACKING');
  assert.ok(result.recoveryFrames !== null, 'target must be reacquired after reappearing');
  assert.ok(result.recoveryFrames <= 3, `recovered after ${result.recoveryFrames} visible frames`);
  assert.ok(result.trackedRate >= 0.85, `tracked rate ${(result.trackedRate * 100).toFixed(1)}%`);
});

test('box size does not drift on a stationary target', () => {
  const frames = Array.from({ length: 16 }, (_, index) => {
    const first = sequence({ frames: 1 })[0];
    return index === 0 ? first : { ...first, truth: { ...first.truth } };
  });
  const box = { ...frames[0].truth };
  const tracker = new TargetTracker({ frameWidth: 320, frameHeight: 240 });
  tracker.init({
    targetId: 'static',
    anchor: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    box,
    appearance: TargetTracker.buildAppearance(frames[0].frame, box),
  });
  let snap = null;
  for (let index = 1; index < frames.length; index += 1) {
    snap = tracker.update(frames[index].frame, 1000 + index * 100);
  }
  assert.ok(Math.abs(snap.box.width - box.width) / box.width < 0.15, `width ${snap.box.width.toFixed(3)}`);
  assert.ok(Math.abs(snap.box.height - box.height) / box.height < 0.15, `height ${snap.box.height.toFixed(3)}`);
});
