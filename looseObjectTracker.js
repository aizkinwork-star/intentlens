// looseObjectTracker.js — orchestrates contour detection + k-NN + optical flow for loose objects.
import { KNNClassifier } from './perception/learning/KNNClassifier.js';
import { FeatureExtractor } from './perception/learning/FeatureExtractor.js';
import { OpticalFlowTracker } from './perception/tracking/OpticalFlowTracker.js';

// One fetch per page, shared by every tracker instance.
let referenceDbPromise = null;

async function fetchCompactReferenceDb() {
  if (referenceDbPromise) return referenceDbPromise;
  referenceDbPromise = (async () => {
    const metaRes = await fetch('/knn_reference_db_compact.meta.json', { cache: 'no-store' });
    if (!metaRes.ok) throw new Error('reference DB metadata fetch failed: ' + metaRes.status);
    const meta = await metaRes.json();
    if (!meta || !Array.isArray(meta.classes)) throw new Error('reference DB metadata is malformed');
    if (meta.featureVersion !== '4.0') throw new Error('reference DB version mismatch: expected 4.0, got ' + meta.featureVersion);
    if (meta.dim !== 2027) throw new Error('reference DB dimension mismatch: expected 2027, got ' + meta.dim);
    if (!Number.isInteger(meta.count) || meta.count <= 0) throw new Error('reference DB has no references');

    const binRes = await fetch('/knn_reference_db_compact.bin', { cache: 'no-store' });
    if (!binRes.ok) throw new Error('reference DB binary fetch failed: ' + binRes.status);
    const buffer = await binRes.arrayBuffer();
    const header = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 6));
    if (magic !== 'ILKNN1') throw new Error('reference DB binary has an unknown format');
    const count = header.getUint32(8, true);
    const dim = header.getUint32(12, true);
    const classCount = header.getUint32(16, true);
    const k = header.getUint32(20, true);
    const maxDist = header.getFloat32(24, true);
    if (count !== meta.count || dim !== meta.dim || classCount !== meta.classes.length) {
      throw new Error('reference DB binary does not match its metadata');
    }
    const featureBytes = count * dim * 4;
    const expected = 32 + featureBytes + count * 2;
    if (buffer.byteLength !== expected) throw new Error(`reference DB binary size mismatch: expected ${expected}, got ${buffer.byteLength}`);
    return {
      vectors: new Float32Array(buffer, 32, count * dim),
      labels: new Uint16Array(buffer, 32 + featureBytes, count),
      classNames: meta.classes,
      dim,
      count,
      k,
      maxDist,
      featureVersion: meta.featureVersion,
    };
  })().catch((err) => {
    referenceDbPromise = null; // allow a retry after a transient failure
    throw err;
  });
  return referenceDbPromise;
}

export class LooseObjectTracker {
  constructor() {
    this.classifier = new KNNClassifier(3, 50.6, '4.0');
    this.featureExtractor = new FeatureExtractor();
    this.scaler = null;
    this.tracks = new Map();
    this.nextId = 1;
    this.flow = new OpticalFlowTracker();
    this.initialized = false;
    this.scalerLoaded = false;
    this.refDbLoaded = false;
    // Bounded memo for crop features: classification is CPU-bound, and many
    // frames repeat the same region while the board is still.
    this.featureCache = new Map();
    this.featureCacheLimit = 512;
  }

  async loadScaler() {
    // Guard against duplicate loading.
    if (this.scalerLoaded && this.scaler) {
      return { ok: true, dim: this.scaler.mean.length, cached: true };
    }
    try {
      const res = await fetch('/api/scaler', { cache: 'no-store' });
      if (!res.ok) throw new Error('scaler fetch failed: ' + res.status);
      const data = await res.json();
      if (!data.mean || !data.std || !Array.isArray(data.mean) || !Array.isArray(data.std)) {
        throw new Error('scaler is malformed: missing mean/std arrays');
      }
      if (data.mean.length !== data.std.length) {
        throw new Error('scaler is malformed: mean/std length mismatch');
      }
      if (data.version !== '4.0') {
        throw new Error('scaler version mismatch: expected 4.0, got ' + data.version);
      }
      if (data.mean.length !== 2027) {
        throw new Error('scaler dimension mismatch: expected 2027, got ' + data.mean.length);
      }
      // Validate all values finite.
      for (let i = 0; i < data.mean.length; i++) {
        if (!Number.isFinite(data.mean[i]) || !Number.isFinite(data.std[i])) {
          throw new Error('scaler contains non-finite values at index ' + i);
        }
        if (data.std[i] < 1e-6) {
          throw new Error('scaler std too small at index ' + i);
        }
      }
      this.scaler = data;
      this.featureExtractor.scaler = { mean: data.mean, std: data.std };
      this.scalerLoaded = true;
      return { ok: true, dim: data.mean.length };
    } catch (e) {
      this.scalerLoaded = false;
      this.scaler = null;
      this.featureExtractor.scaler = null;
      return { ok: false, error: e.message };
    }
  }

  async loadReferenceDb() {
    // Guard against duplicate loading.
    if (this.refDbLoaded && this.classifier && this.classifier.referenceCount > 0) {
      return { ok: true, refs: this.classifier.referenceCount, classes: new Set(this.classifier.compact?.classNames || []).size, cached: true };
    }
    try {
      const data = await fetchCompactReferenceDb();
      const classifier = new KNNClassifier(data.k || 3, data.maxDist || 50.6, data.featureVersion || '4.0');
      classifier.setCompactReferences(data);
      this.classifier = classifier;
      this.refDbLoaded = true;
      return { ok: true, refs: data.count, classes: data.classNames.length };
    } catch (e) {
      this.refDbLoaded = false;
      return { ok: false, error: e.message };
    }
  }

  async init() {
    // Prevent re-initialization.
    if (this.initialized) {
      return { scaler: { ok: true, cached: true }, db: { ok: true, cached: true }, initialized: true };
    }
    const scalerResult = await this.loadScaler();
    if (!scalerResult.ok) {
      this.initialized = false;
      return { scaler: scalerResult, db: { ok: false, error: 'scaler not loaded' }, initialized: false };
    }
    const dbResult = await this.loadReferenceDb();
    this.initialized = scalerResult.ok && dbResult.ok;
    return { scaler: scalerResult, db: dbResult, initialized: this.initialized };
  }

  // Validate that the pipeline is ready for classification.
  validateReady() {
    if (!this.scalerLoaded || !this.scaler) {
      throw new Error('LooseObjectTracker: scaler not loaded. Call init() first.');
    }
    if (!this.refDbLoaded || !this.classifier) {
      throw new Error('LooseObjectTracker: reference DB not loaded. Call init() first.');
    }
    const hasReferences = (this.classifier.compact?.count || 0) > 0 || this.classifier.examples.length > 0;
    if (!hasReferences) {
      throw new Error('LooseObjectTracker: reference DB is empty. Call init() first.');
    }
    if (this.featureExtractor.version !== '4.0') {
      throw new Error('LooseObjectTracker: feature version mismatch. Expected 4.0, got ' + this.featureExtractor.version);
    }
    return true;
  }

  loadTrainingData() {
    // No-op: data loaded from server
  }

  saveTrainingData() {
    // No-op: data managed server-side
  }

  // Extract features from a region using FeatureExtractor (applies scaler).
  // Throws if scaler is not loaded.
  extractFeatures(imageData, box) {
    this.validateReady();
    const features = this.featureExtractor.extract(imageData, box);
    // Validate dimension.
    if (features.length !== 2027) {
      throw new Error('LooseObjectTracker: feature dimension mismatch. Expected 2027, got ' + features.length);
    }
    // Validate finiteness.
    for (let i = 0; i < features.length; i++) {
      if (!Number.isFinite(features[i])) {
        throw new Error('LooseObjectTracker: non-finite feature at index ' + i);
      }
    }
    return features;
  }

  addTrainingExample(imageData, box, label) {
    this.validateReady();
    const features = this.extractFeatures(imageData, box);
    // Validate version compatibility.
    if (this.featureExtractor.version !== '4.0') {
      throw new Error('Feature version mismatch. Expected 4.0, got ' + this.featureExtractor.version);
    }
    this.classifier.addExample(features, label, 1.0, 'user_confirmed', this.featureExtractor.version);
    this.featureCache.clear();
  }

  /** Cheap perceptual signature so repeated crops reuse expensive features. */
  cropSignature(imageData, box) {
    const { width, height, data } = imageData;
    const x0 = Math.max(0, Math.floor(box.x * width));
    const y0 = Math.max(0, Math.floor(box.y * height));
    const bw = Math.max(1, Math.floor(box.width * width));
    const bh = Math.max(1, Math.floor(box.height * height));
    let hash = 2166136261;
    for (let gy = 0; gy < 8; gy += 1) {
      const y = Math.min(height - 1, y0 + Math.floor((gy + 0.5) * bh / 8));
      for (let gx = 0; gx < 8; gx += 1) {
        const x = Math.min(width - 1, x0 + Math.floor((gx + 0.5) * bw / 8));
        const p = (y * width + x) * 4;
        const luma = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
        hash ^= luma & 0xf8;
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${Math.round(box.x * 1000)},${Math.round(box.y * 1000)},${Math.round(box.width * 1000)},${Math.round(box.height * 1000)},${hash >>> 0}`;
  }

  cachedFeatures(imageData, box) {
    const key = this.cropSignature(imageData, box);
    const hit = this.featureCache.get(key);
    if (hit) return hit;
    const features = this.extractFeatures(imageData, box);
    if (this.featureCache.size >= this.featureCacheLimit) {
      this.featureCache.delete(this.featureCache.keys().next().value);
    }
    this.featureCache.set(key, features);
    return features;
  }

  // Given detected regions, classify and track.
  update(imageData, detectedRegions) {
    this.validateReady();
    const now = Date.now();
    const results = [];
    const matched = new Set();

    for (const region of detectedRegions.slice(0, 12)) {
      const features = this.cachedFeatures(imageData, region.box);
      const cls = this.classifier.classify(features, this.featureExtractor.version);
      const label = cls.similarity > 0.3 ? cls.label : 'unknown';

      let bestTrack = null, bestIoU = 0.3;
      for (const [id, track] of this.tracks) {
        if (matched.has(id)) continue;
        const iou = iouBoxes(region.box, track.box);
        if (iou > bestIoU) { bestIoU = iou; bestTrack = id; }
      }

      if (bestTrack) {
        const track = this.tracks.get(bestTrack);
        track.box = region.box;
        track.label = label !== 'unknown' ? label : track.label;
        track.lastSeen = now;
        track.missedFrames = 0;
        track.state = 'tracking';
        matched.add(bestTrack);
        results.push({ trackId: bestTrack, ...track, classification: cls });
      } else {
        const id = `LOOSE_${String(this.nextId++).padStart(3, '0')}`;
        this.tracks.set(id, {
          id, label, box: region.box, state: 'new',
          lastSeen: now, missedFrames: 0, createdAt: now,
        });
        matched.add(id);
        results.push({ trackId: id, label, box: region.box, state: 'new', classification: cls });
      }
    }

    for (const [id, track] of this.tracks) {
      if (!matched.has(id)) {
        track.missedFrames++;
        if (track.missedFrames > 15) {
          track.state = 'lost';
        } else {
          track.state = 'occluded';
        }
      }
    }

    return results;
  }

  getTracks() { return [...this.tracks.values()]; }
  reset() { this.tracks.clear(); this.nextId = 1; }
}

function iouBoxes(a, b) {
  const ax1 = a.x, ay1 = a.y, ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx1 = b.x, by1 = b.y, bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = a.width * a.height, areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}