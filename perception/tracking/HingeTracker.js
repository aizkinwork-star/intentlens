// perception/tracking/HingeTracker.js — local hinge/articulation tracking.
//
// This answers a narrower question than "understand the scene": is a clamshell
// (laptop lid, fold, hinged case) opening or closing, and by roughly how much?
// It is deliberately local and model-free, so it runs at camera speed on a
// low-power PC and never costs a token.
//
// Two inputs are supported:
//   1. Two board edges per frame, e.g. keypoints returned by a local detector
//      or by a vision model. This is exact and is what the unit tests cover.
//   2. A raw frame, through a coarse dominant-orientation estimator. That is a
//      useful hint, not a calibrated measurement: perspective and lighting can
//      shift it. It is reported with an explicit confidence and never claimed
//      as ground truth.
//
// Coordinates are normalized 0..1. An edge is { near, far }: `near` sits at the
// hinge and `far` points along the board. The lid angle is the angle between
// the two `near -> far` vectors: closed = 0 degrees, flat/open = 180 degrees.

export const HINGE_STATES = ['INACTIVE', 'TRACKING', 'LOW_CONFIDENCE', 'LOST'];

export const HINGE_BANDS = {
  closedMaxDeg: 20,
  openMinDeg: 150,
};

export const DEFAULT_HINGE_OPTIONS = {
  smoothing: 0.35,
  minConfidence: 0.55,
  lostAfterMs: 900,
  minEdgeLength: 0.03,
  maxJumpDeg: 65,
  maxVelocityDegPerSec: 400,
};

function isPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Direction of a 2D edge in degrees, [0, 180). */
export function edgeAngleDeg(edge) {
  if (!edge || !isPoint(edge.a) || !isPoint(edge.b)) return null;
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  if (Math.hypot(dx, dy) < 1e-9) return null;
  let deg = toDeg(Math.atan2(dy, dx));
  if (deg < 0) deg += 180;
  if (deg >= 180) deg -= 180;
  return deg;
}

/** Smallest absolute difference between two undirected angles, [0, 90]. */
export function angleDifferenceDeg(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let diff = Math.abs(((a - b) % 180 + 180) % 180);
  if (diff > 90) diff = 180 - diff;
  return diff;
}

/** Interior angle between two boards that share a hinge. */
export function hingeAngleDeg(upper, lower) {
  const up = boardVector(upper);
  const low = boardVector(lower);
  if (!up || !low) return null;
  const dot = up.x * low.x + up.y * low.y;
  const mags = Math.hypot(up.x, up.y) * Math.hypot(low.x, low.y);
  if (mags < 1e-9) return null;
  return clamp(toDeg(Math.acos(clamp(dot / mags, -1, 1))), 0, 180);
}

function boardVector(edge) {
  if (!edge) return null;
  if (isPoint(edge.near) && isPoint(edge.far)) {
    const dx = edge.far.x - edge.near.x;
    const dy = edge.far.y - edge.near.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len, length: len } : null;
  }
  // Fall back to an {a,b} edge, treating `a` as the hinge end.
  if (isPoint(edge.a) && isPoint(edge.b)) {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { x: dx / len, y: dy / len, length: len } : null;
  }
  return null;
}

/** Geometry-only quality for a pair of board edges, 0..1. */
export function edgeGeometryQuality(upper, lower, { minEdgeLength = DEFAULT_HINGE_OPTIONS.minEdgeLength } = {}) {
  const up = boardVector(upper);
  const low = boardVector(lower);
  if (!up || !low) return 0;
  const shortest = Math.min(up.length, low.length);
  const lengthScore = clamp(shortest / 0.25, 0, 1);
  if (shortest < minEdgeLength) return 0;
  // Very shallow or perfectly straight observations are easy to confuse with
  // a line; do not over-trust them.
  const hinge = hingeAngleDeg(upper, lower);
  const angleScore = hinge == null ? 0 : clamp(hinge / 180, 0.2, 1);
  return clamp(0.75 * lengthScore + 0.25 * angleScore, 0, 1);
}

export function classifyHinge(angleDeg, bands = HINGE_BANDS) {
  if (!Number.isFinite(angleDeg)) return 'unknown';
  if (angleDeg <= bands.closedMaxDeg) return 'closed';
  if (angleDeg >= bands.openMinDeg) return 'open';
  return 'partially_open';
}

// ---------------------------------------------------------------------------
// Coarse frame-only orientation estimate
// ---------------------------------------------------------------------------

function lumaAt(data, i) {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * Find the dominant edge orientations in a frame.
 *
 * Sobel gradients are binned by orientation, weighted by magnitude. Two strong,
 * well-separated peaks are returned. This is intentionally cheap and explainable.
 */
export function dominantOrientations(imageData, { bins = 36, maxSamples = 40000, minMagnitude = 18 } = {}) {
  if (!imageData?.data || !Number.isFinite(imageData.width) || !Number.isFinite(imageData.height)) {
    throw new TypeError('imageData must have { data, width, height }');
  }
  const { data, width, height } = imageData;
  if (width < 3 || height < 3) return { orientations: [], confidence: 0, binsWithSignal: 0 };

  const hist = new Float64Array(bins);
  const step = Math.max(1, Math.floor((width * height) / Math.max(1, maxSamples)));
  let sampled = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (p % step !== 0) continue;
      const i = p * 4;
      const gx = lumaAt(data, i + 4) - lumaAt(data, i - 4);
      const gy = lumaAt(data, i + width * 4) - lumaAt(data, i - width * 4);
      const mag = Math.hypot(gx, gy);
      sampled += 1;
      if (mag < minMagnitude) continue;
      let deg = toDeg(Math.atan2(gy, gx));
      if (deg < 0) deg += 180;
      if (deg >= 180) deg -= 180;
      const bin = Math.min(bins - 1, Math.floor((deg / 180) * bins));
      hist[bin] += mag;
    }
  }

  if (sampled === 0) return { orientations: [], confidence: 0, binsWithSignal: 0 };
  const total = hist.reduce((a, b) => a + b, 0);
  if (total <= 0) return { orientations: [], confidence: 0, binsWithSignal: 0 };

  // Circular smoothing so a peak straddling a bin edge is not split.
  const smooth = new Float64Array(bins);
  for (let i = 0; i < bins; i += 1) {
    smooth[i] = (hist[(i - 1 + bins) % bins] + 2 * hist[i] + hist[(i + 1) % bins]) / 4;
  }

  const peaks = [];
  for (let i = 0; i < bins; i += 1) {
    const prev = smooth[(i - 1 + bins) % bins];
    const next = smooth[(i + 1) % bins];
    if (smooth[i] >= prev && smooth[i] >= next && smooth[i] > 0) {
      peaks.push({ bin: i, deg: ((i + 0.5) / bins) * 180, weight: smooth[i] });
    }
  }
  peaks.sort((a, b) => b.weight - a.weight);

  const maxWeight = peaks[0]?.weight || 0;
  const minSeparationDeg = (180 / bins) * 2;
  const chosen = [];
  for (const peak of peaks) {
    if (peak.weight < maxWeight * 0.25) continue;
    if (chosen.some((p) => angleDifferenceDeg(p.deg, peak.deg) < minSeparationDeg)) continue;
    chosen.push(peak);
    if (chosen.length === 2) break;
  }

  const binsWithSignal = hist.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  if (chosen.length < 2) {
    return {
      orientations: chosen,
      confidence: chosen.length ? clamp(chosen[0].weight / total, 0, 0.4) : 0,
      binsWithSignal,
    };
  }
  const prominence = (chosen[0].weight + chosen[1].weight) / total;
  return {
    orientations: chosen,
    confidence: clamp((prominence - 0.18) / 0.62, 0, 1),
    binsWithSignal,
  };
}

/**
 * Estimate a hinge angle from a raw frame. This is a coarse hint only: it
 * returns `method: 'orientation'` so no caller can present it as calibrated.
 */
export function estimateHingeFromFrame(imageData, options = {}) {
  const { orientations, confidence } = dominantOrientations(imageData, options);
  if (orientations.length < 2) {
    return { angleDeg: null, confidence, orientations, method: 'orientation' };
  }
  const angleDeg = angleDifferenceDeg(orientations[0].deg, orientations[1].deg);
  return { angleDeg, confidence, orientations, method: 'orientation' };
}

// ---------------------------------------------------------------------------
// Stateful tracker
// ---------------------------------------------------------------------------

export class HingeTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULT_HINGE_OPTIONS, ...options };
    this.onStateChange = options.onStateChange || null;
    this.reset();
  }

  reset() {
    this.state = 'INACTIVE';
    this.angleDeg = null;
    this.rawAngleDeg = null;
    this.confidence = 0;
    this.velocityDegPerSec = 0;
    this.lastSeenAt = null;
    this.lastGoodAt = null;
    this.lastTimestamp = null;
    this.missed = 0;
    this.samples = 0;
  }

  _setState(next, timestamp) {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    if (this.onStateChange) this.onStateChange({ previous, next, at: timestamp, angleDeg: this.angleDeg });
  }

  _timestamp(input) {
    if (Number.isFinite(input?.timestamp)) return input.timestamp;
    return Date.now();
  }

  /**
   * Feed one observation.
   *
   * `{ upper, lower, confidence, timestamp }` uses explicit board edges.
   * `{ image, timestamp }` uses the coarse orientation estimator.
   */
  update(input = {}) {
    const timestamp = this._timestamp(input);
    if (this.lastTimestamp != null && timestamp < this.lastTimestamp) {
      // Out-of-order frame: ignore it rather than moving the angle backwards.
      return this.snapshot();
    }
    this.lastTimestamp = timestamp;

    let rawAngle = null;
    let observedConfidence = Number.isFinite(input.confidence) ? clamp(input.confidence, 0, 1) : 1;

    if (input.image) {
      const estimate = estimateHingeFromFrame(input.image, input.options || {});
      rawAngle = estimate.angleDeg;
      observedConfidence = Math.min(observedConfidence, estimate.confidence);
    } else if (input.upper || input.lower) {
      rawAngle = hingeAngleDeg(input.upper, input.lower);
      const geometry = edgeGeometryQuality(input.upper, input.lower, this.options);
      observedConfidence = Math.min(observedConfidence, geometry);
    }

    const valid = Number.isFinite(rawAngle) && observedConfidence >= this.options.minConfidence;

    if (!valid) {
      this.missed += 1;
      const elapsed = this.lastGoodAt == null ? Infinity : timestamp - this.lastGoodAt;
      if (this.state === 'INACTIVE') {
        // Stay idle until something usable appears.
      } else if (elapsed > this.options.lostAfterMs) {
        this._setState('LOST', timestamp);
      } else {
        this._setState('LOW_CONFIDENCE', timestamp);
      }
      return this.snapshot();
    }

    const previousAngle = this.angleDeg;
    const previousGoodAt = this.lastTimestamp === timestamp ? this.lastGoodAt : this.lastGoodAt;

    if (previousAngle == null || this.state === 'INACTIVE' || this.state === 'LOST') {
      this.angleDeg = rawAngle;
      this.velocityDegPerSec = 0;
    } else {
      const dtMs = previousGoodAt != null ? Math.max(1, timestamp - previousGoodAt) : null;
      const candidate = this.angleDeg + this.options.smoothing * (rawAngle - this.angleDeg);
      const jump = Math.abs(candidate - this.angleDeg);
      // A huge single-frame jump is more likely a mis-detection than a lid
      // moving 90 degrees in 100 ms. Clamp it and expose the residual.
      const maxJump = dtMs == null ? this.options.maxJumpDeg : (this.options.maxVelocityDegPerSec * dtMs) / 1000;
      const allowed = Math.min(this.options.maxJumpDeg, Math.max(1, maxJump));
      this.angleDeg = this.angleDeg + clamp(candidate - this.angleDeg, -allowed, allowed);
      if (dtMs != null) {
        this.velocityDegPerSec = ((this.angleDeg - previousAngle) / dtMs) * 1000;
      }
    }

    this.rawAngleDeg = rawAngle;
    this.confidence = observedConfidence;
    this.lastSeenAt = timestamp;
    this.lastGoodAt = timestamp;
    this.missed = 0;
    this.samples += 1;
    this._setState('TRACKING', timestamp);
    return this.snapshot();
  }

  /** Mark a frame with no usable observation (e.g. the board left the view). */
  miss(timestamp = Date.now()) {
    return this.update({ timestamp });
  }

  /** Predict the angle a short time ahead from the current velocity. */
  predict(msAhead = 200) {
    if (this.angleDeg == null) return null;
    return clamp(this.angleDeg + (this.velocityDegPerSec * msAhead) / 1000, 0, 180);
  }

  snapshot() {
    const elapsed = this.lastGoodAt == null ? null : this.lastTimestamp - this.lastGoodAt;
    if (this.state !== 'INACTIVE' && this.state !== 'LOST' && elapsed != null && elapsed > this.options.lostAfterMs) {
      this._setState('LOST', this.lastTimestamp);
    }
    return {
      state: this.state,
      angleDeg: this.angleDeg,
      rawAngleDeg: this.rawAngleDeg,
      confidence: this.confidence,
      velocityDegPerSec: this.velocityDegPerSec,
      position: classifyHinge(this.angleDeg),
      missed: this.missed,
      samples: this.samples,
      lastSeenAt: this.lastSeenAt,
    };
  }

  toJSON() {
    return this.snapshot();
  }
}

export default { HingeTracker, hingeAngleDeg, estimateHingeFromFrame };
