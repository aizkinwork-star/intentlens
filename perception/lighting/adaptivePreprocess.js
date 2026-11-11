// perception/lighting/adaptivePreprocess.js — pure illumination/exposure repair.
//
// Camera frames on a phone or a cheap laptop webcam are often dim, backlit,
// blown out, or lit unevenly across the board. A vision model sees the raw
// still, so those faults become wrong component answers. This module measures
// the frame and repairs only what it can prove is wrong, with plain array
// maths and no DOM or OpenCV dependency. That keeps it testable in Node and
// cheap enough for a low-power PC.
//
// Every function is pure: the input ImageData-like object
// ({ data: Uint8ClampedArray, width, height }) is never modified.
//
// Honesty rules:
//   - Nothing is "enhanced" when the frame is already good.
//   - A repair reports what it did, so the UI can say the frame was adjusted.
//   - Perceptual repairs never invent detail: contrast stretch is bounded and
//     sharpening is clamped, so a blurry photo is still reported as blurry.

export const LIGHTING_STATES = ['good', 'dim', 'blown_out', 'low_contrast', 'uneven'];

export const DEFAULT_ANALYSIS = {
  targetMean: 128,
  shadowCut: 45,
  highlightCut: 220,
  clipLow: 5,
  clipHigh: 250,
  minDynamicRange: 42,
  minUniformity: 0.55,
  maxSamples: 24000,
};

export const DEFAULT_PREPROCESS = {
  // Bounded so a very dark frame is lifted, not turned into grey mush.
  maxGamma: 2.8,
  minGamma: 0.5,
  targetMean: 128,
  stretchLowPercentile: 0.02,
  stretchHighPercentile: 0.98,
  flattenStrength: 0.7,
  sharpenAmount: 0.35,
  maxSharpenAmount: 0.8,
};

function assertImage(imageData) {
  if (!imageData || !imageData.data || !Number.isFinite(imageData.width) || !Number.isFinite(imageData.height)) {
    throw new TypeError('imageData must have { data, width, height }');
  }
  if (imageData.width <= 0 || imageData.height <= 0) throw new TypeError('imageData must be non-empty');
  const expected = imageData.width * imageData.height * 4;
  if (imageData.data.length < expected) {
    throw new TypeError(`imageData has ${imageData.data.length} bytes, expected at least ${expected}`);
  }
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clampByte(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value;
}

function percentileFromHistogram(hist, total, fraction) {
  if (total <= 0) return 0;
  const target = fraction * total;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    seen += hist[i];
    if (seen >= target) return i;
  }
  return hist.length - 1;
}

function newImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/**
 * Measure a frame. Uses an evenly spaced sample so cost does not grow with
 * megapixels. Percentiles come from a 256-bin luma histogram.
 */
export function analyzeLighting(imageData, options = {}) {
  assertImage(imageData);
  const opts = { ...DEFAULT_ANALYSIS, ...options };
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const step = Math.max(1, Math.floor(totalPixels / Math.max(1, opts.maxSamples)));

  const hist = new Uint32Array(256);
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let clippedHigh = 0;
  let clippedLow = 0;
  let shadowCount = 0;
  let highlightCount = 0;

  // Block means for a spatial uniformity estimate (8x8 tiles).
  const tiles = 8;
  const tileSum = new Float64Array(tiles * tiles);
  const tileCount = new Float64Array(tiles * tiles);

  for (let p = 0; p < totalPixels; p += step) {
    const i = p * 4;
    const y = luma(data[i], data[i + 1], data[i + 2]);
    const yb = y | 0;
    hist[yb] += 1;
    sum += y;
    sumSq += y * y;
    count += 1;
    if (data[i] >= opts.clipHigh && data[i + 1] >= opts.clipHigh && data[i + 2] >= opts.clipHigh) clippedHigh += 1;
    if (data[i] <= opts.clipLow && data[i + 1] <= opts.clipLow && data[i + 2] <= opts.clipLow) clippedLow += 1;
    if (y < opts.shadowCut) shadowCount += 1;
    if (y > opts.highlightCut) highlightCount += 1;

    const px = p % width;
    const py = (p / width) | 0;
    const tx = Math.min(tiles - 1, Math.floor((px / width) * tiles));
    const ty = Math.min(tiles - 1, Math.floor((py / height) * tiles));
    const ti = ty * tiles + tx;
    tileSum[ti] += y;
    tileCount[ti] += 1;
  }

  const mean = count ? sum / count : 0;
  const variance = count ? Math.max(0, sumSq / count - mean * mean) : 0;
  const stdDev = Math.sqrt(variance);
  const p05 = percentileFromHistogram(hist, count, 0.05);
  const p50 = percentileFromHistogram(hist, count, 0.5);
  const p95 = percentileFromHistogram(hist, count, 0.95);
  const dynamicRange = Math.max(0, p95 - p05);

  const blockMeans = [];
  for (let t = 0; t < tiles * tiles; t += 1) {
    if (tileCount[t] > 0) blockMeans.push(tileSum[t] / tileCount[t]);
  }
  const blockMean = blockMeans.reduce((a, b) => a + b, 0) / (blockMeans.length || 1);
  const blockVariance = blockMeans.reduce((a, b) => a + (b - blockMean) ** 2, 0) / (blockMeans.length || 1);
  const uniformity = blockMean > 0
    ? Math.max(0, Math.min(1, 1 - Math.sqrt(blockVariance) / blockMean))
    : 0;

  const clippingHigh = count ? clippedHigh / count : 0;
  const clippingLow = count ? clippedLow / count : 0;
  const shadowRatio = count ? shadowCount / count : 0;
  const highlightRatio = count ? highlightCount / count : 0;

  let state = 'good';
  if (mean >= 236 || clippingHigh > 0.22) state = 'blown_out';
  else if (mean < 58 || shadowRatio > 0.62 || clippingLow > 0.35) state = 'dim';
  else if (dynamicRange < opts.minDynamicRange) state = 'low_contrast';
  else if (uniformity < opts.minUniformity) state = 'uneven';

  // A single 0..1 quality number the UI can compare across frames.
  const exposureScore = 1 - Math.min(1, Math.abs(mean - opts.targetMean) / opts.targetMean);
  const rangeScore = Math.min(1, dynamicRange / 180);
  const clipScore = 1 - Math.min(1, clippingHigh * 3 + clippingLow * 3);
  const score = Math.max(0, Math.min(1,
    0.35 * exposureScore + 0.3 * rangeScore + 0.2 * uniformity + 0.15 * clipScore,
  ));

  return {
    width,
    height,
    samples: count,
    mean,
    median: p50,
    stdDev,
    p05,
    p95,
    dynamicRange,
    clippingHigh,
    clippingLow,
    shadowRatio,
    highlightRatio,
    uniformity,
    state,
    score,
    recommendation: recommendRepair({ mean, dynamicRange, uniformity, clippingHigh, clippingLow, stdDev }),
  };
}

function recommendRepair({ mean, dynamicRange, uniformity, clippingHigh, clippingLow, stdDev }) {
  const steps = [];
  if (mean < 95 && clippingHigh < 0.08) steps.push('auto_exposure');
  if (dynamicRange < 70 && clippingHigh < 0.05) steps.push('contrast_stretch');
  if (uniformity < 0.68) steps.push('flatten_illumination');
  if (stdDev > 4 && stdDev < 70) steps.push('sharpen');
  if (clippingLow > 0.4) steps.push('lift_shadows');
  return { steps };
}

/** Gamma adjustment expressed as a lookup table. */
export function gammaCorrect(imageData, gamma) {
  assertImage(imageData);
  const g = Math.max(0.1, Math.min(4, Number(gamma) || 1));
  if (Math.abs(g - 1) < 1e-6) return { ...imageData, data: new Uint8ClampedArray(imageData.data) };
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i += 1) lut[i] = clampByte(Math.round(255 * (i / 255) ** (1 / g)));
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = lut[data[i]];
    out[i + 1] = lut[data[i + 1]];
    out[i + 2] = lut[data[i + 2]];
    out[i + 3] = data[i + 3];
  }
  return { data: out, width, height };
}

/**
 * Lift the frame toward a target mean without clipping. Returns the adjusted
 * image and the gamma actually used.
 */
export function autoExposure(imageData, { targetMean = 128, maxGamma = 2.8, minGamma = 0.5 } = {}) {
  assertImage(imageData);
  const stats = analyzeLighting(imageData);
  if (stats.clippingHigh > 0.15) return { image: imageData, gamma: 1, changed: false };
  const mean = Math.max(4, Math.min(251, stats.mean));
  // Solve 255*(mean/255)^(1/gamma) = targetMean  =>  gamma = ln(mean/255)/ln(target/255)
  const denominator = Math.log(targetMean / 255);
  const numerator = Math.log(mean / 255);
  let gamma = denominator !== 0 ? numerator / denominator : 1;
  if (!Number.isFinite(gamma)) gamma = 1;
  gamma = Math.max(minGamma, Math.min(maxGamma, gamma));
  if (Math.abs(gamma - 1) < 0.03) return { image: imageData, gamma: 1, changed: false };
  return { image: gammaCorrect(imageData, gamma), gamma, changed: true };
}

/** Scale contrast so the 2nd..98th percentile spans the full range. */
export function contrastStretch(imageData, { lowPercentile = 0.02, highPercentile = 0.98, maxScale = 4 } = {}) {
  assertImage(imageData);
  const { data, width, height } = imageData;
  const hist = new Uint32Array(256);
  const totalPixels = width * height;
  for (let p = 0; p < totalPixels; p += 1) {
    const i = p * 4;
    hist[luma(data[i], data[i + 1], data[i + 2]) | 0] += 1;
  }
  const low = percentileFromHistogram(hist, totalPixels, lowPercentile);
  const high = percentileFromHistogram(hist, totalPixels, highPercentile);
  if (high - low < 8) return { image: imageData, low, high, scale: 1, changed: false };
  const scale = Math.min(maxScale, 255 / (high - low));
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = clampByte(Math.round((data[i] - low) * scale));
    out[i + 1] = clampByte(Math.round((data[i + 1] - low) * scale));
    out[i + 2] = clampByte(Math.round((data[i + 2] - low) * scale));
    out[i + 3] = data[i + 3];
  }
  return { image: { data: out, width, height }, low, high, scale, changed: true };
}

/** Box blur over one channel, integral-image implementation (O(pixels)). */
function blurredLuma(imageData, radius) {
  const { data, width, height } = imageData;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rowSum += luma(data[i], data[i + 1], data[i + 2]);
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float32Array(width * height);
  const r = Math.max(1, radius | 0);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      const a = integral[y1 * (width + 1) + x1 + 1];
      const b = integral[(y0) * (width + 1) + x1 + 1];
      const c = integral[y1 * (width + 1) + x0];
      const d = integral[y0 * (width + 1) + x0];
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      out[y * width + x] = (a - b - c + d) / area;
    }
  }
  return out;
}

/**
 * Flatten a slow illumination gradient (a desk lamp on one side, a window on
 * the other) by subtracting the local mean and re-centering on the global mean.
 * Chroma is preserved relative to luma, so colours do not invert.
 */
export function normalizeIllumination(imageData, { radius = 24, strength = 0.7 } = {}) {
  assertImage(imageData);
  const { data, width, height } = imageData;
  const local = blurredLuma(imageData, radius);
  let globalSum = 0;
  for (let i = 0; i < local.length; i += 1) globalSum += local[i];
  const globalMean = local.length ? globalSum / local.length : 0;
  const s = Math.max(0, Math.min(1, strength));
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0; p < local.length; p += 1) {
    const delta = (local[p] - globalMean) * s;
    const i = p * 4;
    out[i] = clampByte(Math.round(data[i] - delta));
    out[i + 1] = clampByte(Math.round(data[i + 1] - delta));
    out[i + 2] = clampByte(Math.round(data[i + 2] - delta));
    out[i + 3] = data[i + 3];
  }
  return { image: { data: out, width, height }, radius, strength: s, globalMean, changed: s > 0 };
}

/**
 * Bounded unsharp mask. It sharpens edges already present; it cannot recover a
 * frame that was out of focus, and callers should still report blur honestly.
 */
export function unsharpMask(imageData, { amount = 0.35, radius = 1 } = {}) {
  assertImage(imageData);
  const a = Math.max(0, Math.min(0.8, Number(amount) || 0));
  if (a === 0) return { image: imageData, amount: 0, changed: false };
  const { data, width, height } = imageData;
  const blur = blurredLuma(imageData, radius);
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0; p < blur.length; p += 1) {
    const i = p * 4;
    const detail = luma(data[i], data[i + 1], data[i + 2]) - blur[p];
    const delta = detail * a;
    out[i] = clampByte(Math.round(data[i] + delta));
    out[i + 1] = clampByte(Math.round(data[i + 1] + delta));
    out[i + 2] = clampByte(Math.round(data[i + 2] + delta));
    out[i + 3] = data[i + 3];
  }
  return { image: { data: out, width, height }, amount: a, radius, changed: true };
}

/**
 * The one entry point the capture paths call.
 *
 * `mode` is 'auto' (repair only what the measurement flags) or 'off'. The
 * result always includes a before/after report so the answer screen can say
 * whether the still was adjusted rather than silently pretending it was not.
 */
export function adaptivePreprocess(imageData, options = {}) {
  assertImage(imageData);
  const opts = { ...DEFAULT_PREPROCESS, ...options };
  const before = analyzeLighting(imageData);
  // A blown-out frame has no recoverable highlight detail. Do not sharpen or
  // stretch it into something that looks more usable than it is.
  if (options.mode === 'off' || before.state === 'blown_out' || (before.state === 'good' && options.force !== true)) {
    return {
      image: { data: new Uint8ClampedArray(imageData.data), width: imageData.width, height: imageData.height },
      before,
      after: before,
      steps: [],
      changed: false,
    };
  }

  let current = imageData;
  const steps = [];

  // 1. Exposure. Blown highlights are never pushed further.
  if (before.mean < 105 && before.clippingHigh < 0.1) {
    const exposure = autoExposure(current, { targetMean: opts.targetMean, maxGamma: opts.maxGamma, minGamma: opts.minGamma });
    if (exposure.changed) {
      current = exposure.image;
      steps.push({ step: 'auto_exposure', gamma: Number(exposure.gamma.toFixed(3)) });
    }
  }

  // 2. Contrast, only when the tonal range is genuinely compressed.
  if (before.dynamicRange < 120 && before.clippingHigh < 0.1) {
    const stretch = contrastStretch(current, {
      lowPercentile: opts.stretchLowPercentile,
      highPercentile: opts.stretchHighPercentile,
    });
    if (stretch.changed) {
      current = stretch.image;
      steps.push({ step: 'contrast_stretch', scale: Number(stretch.scale.toFixed(3)) });
    }
  }

  // 3. Uneven light.
  if (before.uniformity < 0.72) {
    const flat = normalizeIllumination(current, { strength: opts.flattenStrength });
    if (flat.changed) {
      current = flat.image;
      steps.push({ step: 'flatten_illumination', strength: flat.strength });
    }
  }

  // 4. Mild sharpening, only when contrast remains sane after the lifts.
  const mid = analyzeLighting(current);
  if (mid.stdDev > 3 && mid.stdDev < 80) {
    const sharp = unsharpMask(current, { amount: opts.sharpenAmount });
    if (sharp.changed) {
      current = sharp.image;
      steps.push({ step: 'sharpen', amount: sharp.amount });
    }
  }

  const after = analyzeLighting(current);
  return {
    image: current,
    before,
    after,
    steps,
    changed: steps.length > 0,
    improved: after.score > before.score + 0.01,
  };
}

/** A compact 0..1 capture-quality score, independent of any model call. */
export function qualityScore(imageData, options = {}) {
  return analyzeLighting(imageData, options).score;
}

export default { analyzeLighting, adaptivePreprocess, qualityScore };
