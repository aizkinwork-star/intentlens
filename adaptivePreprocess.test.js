// adaptivePreprocess.test.js — synthetic lighting fixtures for the pure
// exposure/contrast/illumination module. No camera or DOM is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHTING_STATES,
  adaptivePreprocess,
  analyzeLighting,
  autoExposure,
  contrastStretch,
  gammaCorrect,
  normalizeIllumination,
  qualityScore,
  unsharpMask,
} from './perception/lighting/adaptivePreprocess.js';

// Small deterministic PRNG so fixtures are identical on every run.
function rng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function makeImage(width, height, fn, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fn(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = alpha;
    }
  }
  return { data, width, height };
}

function noisy(mean, amplitude, seed = 7) {
  const rand = rng(seed);
  return () => {
    const v = Math.max(0, Math.min(255, mean + (rand() - 0.5) * 2 * amplitude));
    return [v, v, v];
  };
}

function blockStats(image) {
  return analyzeLighting(image);
}

test('a textured mid-tone frame is reported as good and left untouched', () => {
  const image = makeImage(96, 96, noisy(128, 52));
  const stats = blockStats(image);
  assert.equal(stats.state, 'good');
  assert.ok(stats.score > 0.5, `score ${stats.score}`);

  const snapshot = Uint8ClampedArray.from(image.data);
  const result = adaptivePreprocess(image);
  assert.equal(result.changed, false);
  assert.deepEqual(result.steps, []);
  assert.equal(result.after.state, 'good');
  assert.deepEqual(image.data, snapshot, 'input must never be modified');
  assert.notEqual(result.image.data, image.data, 'a copy is returned');
});

test('a dark frame is classified dim and auto-exposure lifts its mean', () => {
  const image = makeImage(80, 80, noisy(24, 10));
  const before = analyzeLighting(image);
  assert.equal(before.state, 'dim');
  assert.ok(before.shadowRatio > 0.5);

  const lifted = autoExposure(image, { targetMean: 128 });
  assert.equal(lifted.changed, true);
  assert.ok(lifted.gamma > 1, `gamma ${lifted.gamma}`);
  const after = analyzeLighting(lifted.image);
  assert.ok(after.mean > before.mean + 25, `${before.mean} -> ${after.mean}`);

  const result = adaptivePreprocess(image);
  assert.equal(result.changed, true);
  assert.ok(result.steps.some((s) => s.step === 'auto_exposure'));
  assert.ok(result.after.mean > result.before.mean);
});

test('a blown-out frame is never pushed brighter', () => {
  const image = makeImage(64, 64, () => [248, 248, 248]);
  const before = analyzeLighting(image);
  assert.equal(before.state, 'blown_out');
  assert.ok(before.mean > 236, `mean ${before.mean}`);

  const result = adaptivePreprocess(image);
  assert.equal(result.steps.some((s) => s.step === 'auto_exposure'), false);
  const after = analyzeLighting(result.image);
  assert.ok(after.mean <= before.mean + 1, `${before.mean} -> ${after.mean}`);
});

test('a compressed tonal range is stretched, not clipped into mush', () => {
  const image = makeImage(72, 72, noisy(128, 9, 11));
  const before = analyzeLighting(image);
  assert.equal(before.state, 'low_contrast');

  const stretched = contrastStretch(image);
  assert.equal(stretched.changed, true);
  assert.ok(stretched.scale > 1);
  const after = analyzeLighting(stretched.image);
  assert.ok(after.dynamicRange > before.dynamicRange + 20, `${before.dynamicRange} -> ${after.dynamicRange}`);
  assert.ok(after.clippingHigh < 0.25, 'stretch must stay bounded');

  const result = adaptivePreprocess(image);
  assert.ok(result.steps.some((s) => s.step === 'contrast_stretch'));
});

test('uneven lighting is flattened without changing the input', () => {
  const image = makeImage(96, 96, (x) => {
    const v = x < 48 ? 38 : 218;
    return [v, v, v];
  });
  const before = analyzeLighting(image);
  assert.equal(before.state, 'uneven');
  assert.ok(before.uniformity < 0.55, `uniformity ${before.uniformity}`);

  const snapshot = Uint8ClampedArray.from(image.data);
  const flattened = normalizeIllumination(image, { strength: 0.9 });
  const after = analyzeLighting(flattened.image);
  assert.ok(after.uniformity > before.uniformity + 0.15, `${before.uniformity} -> ${after.uniformity}`);
  assert.deepEqual(image.data, snapshot);

  const result = adaptivePreprocess(image);
  assert.ok(result.steps.some((s) => s.step === 'flatten_illumination'));
});

test('sharpening raises local detail but stays bounded and preserves alpha', () => {
  const image = makeImage(48, 48, (x, y) => {
    const v = (x + y) % 2 === 0 ? 70 : 180;
    return [v, v, v];
  }, 200);
  const before = analyzeLighting(image);
  const sharpened = unsharpMask(image, { amount: 0.8 });
  assert.equal(sharpened.changed, true);
  const after = analyzeLighting(sharpened.image);
  assert.ok(after.stdDev >= before.stdDev - 0.5);
  for (let i = 3; i < sharpened.image.data.length; i += 4) {
    assert.equal(sharpened.image.data[i], 200, 'alpha must be preserved');
  }
});

test('quality ordering matches visible degradation', () => {
  const good = qualityScore(makeImage(64, 64, noisy(128, 52)));
  const lowContrast = qualityScore(makeImage(64, 64, noisy(128, 8)));
  const dark = qualityScore(makeImage(64, 64, noisy(18, 6)));
  assert.ok(good > lowContrast, `${good} > ${lowContrast}`);
  assert.ok(good > dark, `${good} > ${dark}`);
});

test('gamma identity is a copy and non-finite inputs are clamped safely', () => {
  const image = makeImage(8, 8, () => [10, 20, 30]);
  const same = gammaCorrect(image, 1);
  assert.deepEqual(same.data, image.data);
  assert.notEqual(same.data, image.data);
  const clamped = gammaCorrect(image, 100);
  assert.equal(clamped.data[0] >= image.data[0], true);
});

test('invalid image objects fail loudly instead of returning fake quality', () => {
  assert.throws(() => analyzeLighting(null), /imageData/);
  assert.throws(() => analyzeLighting({ data: new Uint8ClampedArray(4), width: 2, height: 2 }), /expected/);
  assert.throws(() => analyzeLighting({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), /non-empty/);
});

test('all advertised lighting states are reachable by construction', () => {
  const seen = new Set();
  seen.add(analyzeLighting(makeImage(40, 40, noisy(128, 52))).state);
  seen.add(analyzeLighting(makeImage(40, 40, noisy(20, 5))).state);
  seen.add(analyzeLighting(makeImage(40, 40, () => [252, 252, 252])).state);
  seen.add(analyzeLighting(makeImage(40, 40, noisy(128, 8))).state);
  seen.add(analyzeLighting(makeImage(40, 40, (x) => (x < 20 ? [34, 34, 34] : [214, 214, 214]))).state);
  for (const state of seen) assert.ok(LIGHTING_STATES.includes(state), state);
  assert.equal(seen.size, LIGHTING_STATES.length);
});
