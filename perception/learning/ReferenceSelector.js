// perception/learning/ReferenceSelector.js — reproducible reference selection.
//
// The shipped compact k-NN index was built with an undocumented selection recipe
// and measured badly (13.72% top-1 on the held-out test split). This module makes
// selection explicit and deterministic:
//
//   - Group labelled vectors by class.
//   - Keep every sample when a class has no more than the budget.
//   - Otherwise choose actual samples (medoids) with k-medoids, starting from
//     two deterministic initialisations and keeping the lower-distortion one.
//
// Why medoids and not centroids: the runtime classifier is a k-NN matcher that
// needs real feature vectors. A centroid is not a sample and can sit in a gap
// between modes. A medoid is an observed sample that minimises within-cluster
// distance, so it is robust to a few bad crops without inventing features.
//
// Everything is pure and seeded, so the same train split produces the same
// reference set on every machine.

export const DEFAULT_PER_CLASS = 5;

function isVector(value) {
  return (Array.isArray(value) || value instanceof Float32Array) && value.length > 0;
}

function assertDataset(vectors, labels) {
  if (!Array.isArray(vectors) || !Array.isArray(labels)) {
    throw new TypeError('vectors must be an array of arrays and labels must be an array');
  }
  if (vectors.length !== labels.length) {
    throw new Error(`vectors (${vectors.length}) and labels (${labels.length}) must be the same length`);
  }
  if (!vectors.length) throw new Error('the dataset is empty');
  const dim = vectors[0].length;
  for (let i = 0; i < vectors.length; i += 1) {
    if (!isVector(vectors[i])) throw new TypeError(`vector ${i} is not a non-empty array`);
    if (vectors[i].length !== dim) throw new Error(`vector ${i} has dimension ${vectors[i].length}; expected ${dim}`);
    for (let j = 0; j < dim; j += 1) {
      if (!Number.isFinite(vectors[i][j])) throw new TypeError(`vector ${i} has a non-finite value at ${j}`);
    }
  }
  return dim;
}

export function euclidean(a, b) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Stable grouping: labels sorted, indices ascending within a class. */
export function groupByLabel(labels) {
  const groups = new Map();
  for (let i = 0; i < labels.length; i += 1) {
    const label = String(labels[i]);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(i);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Deterministic PRNG (mulberry32). Used only for k-means++ seeding. */
export function createRandom(seed = 1) {
  let state = (Number(seed) || 1) >>> 0;
  return function random() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanVector(vectors, indices) {
  const dim = vectors[indices[0]].length;
  const mean = new Array(dim).fill(0);
  for (const index of indices) {
    for (let d = 0; d < dim; d += 1) mean[d] += vectors[index][d];
  }
  for (let d = 0; d < dim; d += 1) mean[d] /= indices.length;
  return mean;
}

function closestToMean(vectors, indices, distance = euclidean) {
  const mean = meanVector(vectors, indices);
  let best = indices[0];
  let bestDist = Infinity;
  for (const index of indices) {
    const dist = distance(vectors[index], mean);
    if (dist < bestDist - 1e-12 || (Math.abs(dist - bestDist) <= 1e-12 && index < best)) {
      best = index;
      bestDist = dist;
    }
  }
  return best;
}

/** Distance from one sample to its k-th nearest neighbour inside a group. */
function kthNearestInGroup(vectors, indices, index, k, distance) {
  const keep = Math.max(1, Math.min(k, indices.length - 1));
  const best = [];
  for (const other of indices) {
    if (other === index) continue;
    const d = distance(vectors[index], vectors[other]);
    if (best.length < keep) {
      best.push(d);
      best.sort((a, b) => a - b);
    } else if (d < best[best.length - 1]) {
      best[best.length - 1] = d;
      best.sort((a, b) => a - b);
    }
  }
  return best.length ? best[best.length - 1] : 0;
}

/**
 * Drop gross outliers from the medoid candidate pool.
 *
 * A bad crop can be the farthest point from every cluster, which makes
 * farthest-point seeding choose it and then keep it as a singleton medoid. A
 * sample whose k-th-neighbour distance is more than four times the class median
 * is not allowed to become a medoid. It can still be assigned to a real one.
 */
function denseCandidates(vectors, indices, count, distance) {
  if (indices.length <= count) return [...indices];
  const k = Math.max(1, Math.min(indices.length - 1, Math.ceil(Math.sqrt(indices.length))));
  const density = indices.map((index) => kthNearestInGroup(vectors, indices, index, k, distance));
  const sorted = [...density].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median * 4;
  const pool = indices.filter((_, position) => density[position] <= threshold);
  return pool.length >= count ? pool : [...indices];
}

function farthestPointInit(vectors, indices, count, distance) {
  const chosen = [closestToMean(vectors, indices, distance)];
  const minDist = new Map(indices.map((index) => [index, Infinity]));
  while (chosen.length < count) {
    const last = vectors[chosen[chosen.length - 1]];
    let next = null;
    let nextDist = -Infinity;
    for (const index of indices) {
      const d = distance(vectors[index], last);
      if (d < minDist.get(index)) minDist.set(index, d);
      const nearest = minDist.get(index);
      if (nearest > nextDist + 1e-12 || (Math.abs(nearest - nextDist) <= 1e-12 && next !== null && index < next)) {
        next = index;
        nextDist = nearest;
      }
    }
    if (next == null) break;
    chosen.push(next);
  }
  return chosen;
}

function kmeansPlusPlusInit(vectors, indices, count, distance, random) {
  const chosen = [closestToMean(vectors, indices, distance)];
  const minDist = new Map(indices.map((index) => [index, Infinity]));
  while (chosen.length < count) {
    const last = vectors[chosen[chosen.length - 1]];
    let total = 0;
    for (const index of indices) {
      const d = distance(vectors[index], last);
      if (d < minDist.get(index)) minDist.set(index, d);
      total += minDist.get(index) ** 2;
    }
    let target = random() * total;
    let picked = null;
    for (const index of indices) {
      target -= minDist.get(index) ** 2;
      if (target <= 0) { picked = index; break; }
    }
    if (picked == null) picked = indices[indices.length - 1];
    if (chosen.includes(picked)) {
      // Duplicate points can make every weight zero; fall back to the farthest
      // sample that is not already a medoid.
      picked = indices.find((index) => !chosen.includes(index)) ?? picked;
    }
    chosen.push(picked);
  }
  return chosen;
}

function assignToMedoids(vectors, indices, medoids, distance) {
  const clusters = medoids.map(() => []);
  for (const index of indices) {
    let best = 0;
    let bestDist = Infinity;
    for (let m = 0; m < medoids.length; m += 1) {
      const d = distance(vectors[index], vectors[medoids[m]]);
      if (d < bestDist) { best = m; bestDist = d; }
    }
    clusters[best].push(index);
  }
  return clusters;
}

function medoidOfCluster(vectors, cluster, distance, candidates = cluster) {
  const pool = candidates.length ? candidates : cluster;
  let best = pool[0];
  let bestCost = Infinity;
  for (const candidate of pool) {
    let cost = 0;
    for (const other of cluster) cost += distance(vectors[candidate], vectors[other]);
    if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) <= 1e-12 && candidate < best)) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

function refineMedoids(vectors, indices, initial, distance, maxIterations, candidates = indices) {
  const poolSet = new Set(candidates);
  let medoids = [...initial];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const clusters = assignToMedoids(vectors, indices, medoids, distance);
    const next = medoids.map((medoid, slot) => {
      if (!clusters[slot].length) return medoid;
      const inPool = clusters[slot].filter((index) => poolSet.has(index));
      return medoidOfCluster(vectors, clusters[slot], distance, inPool.length ? inPool : clusters[slot]);
    });
    const unchanged = next.every((value, slot) => value === medoids[slot]);
    medoids = next;
    if (unchanged) break;
  }
  return medoids;
}

export function distortionOf(vectors, indices, medoids, distance = euclidean) {
  let total = 0;
  for (const index of indices) {
    let best = Infinity;
    for (const medoid of medoids) {
      const d = distance(vectors[index], vectors[medoid]);
      if (d < best) best = d;
    }
    total += best;
  }
  return total;
}

function selectForClass(vectors, indices, count, distance, random, maxIterations) {
  if (indices.length <= count) return [...indices];

  const pool = denseCandidates(vectors, indices, count, distance);
  const candidates = [
    farthestPointInit(vectors, pool, count, distance),
    kmeansPlusPlusInit(vectors, pool, count, distance, random),
  ].map((init) => refineMedoids(vectors, indices, init, distance, maxIterations, pool));

  let best = candidates[0];
  let bestDistortion = distortionOf(vectors, indices, best, distance);
  for (let i = 1; i < candidates.length; i += 1) {
    const value = distortionOf(vectors, indices, candidates[i], distance);
    if (value < bestDistortion - 1e-12) {
      best = candidates[i];
      bestDistortion = value;
    }
  }
  return [...best].sort((a, b) => a - b);
}

/**
 * Select up to `perClass` real samples from every class.
 *
 * Returns:
 *   indices        selected row indices, grouped by sorted class then ascending
 *   labels         the label for each selected index
 *   perClassCounts how many were kept per class
 *   total          number selected
 *   seed           the seed used (for the run record)
 */
export function selectMedoids(vectors, labels, {
  perClass = DEFAULT_PER_CLASS,
  seed = 1,
  distance = euclidean,
  maxIterations = 20,
} = {}) {
  assertDataset(vectors, labels);
  const budget = Math.max(1, Math.floor(Number(perClass) || DEFAULT_PER_CLASS));
  const random = createRandom(seed);
  const groups = groupByLabel(labels);
  const indices = [];
  const perClassCounts = {};
  for (const [label, group] of groups) {
    const chosen = selectForClass(vectors, group, budget, distance, random, maxIterations);
    perClassCounts[label] = chosen.length;
    indices.push(...chosen);
  }
  return {
    indices,
    labels: indices.map((index) => String(labels[index])),
    perClassCounts,
    total: indices.length,
    seed,
    perClass: budget,
  };
}

/** Materialise a reference set from a selection (compact, detached arrays). */
export function buildReferenceSet(vectors, labels, selection) {
  if (!selection || !Array.isArray(selection.indices)) throw new TypeError('a selection is required');
  return {
    vectors: selection.indices.map((index) => Float64Array.from(vectors[index])),
    labels: selection.indices.map((index) => String(labels[index])),
    perClassCounts: { ...selection.perClassCounts },
    total: selection.indices.length,
    seed: selection.seed,
    perClass: selection.perClass,
  };
}

export default { selectMedoids, buildReferenceSet, groupByLabel, distortionOf, euclidean };
