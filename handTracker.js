// handTracker.js — local hand / person silhouette detection (no neural models).
//
// This is a classical detector: skin segmentation → connected components →
// shape classification → temporal smoothing. It is deliberately conservative:
// it returns at most one hand and one person region, and it says "nothing"
// rather than drawing a box over the whole frame.
//
// Deliberately pure JavaScript: loading OpenCV.js (11 MB) on the renderer
// thread froze the preview for tens of seconds when tracking was toggled on.
// Hand/person tracking must never depend on it. Chip detection may still use
// OpenCV separately when the user enables that feature.
//
// Returns: { kind: 'hand' | 'person', score, boundingBox, contour, heuristic }

const SMOOTH_ALPHA = 0.55;
const MAX_MISSES = 12;
const MOTION_THRESHOLD = 18;
const MOTION_GLOBAL_MEAN_LIMIT = 14;

const memory = { hand: null, person: null, handMisses: 0, personMisses: 0 };
// Previous downscaled luminance frame, used for motion gating. Colour-based
// skin detection alone is unreliable on a green-cast / backlit webcam; motion
// is what makes a waving hand visible under any lighting.
const previous = { gray: null, width: 0, height: 0 };

export async function initHandTracker() {
  return { ok: true, mode: 'js' };
}

export function getHandTrackerMode() {
  return 'js';
}

/**
 * Detect hand / person regions in an ImageData frame.
 * @param {ImageData|{data:Uint8ClampedArray,width:number,height:number}} input
 * @returns {Promise<Array>} zero, one or two detections
 */
export async function detectHands(input) {
  const frame = toImageData(input);
  if (!frame || !frame.data || !frame.width || !frame.height) return [];
  return smooth(detectWithJS(frame));
}

export function isMediaPipeAvailable() { return false; }

/** Clears temporal smoothing state. Used by tests and when the camera stops. */
export function resetHandTracker() {
  memory.hand = null;
  memory.person = null;
  memory.handMisses = 0;
  memory.personMisses = 0;
  previous.gray = null;
  previous.width = 0;
  previous.height = 0;
}

// ---------------------------------------------------------------------------
// Input / output plumbing
// ---------------------------------------------------------------------------

function toImageData(input) {
  if (!input) return null;
  if (input.data && input.width && input.height) return input;
  // Video / canvas element: copy one frame into an offscreen canvas.
  if (typeof document === 'undefined') return null;
  try {
    const width = input.videoWidth || input.width;
    const height = input.videoHeight || input.height;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(input, 0, 0, width, height);
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

function normalizeComponent(comp, frameW, frameH, meta = {}) {
  const { heuristic = true, motion = false } = meta;
  const w = comp.maxX - comp.minX + 1;
  const h = comp.maxY - comp.minY + 1;
  const areaRatio = comp.area / (frameW * frameH);
  const widthRatio = w / frameW;
  const heightRatio = h / frameH;
  const aspect = w / Math.max(1, h);
  const touchesTop = comp.minY <= 1;

  // A frame-difference blob spans the old and new position of a moving hand,
  // so it is wider/looser than a still skin blob. Relax the geometry for it.
  const isPerson = motion
    ? (areaRatio >= 0.05 && (touchesTop || heightRatio >= 0.4 || widthRatio >= 0.45))
    : (areaRatio >= 0.06 && widthRatio >= 0.12 && (touchesTop || heightRatio >= 0.45));
  const isHand = !isPerson
    && areaRatio >= (motion ? 0.002 : 0.004)
    && areaRatio <= (motion ? 0.25 : 0.2)
    && heightRatio <= (motion ? 0.75 : 0.65)
    && (motion || (aspect >= 0.25 && aspect <= 3.5));

  if (!isPerson && !isHand) return null;

  const shape = isHand
    ? Math.min(1, 0.35 + areaRatio / 0.06 + (aspect > 0.4 && aspect < 2.2 ? 0.2 : 0) + (motion ? 0.2 : 0))
    : Math.min(1, 0.4 + areaRatio / 0.3 + (motion ? 0.1 : 0));
  const score = Math.max(0.05, Math.min(1, shape));

  return {
    kind: isPerson ? 'person' : 'hand',
    score,
    handedness: 'Unknown',
    landmarks: [],
    heuristic,
    motion,
    areaRatio,
    boundingBox: {
      xMin: comp.minX,
      yMin: comp.minY,
      xMax: comp.maxX + 1,
      yMax: comp.maxY + 1,
    },
    contour: comp.contour
      ? comp.contour.map((p) => ({ x: p.x / frameW, y: p.y / frameH }))
      : null,
    box: {
      x: comp.minX / frameW,
      y: comp.minY / frameH,
      width: w / frameW,
      height: h / frameH,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure-JS backend
// ---------------------------------------------------------------------------

function detectWithJS(frame) {
  const step = Math.max(2, Math.ceil(frame.width / 192));
  const W = Math.ceil(frame.width / step);
  const H = Math.ceil(frame.height / step);
  const gray = new Uint8Array(W * H);
  const skin = new Uint8Array(W * H);

  for (let gy = 0; gy < H; gy += 1) {
    const y = Math.min(frame.height - 1, gy * step);
    for (let gx = 0; gx < W; gx += 1) {
      const x = Math.min(frame.width - 1, gx * step);
      const i = (y * frame.width + x) * 4;
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const idx = gy * W + gx;
      gray[idx] = (r * 77 + g * 150 + b * 29) >> 8;
      if (isSkin(r, g, b)) skin[idx] = 1;
    }
  }

  // Motion mask against the previous frame. A large global change is an
  // exposure/white-balance jump, not movement, so it is ignored.
  const motion = new Uint8Array(W * H);
  let motionUsable = false;
  if (previous.gray && previous.width === W && previous.height === H) {
    let sum = 0;
    for (let i = 0; i < gray.length; i += 1) {
      const d = Math.abs(gray[i] - previous.gray[i]);
      sum += d;
      if (d >= MOTION_THRESHOLD) motion[i] = 1;
    }
    if (sum / gray.length < MOTION_GLOBAL_MEAN_LIMIT) {
      morph(motion, W, H, 'open');
      morph(motion, W, H, 'close');
      motionUsable = true;
    }
  }
  previous.gray = gray;
  previous.width = W;
  previous.height = H;

  morph(skin, W, H, 'open');
  morph(skin, W, H, 'close');

  let source = 'motion';
  let mask = motion;
  let motionPixels = 0;
  for (let i = 0; i < motion.length; i += 1) motionPixels += motion[i];
  if (!motionUsable || motionPixels < W * H * 0.0015) {
    // Nothing moved (or the first frame): fall back to skin colour.
    source = 'skin';
    mask = skin;
  }

  const components = connectedComponents(mask, W, H);
  const minArea = W * H * (source === 'motion' ? 0.0015 : 0.002);
  const detections = [];

  for (const comp of components) {
    if (comp.area < minArea) continue;
    const compNorm = {
      area: comp.area,
      minX: comp.minX * step,
      minY: comp.minY * step,
      maxX: Math.min(frame.width - 1, (comp.maxX + 1) * step - 1),
      maxY: Math.min(frame.height - 1, (comp.maxY + 1) * step - 1),
      contour: hull(comp.boundary).map((p) => ({ x: p.x * step, y: p.y * step })),
    };
    const normalized = normalizeComponent(compNorm, frame.width, frame.height, {
      heuristic: true,
      motion: source === 'motion',
    });
    if (normalized) detections.push(normalized);
  }
  return pickBest(detections);
}

function isSkin(r, g, b) {
  // Reject near-black and blown-out highlights early.
  if (r + g + b < 60) return false;
  if (r > 245 && g > 245 && b > 245) return false;

  // Normalized-RGB rule: skin is warm but not saturated red.
  const warm = r > 60 && g > 30 && b > 15
    && r > g && r > b
    && (r - g) > 6 && (r - b) > 8
    && (r - Math.min(g, b)) > 10;

  // YCbCr rule: standard skin chroma box.
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const chroma = cb >= 74 && cb <= 136 && cr >= 126 && cr <= 180;

  return warm || chroma;
}

function morph(mask, W, H, op) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let on = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          on += mask[yy * W + xx];
        }
      }
      const centre = mask[y * W + x];
      // open = erode then dilate, close = dilate then erode
      out[y * W + x] = op === 'open' ? (on >= 6 ? 1 : 0) : (on >= 3 ? 1 : 0);
    }
  }
  // Second pass completes the operation.
  const final = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let on = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          on += out[yy * W + xx];
        }
      }
      final[y * W + x] = op === 'open' ? (on >= 3 ? 1 : 0) : (on >= 6 ? 1 : 0);
    }
  }
  mask.set(final);
}

function connectedComponents(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  const out = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail += 1] = start;
    seen[start] = 1;

    let area = 0;
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    const boundary = [];

    while (head < tail) {
      const idx = queue[head += 1];
      const x = idx % W;
      const y = (idx / W) | 0;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const neighbours = [idx - 1, idx + 1, idx - W, idx + W];
      let edge = x === 0 || x === W - 1 || y === 0 || y === H - 1;
      for (const n of neighbours) {
        if (n >= 0 && n < mask.length && mask[n]) {
          if (!seen[n]) { seen[n] = 1; queue[tail += 1] = n; }
        } else {
          edge = true;
        }
      }
      if (edge) boundary.push({ x, y });
    }

    out.push({ area, minX, minY, maxX, maxY, boundary });
  }
  return out;
}

function hull(points) {
  if (!points || points.length < 3) return points || [];
  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const out = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (out.length <= 40) return out;
  const stride = Math.ceil(out.length / 40);
  return out.filter((_, i) => i % stride === 0);
}

// ---------------------------------------------------------------------------
// Selection + smoothing
// ---------------------------------------------------------------------------

function pickBest(detections) {
  const hands = detections.filter((d) => d.kind === 'hand').sort((a, b) => b.score - a.score);
  const people = detections.filter((d) => d.kind === 'person').sort((a, b) => b.score - a.score);
  const out = [];
  if (hands[0]) out.push(hands[0]);
  if (people[0]) out.push(people[0]);
  return out;
}

function smooth(detections) {
  const next = { hand: null, person: null };
  for (const d of detections) {
    if (d.kind === 'hand' || d.kind === 'person') next[d.kind] = d;
  }

  const out = [];
  for (const kind of ['hand', 'person']) {
    const fresh = next[kind];
    const prev = memory[kind];
    if (fresh) {
      memory[kind] = prev ? blend(prev, fresh) : fresh;
      memory[`${kind}Misses`] = 0;
      out.push(memory[kind]);
    } else if (prev && memory[`${kind}Misses`] < MAX_MISSES) {
      memory[`${kind}Misses`] += 1;
      out.push({ ...prev, score: prev.score * 0.8 });
    } else {
      memory[kind] = null;
      memory[`${kind}Misses`] = 0;
    }
  }
  return out;
}

function blend(prev, next) {
  const mix = (a, b) => a + (b - a) * SMOOTH_ALPHA;
  return {
    ...next,
    score: mix(prev.score, next.score),
    boundingBox: {
      xMin: mix(prev.boundingBox.xMin, next.boundingBox.xMin),
      yMin: mix(prev.boundingBox.yMin, next.boundingBox.yMin),
      xMax: mix(prev.boundingBox.xMax, next.boundingBox.xMax),
      yMax: mix(prev.boundingBox.yMax, next.boundingBox.yMax),
    },
    box: {
      x: mix(prev.box.x, next.box.x),
      y: mix(prev.box.y, next.box.y),
      width: mix(prev.box.width, next.box.width),
      height: mix(prev.box.height, next.box.height),
    },
    contour: next.contour || prev.contour,
  };
}
