// Hand/person silhouette detector tests (JS backend, no OpenCV, no camera).
// Run with: node scripts/run-source-tests.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHands, getHandTrackerMode, isMediaPipeAvailable, resetHandTracker } from './handTracker.js';

function frame(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10;
    data[i + 1] = 10;
    data[i + 2] = 10;
    data[i + 3] = 255;
  }
  painter((x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  });
  return { data, width, height };
}

function skinBlob(x0, y0, w, h) {
  return (paint) => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) paint(x, y, 180, 120, 90);
    }
  };
}

test('hand tracker reports a usable mode without OpenCV', () => {
  assert.equal(isMediaPipeAvailable(), false);
  assert.equal(getHandTrackerMode(), 'js');
});

test('a compact skin blob in the lower frame is classified as a hand', async () => {
  resetHandTracker();
  const img = frame(160, 120, skinBlob(100, 70, 40, 30));
  const found = await detectHands(img);
  const hand = found.find((d) => d.kind === 'hand');
  assert.ok(hand, 'expected a hand detection');
  assert.ok(hand.box.width > 0.15 && hand.box.width < 0.45, `width ${hand.box.width}`);
  assert.ok(hand.box.x > 0.5, `x ${hand.box.x}`);
  assert.ok(Array.isArray(hand.contour) && hand.contour.length >= 3, 'expected a contour polygon');
  assert.ok(found.every((d) => d.kind !== 'person'), 'a small blob must not become a person');
});

test('a large skin region reaching the top edge is classified as a person', async () => {
  resetHandTracker();
  const img = frame(160, 120, skinBlob(20, 0, 120, 100));
  const found = await detectHands(img);
  const person = found.find((d) => d.kind === 'person');
  assert.ok(person, 'expected a person detection');
  assert.ok(person.box.height > 0.5, `height ${person.box.height}`);
});

test('a moving non-skin blob is detected through motion alone', async () => {
  resetHandTracker();
  await detectHands(frame(160, 120, () => {}));
  const moving = (paint) => {
    for (let y = 70; y < 100; y += 1) {
      for (let x = 100; x < 140; x += 1) paint(x, y, 220, 220, 220);
    }
  };
  const found = await detectHands(frame(160, 120, moving));
  const hand = found.find((d) => d.kind === 'hand');
  assert.ok(hand, 'expected a motion hand detection on a non-skin blob');
  assert.equal(hand.motion, true);
  assert.ok(hand.box.x > 0.5, `x ${hand.box.x}`);
});

test('an empty frame yields no detections', async () => {
  resetHandTracker();
  const img = frame(160, 120, () => {});
  assert.deepEqual(await detectHands(img), []);
});

test('detection survives a missing or malformed frame', async () => {
  resetHandTracker();
  assert.deepEqual(await detectHands(null), []);
  assert.deepEqual(await detectHands({ data: new Uint8ClampedArray(4), width: 0, height: 0 }), []);
});

test('smoothing holds a region briefly across a missed frame', async () => {
  resetHandTracker();
  const seen = await detectHands(frame(160, 120, skinBlob(100, 70, 40, 30)));
  assert.ok(seen.some((d) => d.kind === 'hand'));
  const missed = await detectHands(frame(160, 120, () => {}));
  assert.ok(missed.some((d) => d.kind === 'hand'), 'one missed frame should not drop the overlay');
});
