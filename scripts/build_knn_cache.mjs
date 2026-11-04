// scripts/build_knn_cache.mjs — convert the JSON reference DB into a compact
// typed-array binary cache. Float32 keeps the exact values used by the KNN
// classifier (which already works in JS number precision); parsing 12 MB of
// JSON at runtime is what made startup slow.
//
// Usage: node scripts/build_knn_cache.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'knn_reference_db_compact.json');
const binPath = resolve(root, 'knn_reference_db_compact.bin');
const metaPath = resolve(root, 'knn_reference_db_compact.meta.json');

const started = performance.now();
const data = JSON.parse(readFileSync(source, 'utf8'));
const refs = data.references;
if (!Array.isArray(refs) || refs.length === 0) throw new Error('reference DB has no references');
const dim = refs[0].features.length;
if (dim !== 2027) throw new Error(`expected 2027 features, got ${dim}`);
if (data.featureVersion !== '4.0') throw new Error(`expected featureVersion 4.0, got ${data.featureVersion}`);

const classes = [...new Set(refs.map((r) => r.className))].sort();
const classIndex = new Map(classes.map((name, i) => [name, i]));
const features = new Float32Array(refs.length * dim);
const labels = new Uint16Array(refs.length);
for (let r = 0; r < refs.length; r++) {
  const ref = refs[r];
  if (!ref || !Array.isArray(ref.features) || ref.features.length !== dim) {
    throw new Error(`reference ${r} has an invalid feature vector`);
  }
  const label = classIndex.get(ref.className);
  if (label === undefined) throw new Error(`reference ${r} has an unknown class`);
  labels[r] = label;
  const offset = r * dim;
  for (let i = 0; i < dim; i++) {
    const value = ref.features[i];
    if (!Number.isFinite(value)) throw new Error(`reference ${r} has a non-finite feature at ${i}`);
    features[offset + i] = value;
  }
}

const header = Buffer.alloc(32);
header.write('ILKNN1\0\0', 0, 'ascii');
header.writeUInt32LE(refs.length, 8);
header.writeUInt32LE(dim, 12);
header.writeUInt32LE(classes.length, 16);
header.writeUInt32LE(data.k || 3, 20);
header.writeFloatLE(Number(data.maxDist || 50.6), 24);
header.writeUInt32LE(0, 28);

const featureBytes = Buffer.from(features.buffer, features.byteOffset, features.byteLength);
const labelBytes = Buffer.from(labels.buffer, labels.byteOffset, labels.byteLength);
const out = Buffer.concat([header, featureBytes, labelBytes]);
writeFileSync(binPath, out);

const meta = {
  version: '1.0',
  featureVersion: data.featureVersion,
  count: refs.length,
  dim,
  classes,
  k: data.k || 3,
  maxDist: Number(data.maxDist || 50.6),
  bytes: out.length,
  sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  builtAt: new Date().toISOString(),
  buildMs: Math.round(performance.now() - started),
};
writeFileSync(metaPath, JSON.stringify(meta));

console.log(JSON.stringify({
  bin: binPath,
  binMb: +(statSync(binPath).size / 1e6).toFixed(1),
  meta: metaPath,
  refs: refs.length,
  classes: classes.length,
  dim,
  buildMs: meta.buildMs,
}, null, 2));
