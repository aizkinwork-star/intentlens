// scripts/tracking-scenes.mjs — synthetic scenes shared by the tracking
// benchmark (scripts/bench-tracking.mjs) and trackingBenchmark.test.js.
//
// Frames are plain RGBA buffers, so no browser or camera is involved. The
// scenes deliberately stress the failure modes of a colour/shape tracker:
// dimming lights, an occlusion, a similar distractor, and a size change.

export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 240;
export const STEP_MS = 100;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TARGET_COLOURS = [[228, 48, 36], [32, 206, 226]];
const DISTRACTOR_COLOURS = [[44, 182, 72], [214, 198, 44]];

function paintPatch(data, x0, y0, x1, y1, colours, cell, alpha, rand) {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(FRAME_HEIGHT, Math.ceil(y1)); y += 1) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(FRAME_WIDTH, Math.ceil(x1)); x += 1) {
      const cx = Math.floor((x - x0) / cell);
      const cy = Math.floor((y - y0) / cell);
      const colour = colours[((cx + cy) % colours.length + colours.length) % colours.length];
      const jitter = 0.94 + rand() * 0.12;
      const i = (y * FRAME_WIDTH + x) * 4;
      data[i] = Math.min(255, colour[0] * alpha * jitter);
      data[i + 1] = Math.min(255, colour[1] * alpha * jitter);
      data[i + 2] = Math.min(255, colour[2] * alpha * jitter);
      data[i + 3] = 255;
    }
  }
}

/** Build one frame. `opacity` is a blend toward black, like the training stages. */
export function makeFrame({ target = null, distractor = null, opacity = 1, seed = 1 } = {}) {
  const data = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);
  const rand = mulberry32(seed);
  // Cluttered bench-like background: dark, slightly uneven, low contrast.
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const i = (y * FRAME_WIDTH + x) * 4;
      const vignette = 1 - 0.25 * Math.hypot(x / FRAME_WIDTH - 0.5, y / FRAME_HEIGHT - 0.5);
      const base = (28 + 10 * vignette) * opacity;
      data[i] = base;
      data[i + 1] = base + 4 * opacity;
      data[i + 2] = base + 7 * opacity;
      data[i + 3] = 255;
    }
  }
  if (distractor) {
    paintPatch(data, distractor.x * FRAME_WIDTH, distractor.y * FRAME_HEIGHT,
      (distractor.x + distractor.width) * FRAME_WIDTH, (distractor.y + distractor.height) * FRAME_HEIGHT,
      DISTRACTOR_COLOURS, 8, opacity, rand);
  }
  if (target) {
    paintPatch(data, target.x * FRAME_WIDTH, target.y * FRAME_HEIGHT,
      (target.x + target.width) * FRAME_WIDTH, (target.y + target.height) * FRAME_HEIGHT,
      TARGET_COLOURS, 8, opacity, rand);
  }
  return { data, width: FRAME_WIDTH, height: FRAME_HEIGHT };
}

/** Intersection-over-union of two normalized boxes. */
export function iou(a, b) {
  if (!a || !b) return 0;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

export const BASE_BOX = { x: 0.12, y: 0.36, width: 0.14, height: 0.18 };

function at(box, dx, dy, scale = 1) {
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2 + dy;
  const w = box.width * scale;
  const h = box.height * scale;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/**
 * Build a full scenario. Options:
 *   opacity       steady lighting (1 = clean)
 *   opacityAfter  dim the scene after frame 6
 *   occlude       [first, last] frame indexes where the target is hidden
 *   distractor    draw a similar object crossing near the target
 *   scaleTo       final target scale
 *   frames        number of moving frames (default 30)
 */
export function sequence({
  opacity = 1,
  driftX = 0.22,
  opacityAfter = null,
  occlude = null,
  scaleTo = 1,
  distractor = false,
  frames = 30,
} = {}) {
  const out = [{ frame: makeFrame({ target: BASE_BOX, opacity, seed: 1 }), truth: BASE_BOX }];
  for (let step = 1; step <= frames; step += 1) {
    const t = step / frames;
    const truth = at(BASE_BOX, driftX * t, 0.05 * Math.sin(t * Math.PI * 2), 1 + (scaleTo - 1) * t);
    const dim = opacityAfter !== null && step > 6 ? opacityAfter : opacity;
    const hidden = Boolean(occlude && step >= occlude[0] && step <= occlude[1]);
    const distractorBox = distractor && step > 8 ? at(BASE_BOX, driftX * t + 0.16, -0.10) : null;
    out.push({
      frame: makeFrame({ target: hidden ? null : truth, distractor: distractorBox, opacity: dim, seed: step }),
      truth: hidden ? null : truth,
    });
  }
  return out;
}

export const SCENARIOS = {
  'clean light': () => sequence({}),
  'lights drop to 60%': () => sequence({ opacityAfter: 0.6 }),
  'lights drop to 40%': () => sequence({ opacityAfter: 0.4 }),
  'steady 50% light': () => sequence({ opacity: 0.5 }),
  'occlusion and return': () => sequence({ occlude: [12, 17] }),
  'similar distractor': () => sequence({ distractor: true }),
  'size change': () => sequence({ scaleTo: 0.82 }),
};

/**
 * Run one scenario through a freshly initialized tracker.
 * Returns { visibleFrames, trackedRate, meanIou, hiddenFrames, falseTrackRate, recoveryFrames }.
 */
export function runSequence(frames, { TargetTracker, onFrame } = {}) {
  const first = frames[0];
  const tracker = new TargetTracker({ frameWidth: FRAME_WIDTH, frameHeight: FRAME_HEIGHT });
  const appearance = TargetTracker.buildAppearance(first.frame, first.truth);
  tracker.init({
    targetId: 'component',
    anchor: { x: first.truth.x + first.truth.width / 2, y: first.truth.y + first.truth.height / 2 },
    box: first.truth,
    appearance,
  });

  let now = 1000;
  const visible = [];
  const hidden = [];
  let recoveredAt = null;
  let sinceReappear = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const entry = frames[index];
    now += STEP_MS;
    const snap = tracker.update(entry.frame, now);
    if (onFrame) onFrame(index, entry, snap);
    if (entry.truth) {
      const score = iou(snap?.box, entry.truth);
      visible.push({ score, state: snap?.state });
      if (hidden.length > 0) {
        sinceReappear += 1;
        if (recoveredAt === null && score > 0.35) recoveredAt = sinceReappear;
      }
    } else {
      hidden.push({ state: snap?.state, confidence: snap?.confidence });
    }
  }
  const tracked = visible.filter((v) => v.score > 0.35 && ['TRACKING', 'LOW_CONFIDENCE'].includes(v.state)).length;
  const meanIou = visible.reduce((sum, v) => sum + v.score, 0) / Math.max(1, visible.length);
  const falseTrack = hidden.filter((h) => h.state === 'TRACKING' && (h.confidence ?? 0) > 0.55).length;
  return {
    visibleFrames: visible.length,
    trackedRate: tracked / Math.max(1, visible.length),
    meanIou,
    hiddenFrames: hidden.length,
    falseTrackRate: hidden.length ? falseTrack / hidden.length : 0,
    recoveryFrames: recoveredAt,
  };
}
