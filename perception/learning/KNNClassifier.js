// perception/learning/KNNClassifier.js — classical k-NN over feature vectors.
export class KNNClassifier {
  constructor(k = 3, maxDistance = 50.6, featureVersion = '4.0') {
    this.k = k; this.maxDistance = maxDistance; this.featureVersion = featureVersion; this.examples = [];
    // Generated binary cache: count x dim Float32 matrix plus label indices.
    // This avoids parsing and copying a 12 MB JSON array of 2,027-element arrays.
    this.compact = null;
  }

  /**
   * Install a generated compact reference index. `vectors` must be a Float32Array
   * of count*dim values; `labels` holds one class index per row.
   */
  setCompactReferences({ vectors, labels, classNames, dim, featureVersion = '4.0', k = this.k, maxDistance = this.maxDistance }) {
    if (!(vectors instanceof Float32Array)) throw new Error('KNNClassifier: compact vectors must be a Float32Array');
    if (!labels || labels.length * dim !== vectors.length) {
      throw new Error('KNNClassifier: compact label count does not match vector length');
    }
    if (!Array.isArray(classNames) || classNames.length === 0) throw new Error('KNNClassifier: compact class names are required');
    this.compact = { vectors, labels, classNames, dim, count: labels.length, featureVersion };
    this.k = k;
    this.maxDistance = maxDistance;
    this.featureVersion = featureVersion;
    return { count: this.compact.count, dim, classes: classNames.length };
  }

  get referenceCount() {
    return (this.compact?.count || 0) + this.examples.length;
  }

  addExample(features, label, weight = 1.0, provenance = 'user_confirmed', version = null) {
    this.examples.push({ features: [...features], label, weight, provenance, version: version || this.featureVersion });
  }

  classify(features, version = null) {
    const v = version || this.featureVersion;
    if (!Array.isArray(features) && !(features instanceof Float32Array)) {
      throw new Error('KNNClassifier.classify: features must be an array');
    }
    const expectedDim = this.compact?.dim || this.examples[0]?.features?.length;
    if (expectedDim && features.length !== expectedDim) {
      throw new Error('KNNClassifier.classify: dimension mismatch. Expected ' + expectedDim + ', got ' + features.length);
    }
    if (this.referenceCount === 0) return { label: 'unknown', similarity: 0, neighbors: [], reason: 'no_examples' };

    const k = Math.max(1, this.k | 0);
    // Bounded top-k without allocating an object per reference.
    const bestDist = new Float64Array(k).fill(Infinity);
    const bestLabel = new Array(k).fill(null);
    const bestWeight = new Float64Array(k).fill(1);
    const bestProvenance = new Array(k).fill('dataset');
    let matched = 0;

    const consider = (dist, label, weight, provenance) => {
      matched += 1;
      if (dist >= bestDist[k - 1]) return;
      let at = k - 1;
      while (at > 0 && dist < bestDist[at - 1]) {
        bestDist[at] = bestDist[at - 1];
        bestLabel[at] = bestLabel[at - 1];
        bestWeight[at] = bestWeight[at - 1];
        bestProvenance[at] = bestProvenance[at - 1];
        at -= 1;
      }
      bestDist[at] = dist;
      bestLabel[at] = label;
      bestWeight[at] = weight;
      bestProvenance[at] = provenance;
    };

    if (this.compact && this.compact.featureVersion === v) {
      const { vectors, labels, classNames, dim, count } = this.compact;
      for (let row = 0; row < count; row += 1) {
        let sum = 0;
        const base = row * dim;
        for (let i = 0; i < dim; i += 1) {
          const d = features[i] - vectors[base + i];
          sum += d * d;
        }
        consider(Math.sqrt(sum), classNames[labels[row]], 1, 'dataset');
      }
    }

    for (const ex of this.examples) {
      if (ex.version && ex.version !== v) continue;
      consider(euclidean(features, ex.features), ex.label, ex.weight, ex.provenance);
    }

    if (!matched) return { label: 'unknown', similarity: 0, neighbors: [], reason: 'version_mismatch' };
    const neighbors = [];
    for (let i = 0; i < k && bestLabel[i] !== null; i += 1) {
      neighbors.push({ label: bestLabel[i], dist: bestDist[i], provenance: bestProvenance[i] });
    }
    // Max-distance rejection.
    if (neighbors[0].dist > this.maxDistance) {
      return { label: 'unknown', similarity: 0, neighbors, reason: 'too_far' };
    }
    // Weighted vote.
    const votes = {};
    for (let i = 0; i < neighbors.length; i += 1) {
      const n = neighbors[i];
      votes[n.label] = (votes[n.label] || 0) + (bestWeight[i] * (1 / (n.dist + 1e-6)));
    }
    let best = 'unknown', bestScore = 0, secondScore = 0;
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sorted.length) { best = sorted[0][0]; bestScore = sorted[0][1]; }
    if (sorted.length > 1) secondScore = sorted[1][1];
    // Top-class separation check.
    if (secondScore > 0 && bestScore / (secondScore + 1e-6) < 1.5) {
      return { label: 'unknown', similarity: 1 / (neighbors[0].dist + 1), neighbors, reason: 'ambiguous' };
    }
    const similarity = 1 / (neighbors[0].dist + 1);
    return { label: best, similarity, neighbors, reason: 'ok' };
  }

  toJSON() { return { k: this.k, maxDistance: this.maxDistance, featureVersion: this.featureVersion, examples: this.examples }; }
  static fromJSON(data) { const c = new KNNClassifier(data?.k || 3, data?.maxDistance || 50.6, data?.featureVersion || '4.0'); c.examples = data?.examples || []; return c; }
}

function euclidean(a, b) {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]-b[i])**2;
  return Math.sqrt(s);
}