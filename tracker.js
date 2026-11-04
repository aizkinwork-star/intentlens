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

// ---------------------------------------------------------------------------
// Small image helpers (pixels)
// ---------------------------------------------------------------------------

// Colour histogram of an ImageData: 4x4x4 = 64 buckets, normalised to sum to 1.
function colourHistogram(imageData) {
  const { data } = imageData;
  const hist = new Uint32Array(64);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] >> 6;
    const g = data[i + 1] >> 6;
    const b = data[i + 2] >> 6;
    hist[(r << 4) | (g << 2) | b] += 1;
    n += 1;
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

    this.hist = null;      // colour histogram of the target
    this.template = null;  // grayscale template patch

    this.smoothAlpha = 0.35;
    this.searchHalf = 0.12;
    this._lastRun = 0;
    this.STABLE_MS = 600;
    this.stableSince = null;
    this._appearanceBuilt = false;
  }

  // Build an appearance model from a target crop.
  // imageData: full frame ImageData; box: normalized target box within it.
  static buildAppearance(imageData, box) {
    const { width: fW, height: fH } = imageData;
    // Histogram over the target region only.
    const region = regionImageData(imageData, box.x * fW, box.y * fH, box.width * fW, box.height * fH);
    const hist = colourHistogram(region);
    // Template from the centre of the box.
    const cx = (box.x + box.width / 2) * fW;
    const cy = (box.y + box.height / 2) * fH;
    const tsize = Math.min(box.width, box.height) * 0.5 * Math.min(fW, fH);
    const tx = cx - tsize / 2;
    const ty = cy - tsize / 2;
    const template = grayscalePatch(imageData, tx, ty, tsize, tsize, 24, 24);
    return { hist, template };
  }

  // Initialization: called once the AI has proposed the initial target.
  init({ targetId, anchor, box, appearance }) {
    this.targetId = targetId;
    this.anchor = { x: anchor.x, y: anchor.y };
    this.box = { x: box.x, y: box.y, width: box.width, height: box.height };
    this.lastBox = { ...this.box };
    this.smoothedBox = { ...this.box };

    if (appearance) {
      this.hist = appearance.hist;
      this.template = appearance.template;
      this._appearanceBuilt = true;
    }
    this.confidence = 1.0;
    this.stableSince = null;
    this._setState('TRACKING');
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    if (this.onStateChange) this.onStateChange({ prev, next, targetId: this.targetId });
  }

  // Feed a new frame (ImageData of the full frame; box space is normalized 0..1).
  // `now` defaults to performance.now(); tests can pass a synthetic clock.
  // Returns { state, confidence, anchor, box } or null when inactive.
  update(imageData, now = performance.now()) {
    if (this.state === 'INACTIVE') return null;

    // Build the appearance model from the first frame the target is visible in,
    // unless the caller already supplied one at init().
    if (!this._appearanceBuilt && this.box) {
      const app = TargetTracker.buildAppearance(imageData, this.box);
      this.hist = app.hist;
      this.template = app.template;
      this._appearanceBuilt = true;
    }

    if (this._lastRun !== 0 && now - this._lastRun < TRACK_INTERVAL_MS) {
      return this._currentSnapshot();
    }
    this._lastRun = now;

    const small = downscale(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);

    const predicted = this._predictedBox();
    const search = this._searchWindow(predicted);

    const best = this._search(small, search);
    if (!best) {
      this.confidence = Math.max(0, this.confidence - 0.15);
      if (this.state === 'TRACKING' && this.confidence < 0.55) this._setState('LOW_CONFIDENCE');
      if (this.state === 'LOW_CONFIDENCE' && this.confidence < 0.30) this._setState('LOST');
      if (this.state === 'LOST') this._setState('REACQUIRING');
      return this._currentSnapshot();
    }

    const { box: candBox } = best;
    const scoreCombined = 0.45 * best.hist + 0.35 * best.tmpl + 0.20 * best.overlap;

    this.smoothedBox = {
      x: this.smoothAlpha * candBox.x + (1 - this.smoothAlpha) * this.smoothedBox.x,
      y: this.smoothAlpha * candBox.y + (1 - this.smoothAlpha) * this.smoothedBox.y,
      width: this.smoothAlpha * candBox.width + (1 - this.smoothAlpha) * this.smoothedBox.width,
      height: this.smoothAlpha * candBox.height + (1 - this.smoothAlpha) * this.smoothedBox.height,
    };
    this.box = { ...this.smoothedBox };
    this.lastBox = { ...this.box };
    this.anchor = { x: this.box.x + this.box.width / 2, y: this.box.y + this.box.height / 2 };

    this.confidence = Math.min(1, Math.max(0, scoreCombined));

    if (this.state === 'REACQUIRING') this._setState('TRACKING');
    else if (this.state === 'LOW_CONFIDENCE' && this.confidence >= 0.65) this._setState('TRACKING');
    else if (this.state === 'TRACKING' && this.confidence < 0.55) this._setState('LOW_CONFIDENCE');

    return this._currentSnapshot();
  }

  _predictedBox() {
    if (!this.lastBox || !this.smoothedBox) return { ...this.box };
    const dx = this.smoothedBox.x - this.lastBox.x;
    const dy = this.smoothedBox.y - this.lastBox.y;
    return {
      x: this.smoothedBox.x + dx,
      y: this.smoothedBox.y + dy,
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

  _search(small, win) {
    const patchRadius = 12; // half-width of the template patch in analysis px
    const refHist = this.hist;
    const refTmpl = this.template;

    let best = null;
    // Candidate centres, normalized, stepped over the search window.
    for (let cy = win.y0; cy <= win.y1; cy += 0.02) {
      for (let cx = win.x0; cx <= win.x1; cx += 0.02) {
        const ax = cx * ANALYSIS_WIDTH;
        const ay = cy * ANALYSIS_HEIGHT;
        if (ax < patchRadius || ax > ANALYSIS_WIDTH - patchRadius ||
            ay < patchRadius || ay > ANALYSIS_HEIGHT - patchRadius) continue;

        const bw = (this.box ? this.box.width : 0.06) * ANALYSIS_WIDTH;
        const bh = (this.box ? this.box.height : 0.06) * ANALYSIS_HEIGHT;
        const bx = ax - bw / 2;
        const by = ay - bh / 2;
        if (bx < 0 || by < 0 || bx + bw > ANALYSIS_WIDTH || by + bh > ANALYSIS_HEIGHT) continue;

        const cHist = colourHistogram(regionImageData(small, bx, by, bw, bh));
        const hMatch = refHist ? histAffinity(refHist, cHist) : 0.5;

        const cTmpl = grayscalePatch(small, bx + bw / 2 - patchRadius, by + bh / 2 - patchRadius,
          patchRadius * 2, patchRadius * 2, 24, 24);
        const tMatch = refTmpl ? patchSimilarity(refTmpl, cTmpl) : 0.5;

        const candBox = {
          x: cx - bw / 2 / ANALYSIS_WIDTH,
          y: cy - bh / 2 / ANALYSIS_HEIGHT,
          width: bw / ANALYSIS_WIDTH,
          height: bh / ANALYSIS_HEIGHT,
        };
        const overlap = boxOverlap(candBox, this._predictedBox());

        const combined = 0.45 * hMatch + 0.35 * tMatch + 0.20 * overlap;
        if (combined > 0.42 && (!best || combined > best.score)) {
          best = { score: combined, overlap, hist: hMatch, tmpl: tMatch, box: candBox };
        }
      }
    }
    return best;
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
