// server/services/vectorStore.js — Vector similarity store (§12).
//
// Provides a shared interface for storing and querying vector embeddings.
// Uses pure JavaScript — works everywhere (browser + server) with no native
// dependencies.
//
// NOTES:
//   - Cosine similarity ranges from -1 (opposite) to 1 (identical).
//   - For visual feature vectors (DINOv2 etc.), higher = more similar.
//   - O(n) search — fine for small-to-medium collections (<10k vectors).
//   - For larger datasets, use a native FAISS adapter instead.
// ---------------------------------------------------------------------------

export class VectorStore {
  constructor({ modelId = null, dimension = null } = {}) {
    this.vectors = new Map();
    this.modelId = modelId;
    this.dimension = dimension;
  }

  _validate(vector, metadata = {}) {
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('vector must be a non-empty array');
    if (this.dimension != null && vector.length !== this.dimension) throw new Error(`vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`);
    for (const v of vector) {
      if (!Number.isFinite(v)) throw new Error('vector contains non-finite values');
    }
    if (metadata && metadata.modelId && this.modelId && metadata.modelId !== this.modelId) {
      throw new Error('vector model mismatch');
    }
  }

  add(id, vector, metadata = {}) {
    const vec = Array.isArray(vector) ? [...vector] : [vector];
    this._validate(vec, metadata);
    const md = { ...metadata };
    if (this.modelId && !md.modelId) md.modelId = this.modelId;
    if (!md.dimension) md.dimension = vec.length;
    this.vectors.set(id, { vector: vec, metadata: md });
    return id;
  }

  toJSON() {
    return {
      modelId: this.modelId,
      dimension: this.dimension,
      entries: [...this.vectors.entries()].map(([id, { vector, metadata }]) => ({ id, vector, metadata })),
    };
  }

  static fromJSON(data) {
    const store = new VectorStore({ modelId: data?.modelId ?? null, dimension: data?.dimension ?? null });
    for (const e of data?.entries || []) {
      try { store.add(e.id, e.vector, e.metadata || {}); } catch { /* skip invalid */ }
    }
    return store;
  }

  add(id, vector, metadata = {}) {
    const vec = Array.isArray(vector) ? [...vector] : [vector];
    this.vectors.set(id, { vector: vec, metadata: { ...metadata } });
    return id;
  }

  search(queryVector, topK = 5) {
    if (!queryVector || queryVector.length === 0) return [];

    const candidates = [];
    for (const [id, { vector, metadata }] of this.vectors) {
      if (!vector || vector.length !== queryVector.length) continue;
      const sim = cosineSimilarity(queryVector, vector);
      candidates.push({ id, score: sim, metadata: { ...metadata } });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
  }

  delete(id) {
    this.vectors.delete(id);
  }

  count() {
    return this.vectors.size;
  }

  clear() {
    this.vectors.clear();
  }
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function normalizeVector(vector) {
  if (!vector || vector.length === 0) return vector;

  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return [...vector];

  const result = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    result[i] = vector[i] / norm;
  }
  return result;
}
