// tracker.js — one-target local outline tracking, browser-side only.
// §8 of the architecture: colour similarity + contour/shape + short-range
// frame-to-frame motion. NO per-frame AI calls.
//
// State machine: INACTIVE → INITIALIZING → TRACKING → LOW_CONFIDENCE →
// LOST → REACQUIRING → TRACKING
//
// Coordinates are normalized 0..1 relative to the frame the target came from.
// The tracker never claims a target is still in frame after it loses it.

export const TRACKER_STATES = [
  'INACTIVE', 'INITIALIZING', 'TRACKING', 'LOW_CONFIDENCE', 'LOST', 'REACQUIRING',
];

// How often to run the expensive pixel analysis (ms). Preview renders independently.
export const TRACK_INTERVAL_MS = 100; // ~10 updates/second, tunable
// Analysis is done on a downscaled copy so an old laptop stays responsive.
export const ANALYSIS_WIDTH = 320;
export const ANALYSIS_HEIGHT = 240;
// Half-width of the appearance template, in analysis pixels. `_search` samples
// exactly this patch, so the reference must be built at the same size.
export const TEMPLATE_RADIUS = 12;

// ---------------------------------------------------------------------------
// Small image helpers (pixels)
// ---------------------------------------------------------------------------

// Colour histogram of an ImageData. 8x8 bins over chromaticity (r/s, g/s),
// where s = r + g + b. Dividing by the pixel sum removes exposure changes, so a
// gradual or sudden dimming does not move the descriptor the way it moves a
// plain RGB histogram. Near-black pixels (unstable hue) share one bin.
function colourHistogram(imageData) {
  const { data } = imageData;
  const hist = new Uint32Array(64);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const sum = r + g + b;
    n += 1;
    if (sum < 18) {
      hist[63] += 1;
      continue;
    }
    const rb = Math.min(7, (r / sum * 8) | 0);
    const gb = Math.min(7, (g / sum * 8) | 0);
    hist[(rb << 3) | gb] += 1;
  }
  const total = n || 1;
  return Array.from(hist, (v) => v / total);
}

// Bhattacharyya affinity of two histograms (1 = identical, 0 = disjoint).
function histAffinity(a, b) {
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += Math.sqrt(a[i] * b[i]);
  return sum;
}

// Extract a rectangular region (x,y,w,h in pixels) from an ImageData.
function regionImageData(imageData, x, y, w, h) {
  const { data, width } = imageData;
  const out = new Uint8ClampedArray(Math.max(1, Math.round(w)) * Math.max(1, Math.round(h)) * 4);
  let k = 0;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const maxY = imageData.height;
  const y1 = Math.min(maxY, Math.ceil(y + h));
  for (let iy = y0; iy < y1; iy++) {
    const base = (iy * width + x0) * 4;
    const len = (x1 - x0) * 4;
    for (let j = 0; j < len; j++) out[k++] = data[base + j];
  }
  return { data: out, width: x1 - x0, height: y1 - y0 };
}

// Grayscale patch: downsample region [x,x+w]x[y,y+h] to outW x outH, mean-normalised.
function grayscalePatch(imageData, x, y, w, h, outW, outH) {
  const { data, width, height } = imageData;
  const patch = new Float32Array(outW * outH);
  let k = 0;
  for (let ty = 0; ty < outH; ty++) {
    const sy = y + (ty / outH) * h;
    const siy = Math.min(height - 1, Math.max(0, Math.floor(sy)));
    for (let tx = 0; tx < outW; tx++) {
      const sx = x + (tx / outW) * w;
      const six = Math.min(width - 1, Math.max(0, Math.floor(sx)));
      const i = (siy * width + six) * 4;
      patch[k++] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  let mean = 0;
  for (let i = 0; i < patch.length; i++) mean += patch[i];
  mean /= patch.length;
  let norm = 0;
  for (let i = 0; i < patch.length; i++) {
    const v = patch[i] - mean;
    patch[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < patch.length; i++) patch[i] /= norm;
  return patch;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Cosine similarity of two unit-normalised patches (1 = identical).
function patchSimilarity(a, b) {
  return Math.max(0, dot(a, b));
}

// Renormalise a histogram so Bhattacharyya affinity stays on the same scale.
function normalizeHistogram(hist) {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total <= 0) return hist;
  return hist.map((value) => value / total);
}

// Blend two unit-normalised patches and keep the result unit-length.
function unitBlend(a, b, alpha) {
  const out = new Float32Array(a.length);
  let norm = 0;
  for (let i = 0; i < a.length; i++) {
    const value = a[i] * (1 - alpha) + b[i] * alpha;
    out[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// Downscale src ImageData to outW x outH (nearest neighbour).
function downscale(src, outW, outH) {
  const { data, width, height } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = width / outW;
  const sy = height / outH;
  for (let oy = 0; oy < outH; oy++) {
    const syi = Math.min(height - 1, Math.floor(oy * sy));
    for (let ox = 0; ox < outW; ox++) {
      const sxi = Math.min(width - 1, Math.floor(ox * sx));
      const i = (syi * width + sxi) * 4;
      const o = (oy * outW + ox) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

// Box overlap (IoU) of two normalized boxes.
function boxOverlap(a, b) {
  const x0 = Math.max(a.x, b.x);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y0 = Math.max(a.y, b.y);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// TargetTracker
// ---------------------------------------------------------------------------

// Multi-target tracker: manages a set of TargetTracker instances keyed by targetId.
export class MultiTargetTracker {
  constructor() {
    this.trackers = new Map();
    this.onStateChange = () => {};
  }

  addTarget(targetId, init) {
    const t = new TargetTracker();
    t.onStateChange = (state) => this.onStateChange({ targetId, state });
    t.init({ targetId, ...init });
    this.trackers.set(targetId, t);
    return t;
  }

  removeTarget(targetId) {
    const t = this.trackers.get(targetId);
    if (t) { t.reset(); this.trackers.delete(targetId); }
  }

  update(imageData, now = Date.now()) {
    const results = [];
    for (const [id, t] of this.trackers) {
      try {
        const r = t.update(imageData, now);
        results.push({ targetId: id, ...r });
      } catch (e) {
        results.push({ targetId: id, state: 'error', error: e?.message });
      }
    }
    return results;
  }

  reset() {
    for (const t of this.trackers.values()) t.reset();
    this.trackers.clear();
  }

  get size() { return this.trackers.size; }
}

export class TargetTracker {
  constructor({ frameWidth, frameHeight, onStateChange } = {}) {
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    this.onStateChange = onStateChange;

    this.state = 'INACTIVE';
    this.targetId = null;
    this.confidence = null;
    this.anchor = null;   // {x, y} normalized
    this.box = null;      // {x, y, width, height} normalized
    this.lastBox = null;
    this.smoothedBox = null;

    this.hist = null;      // chromaticity histogram of the target
    this.template = null;  // grayscale template patch

    this.smoothAlpha = 0.5;
    this.searchHalf = 0.12;
    this.velocity = { x: 0, y: 0 }; // normalized units per update
    this._lastRun = 0;
    this.STABLE_MS = 600;
    this.stableSince = null;
    this._appearanceBuilt = false;
    // Only blend the appearance model when the match is strong; a weak match
    // would poison the reference and make the next frame worse.
    this.appearanceAlpha = 0.08;
    this.appearanceUpdateScore = 0.82;
  }

  // Build an appearance model from a target crop.
  // imageData: frame ImageData; box: normalized target box within it.
  // Pass the analysis-sized frame (see `update`) so the template covers the
  // same number of pixels the search will compare against.
  static buildAppearance(imageData, box) {
    const { width: fW, height: fH } = imageData;
    // Histogram over the target region only.
    const region = regionImageData(imageData, box.x * fW, box.y * fH, box.width * fW, box.height * fH);
    const hist = colourHistogram(region);
    // Template centred on the box, at the fixed search-patch size.
    const cx = (box.x + box.width / 2) * fW;
    const cy = (box.y + box.height / 2) * fH;
    const side = TEMPLATE_RADIUS * 2;
    const template = grayscalePatch(imageData, cx - TEMPLATE_RADIUS, cy - TEMPLATE_RADIUS, side, side, 24, 24);
    return { hist, template };
  }

  // Initialization: called once the AI has proposed the initial target.
  init({ targetId, anchor, box, appearance }) {
    this.targetId = targetId;
    this.anchor = { x: anchor.x, y: anchor.y };
    this.box = { x: box.x, y: box.y, width: box.width, height: box.height };
    this.lastBox = { ...this.box };
    this.smoothedBox = { ...this.box };
    // Scale is searched relative to the size seen at init, never relative to the
    // previous frame. Chaining relative steps made the box shrink every frame.
    this.baseWidth = box.width;
    this.baseHeight = box.height;
    this.scale = 1;

    if (appearance) {
      this.hist = appearance.hist;
      this.template = appearance.template;
      this._appearanceBuilt = true;
    } else {
      // Reused tracker: drop the previous target's appearance and rebuild it
      // from the first analysed frame at analysis scale.
      this.hist = null;
      this.template = null;
      this._appearanceBuilt = false;
    }
    this.velocity = { x: 0, y: 0 };
    this._lastRun = 0;
    this.confidence = 1.0;
    this.stableSince = null;
    this._setState('TRACKING');
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    // Stability is a property of a continuous TRACKING run; reacquiring must
    // not inherit the timer from before the target was lost.
    if (next !== 'TRACKING') this.stableSince = null;
    if (this.onStateChange) this.onStateChange({ prev, next, targetId: this.targetId });
  }

  // Feed a new frame (ImageData of the full frame; box space is normalized 0..1).
  // `now` defaults to performance.now(); tests can pass a synthetic clock.
  // Returns { state, confidence, anchor, box } or null when inactive.
  update(imageData, now = performance.now()) {
    if (this.state === 'INACTIVE') return null;

    if (this._lastRun !== 0 && now - this._lastRun < TRACK_INTERVAL_MS) {
      return this._currentSnapshot();
    }
    this._lastRun = now;

    const small = downscale(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    // Build the appearance model from the first analysed frame, so the
    // histogram and the template are sampled at the same scale as the search.
    // Building it from a high-resolution frame used to make template similarity
    // depend on camera resolution.
    if (!this._appearanceBuilt && this.box) {
      const app = TargetTracker.buildAppearance(small, this.box);
      this.hist = app.hist;
      this.template = app.template;
      this._appearanceBuilt = true;
    }

    const predicted = this._predictedBox();
    const search = this._searchWindow(predicted);

    const best = this._search(small, search, predicted);
    if (!best) {
      this.velocity.x *= 0.5;
      this.velocity.y *= 0.5;
      // No candidate cleared the floor. Stop claiming TRACKING immediately:
      // the module's contract is that it never over-claims a lost target.
      this.confidence = Math.max(0, Math.min(this.confidence ?? 0, 0.54) - 0.15);
      if (this.state === 'TRACKING' || this.state === 'LOW_CONFIDENCE') this._setState('LOW_CONFIDENCE');
      if (this.confidence < 0.30) this._setState('LOST');
      if (this.state === 'LOST') this._setState('REACQUIRING');
      return this._currentSnapshot();
    }

    const { box: candBox } = best;
    const scoreCombined = 0.45 * best.hist + 0.35 * best.tmpl + 0.20 * best.overlap;
    const previous = this.smoothedBox ? { ...this.smoothedBox } : { ...candBox };

    this.smoothedBox = {
      x: this.smoothAlpha * candBox.x + (1 - this.smoothAlpha) * previous.x,
      y: this.smoothAlpha * candBox.y + (1 - this.smoothAlpha) * previous.y,
      width: this.smoothAlpha * candBox.width + (1 - this.smoothAlpha) * previous.width,
      height: this.smoothAlpha * candBox.height + (1 - this.smoothAlpha) * previous.height,
    };
    // Velocity is a short-memory average of the smoothed displacement, capped so
    // one bad match cannot throw the next search window off the target.
    const vx = Math.max(-0.04, Math.min(0.04, this.smoothedBox.x - previous.x));
    const vy = Math.max(-0.04, Math.min(0.04, this.smoothedBox.y - previous.y));
    this.velocity.x = 0.55 * this.velocity.x + 0.45 * vx;
    this.velocity.y = 0.55 * this.velocity.y + 0.45 * vy;

    this.box = { ...this.smoothedBox };
    this.lastBox = previous;
    this.anchor = { x: this.box.x + this.box.width / 2, y: this.box.y + this.box.height / 2 };

    this.confidence = Math.min(1, Math.max(0, scoreCombined));
    if (scoreCombined >= this.appearanceUpdateScore && best.overlap > 0.35) {
      this._blendAppearance(best.cHist, best.cTmpl);
    }

    if (this.state === 'REACQUIRING') this._setState('TRACKING');
    else if (this.state === 'LOW_CONFIDENCE' && this.confidence >= 0.65) this._setState('TRACKING');
    else if (this.state === 'TRACKING' && this.confidence < 0.55) this._setState('LOW_CONFIDENCE');

    return this._currentSnapshot();
  }

  /** Blend a confident observation into the reference appearance (slow EMA). */
  _blendAppearance(hist, template) {
    if (hist && this.hist) {
      const alpha = this.appearanceAlpha;
      this.hist = normalizeHistogram(this.hist.map((value, index) => value * (1 - alpha) + hist[index] * alpha));
    }
    if (template && this.template) {
      this.template = unitBlend(this.template, template, this.appearanceAlpha);
    }
  }

  _predictedBox() {
    if (!this.smoothedBox) return { ...(this.box || { x: 0, y: 0, width: 0.06, height: 0.06 }) };
    return {
      x: Math.max(0, Math.min(1 - this.smoothedBox.width, this.smoothedBox.x + this.velocity.x)),
      y: Math.max(0, Math.min(1 - this.smoothedBox.height, this.smoothedBox.y + this.velocity.y)),
      width: this.smoothedBox.width,
      height: this.smoothedBox.height,
    };
  }

  // Widen the search window when reacquiring a lost/uncertain target (§8.3).
  _searchHalf() {
    if (this.state === 'REACQUIRING') return 0.5;
    if (this.state === 'LOW_CONFIDENCE') return 0.2;
    return this.searchHalf;
  }

  _searchWindow(box) {
    const hw = this._searchHalf();
    return {
      x0: Math.max(0, box.x - hw),
      y0: Math.max(0, box.y - hw),
      x1: Math.min(1, box.x + box.width + hw),
      y1: Math.min(1, box.y + box.height + hw),
    };
  }

  /**
   * Score one candidate centre and box size. Returns null when the candidate is
   * outside the frame or below the acceptance floor.
   */
  _scoreCandidate(small, cx, cy, bw, bh, predicted) {
    const radius = TEMPLATE_RADIUS;
    const ax = cx * ANALYSIS_WIDTH;
    const ay = cy * ANALYSIS_HEIGHT;
    if (ax < radius || ax > ANALYSIS_WIDTH - radius || ay < radius || ay > ANALYSIS_HEIGHT - radius) return null;

    const bx = ax - bw / 2;
    const by = ay - bh / 2;
    if (bx < 0 || by < 0 || bx + bw > ANALYSIS_WIDTH || by + bh > ANALYSIS_HEIGHT) return null;

    const cHist = colourHistogram(regionImageData(small, bx, by, bw, bh));
    const hMatch = this.hist ? histAffinity(this.hist, cHist) : 0.5;

    const cTmpl = grayscalePatch(small, ax - radius, ay - radius, radius * 2, radius * 2, 24, 24);
    const tMatch = this.template ? patchSimilarity(this.template, cTmpl) : 0.5;

    const candBox = {
      x: bx / ANALYSIS_WIDTH,
      y: by / ANALYSIS_HEIGHT,
      width: bw / ANALYSIS_WIDTH,
      height: bh / ANALYSIS_HEIGHT,
    };
    const overlap = boxOverlap(candBox, predicted);
    const score = 0.45 * hMatch + 0.35 * tMatch + 0.20 * overlap;
    if (score <= 0.42) return null;
    return { score, overlap, hist: hMatch, tmpl: tMatch, box: candBox, centre: { cx, cy }, cHist, cTmpl };
  }

  _search(small, win, predicted = this._predictedBox()) {
    // Size is always expressed relative to the init size, so the box cannot
    // creep smaller (or larger) frame after frame.
    const baseW = (this.baseWidth ?? this.box?.width ?? 0.06) * ANALYSIS_WIDTH;
    const baseH = (this.baseHeight ?? this.box?.height ?? 0.06) * ANALYSIS_HEIGHT;
    let best = null;
    const consider = (cx, cy, scale) => {
      const candidate = this._scoreCandidate(small, cx, cy, baseW * scale, baseH * scale, predicted);
      if (candidate && (!best || candidate.score > best.score)) best = { ...candidate, scale };
    };

    const startScale = this.scale || 1;
    // Coarse pass over the search window.
    for (let cy = win.y0; cy <= win.y1; cy += 0.02) {
      for (let cx = win.x0; cx <= win.x1; cx += 0.02) consider(cx, cy, startScale);
    }
    if (!best) return null;

    // Fine pass around the winner: 0.02 steps are too coarse for a stable box.
    const { cx, cy } = best.centre;
    for (let dy = -0.010; dy <= 0.0101; dy += 0.005) {
      for (let dx = -0.010; dx <= 0.0101; dx += 0.005) consider(cx + dx, cy + dy, startScale);
    }

    // Scale pass: components grow/shrink as the phone moves closer/further.
    // Sizes are absolute (relative to the init size), so a scale change cannot
    // ratchet the box smaller. Hysteresis: a different size must be clearly
    // better, otherwise flat scores make the box flicker.
    const SCALE_MARGIN = 0.03;
    let refined = best;
    for (const factor of [0.92, 1.08, 0.84, 1.16]) {
      const candidate = this._scoreCandidate(small, best.centre.cx, best.centre.cy,
        baseW * startScale * factor, baseH * startScale * factor, predicted);
      if (!candidate) continue;
      if (candidate.score > refined.score + SCALE_MARGIN) refined = { ...candidate, scale: startScale * factor };
    }
    this.scale = Math.max(0.6, Math.min(1.7, refined.scale));
    return refined;
  }

  _currentSnapshot() {
    return {
      state: this.state,
      targetId: this.targetId,
      confidence: this.confidence,
      anchor: this.anchor ? { ...this.anchor } : null,
      box: this.box ? { ...this.box } : null,
    };
  }

  readyToCapture() {
    if (this.state !== 'TRACKING' || !this.box) return false;
    const now = performance.now();
    if (!this.stableSince) { this.stableSince = now; return false; }
    return now - this.stableSince >= this.STABLE_MS;
  }

  lose() {
    this.confidence = 0;
    this._setState('LOST');
  }

  reset() {
    this._setState('INACTIVE');
    this.targetId = null;
    this.confidence = null;
    this.anchor = null;
    this.box = null;
    this.lastBox = null;
    this.smoothedBox = null;
    this.hist = null;
    this.template = null;
    this.stableSince = null;
    this._appearanceBuilt = false;
  }

  // ---------------------------------------------------------------------------
  // Optional hand-outline & silhouette detection.
  // Detects:
  //   1. Hand / pointer silhouette (neon green)
  //   2. Admin / operator silhouette (neon purple)
  //   3. Chip & board component outlines (cyan, gold, silver, amber per kind)
  // ---------------------------------------------------------------------------
  detectHandOutline(imageData) {
    if (!handOutlineEnabled) return null;
    const { hand } = this.detectSilhouettesAndChips(imageData);
    return hand;
  }

  // skin=false skips the pixel scan. handTracker.js owns hand/person detection
  // now, so the loop only asks this method for chip boxes when skin is off.
  detectSilhouettesAndChips(imageData, knownComponents = [], { skin = true } = {}) {
    const { data, width, height } = imageData;

    let handMinX = width, handMinY = height, handMaxX = 0, handMaxY = 0, handCount = 0;
    let adminMinX = width, adminMinY = height, adminMaxX = 0, adminMaxY = 0, adminCount = 0;

    // Sample pixels across frame with step 4 for 60fps performance
    for (let y = 0; skin && y < height; y += 4) {
      for (let x = 0; skin && x < width; x += 4) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];

        // Multi-condition skin & silhouette classifier:
        // 1. Broad normalized RGB heuristic for warm/fluorescent lighting
        const c1 = r > 70 && g > 35 && b > 20 && r > g && (r - g) > 8 && (r - b) > 8;
        // 2. YCbCr standard human skin/silhouette distribution
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const c2 = cb >= 75 && cb <= 135 && cr >= 128 && cr <= 178;

        if (c1 || c2) {
          // If in upper half and relatively broad, contributes to Admin / Operator silhouette
          if (adminSilhouetteEnabled && y < height * 0.55) {
            if (x < adminMinX) adminMinX = x;
            if (x > adminMaxX) adminMaxX = x;
            if (y < adminMinY) adminMinY = y;
            if (y > adminMaxY) adminMaxY = y;
            adminCount += 1;
          }

          // Hand / pointer: typically enters from lower or side edges
          if (handOutlineEnabled) {
            if (x < handMinX) handMinX = x;
            if (x > handMaxX) handMaxX = x;
            if (y < handMinY) handMinY = y;
            if (y > handMaxY) handMaxY = y;
            handCount += 1;
          }
        }
      }
    }

    let hand = null;
    if (handOutlineEnabled && handCount >= 20 && handMaxX > handMinX && handMaxY > handMinY) {
      const pad = 12;
      hand = {
        x: Math.max(0, (handMinX - pad) / width),
        y: Math.max(0, (handMinY - pad) / height),
        width: Math.min(1, (handMaxX - handMinX + 2 * pad) / width),
        height: Math.min(1, (handMaxY - handMinY + 2 * pad) / height),
        kind: 'hand',
        label: 'Hand / Pointer',
        color: OBJECT_COLORS.hand,
        count: handCount,
      };
    }

    let admin = null;
    if (adminSilhouetteEnabled && adminCount >= 35 && adminMaxX > adminMinX && adminMaxY > adminMinY) {
      const pad = 16;
      admin = {
        x: Math.max(0, (adminMinX - pad) / width),
        y: Math.max(0, (adminMinY - pad) / height),
        width: Math.min(1, (adminMaxX - adminMinX + 2 * pad) / width),
        height: Math.min(1, (adminMaxY - adminMinY + 2 * pad) / height),
        kind: 'admin',
        label: 'Admin Silhouette',
        color: OBJECT_COLORS.admin,
        count: adminCount,
      };
    }

    // Chip & Component outlines with distinct colors
    const chips = [];
    if (chipOutlineEnabled && Array.isArray(knownComponents)) {
      for (const comp of knownComponents) {
        if (!comp || comp.x == null || comp.y == null || !comp.w || !comp.h) continue;
        const color = OBJECT_COLORS[comp.kind] || OBJECT_COLORS.chip;
        chips.push({
          x: Math.max(0, comp.x - comp.w / 2),
          y: Math.max(0, comp.y - comp.h / 2),
          width: comp.w,
          height: comp.h,
          kind: comp.kind || 'chip',
          label: comp.label || comp.id,
          id: comp.id,
          color,
        });
      }
    }

    return { hand, admin, chips };
  }
}

export const OBJECT_COLORS = {
  chip: '#00e5ff',     // Electric Cyan for IC Chips
  conn: '#ffd700',     // Gold for Connectors
  shield: '#a0aec0',   // Silver for Metal Shields
  port: '#ff7700',     // Amber for Ports & Passives
  hand: '#00ff88',     // Neon Green for Hand / Pointer
  admin: '#e056fd',    // Neon Purple for Admin Silhouette
  target: '#ff2a5f',   // Coral Red for Active Target
};

export let handOutlineEnabled = false;
export function setHandOutline(enabled) {
  handOutlineEnabled = Boolean(enabled);
}

export let adminSilhouetteEnabled = false;
export function setAdminSilhouette(enabled) {
  adminSilhouetteEnabled = Boolean(enabled);
}

export let chipOutlineEnabled = false;
export function setChipOutline(enabled) {
  chipOutlineEnabled = Boolean(enabled);
}
