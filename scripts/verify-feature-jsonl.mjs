import fs from "node:fs";
import readline from "node:readline";

const file = "datasets/processed/feature_vectors.jsonl";

const required = [
  "sampleId", "imageId", "annotationId",
  "classId", "className", "split",
  "featureVersion", "labelProvenance",
  "boundaryTouching", "features"
];

const stats = {
  records: 0,
  malformed: 0,
  missingFields: 0,
  invalidVectors: 0,
  invalidNumbers: 0,
  wrongDimensions: 0,
  duplicateSampleIds: 0,
  dimensions: {},
  classes: {},
  splits: {},
  versions: {},
  errors: []
};

const ids = new Set();

const stream = fs.createReadStream(file, {
  encoding: "utf8",
  highWaterMark: 1024 * 1024
});

const reader = readline.createInterface({
  input: stream,
  crlfDelay: Infinity
});

for await (const line of reader) {
  if (!line.trim()) continue;

  stats.records++;

  let r;

  try {
    r = JSON.parse(line);
  } catch (e) {
    stats.malformed++;
    if (stats.errors.length < 10)
      stats.errors.push({ record: stats.records, error: e.message });
    continue;
  }

  if (required.some(k => !(k in r))) {
    stats.missingFields++;
  }

  if (!Array.isArray(r.features)) {
    stats.invalidVectors++;
    continue;
  }

  const dim = r.features.length;
  stats.dimensions[dim] = (stats.dimensions[dim] || 0) + 1;

  if (dim !== 3483) stats.wrongDimensions++;

  for (const n of r.features) {
    if (typeof n !== "number" || !Number.isFinite(n)) {
      stats.invalidNumbers++;
      break;
    }
  }

  if (r.sampleId) {
    if (ids.has(r.sampleId)) stats.duplicateSampleIds++;
    ids.add(r.sampleId);
  }

  stats.classes[r.className] =
    (stats.classes[r.className] || 0) + 1;

  stats.splits[r.split] =
    (stats.splits[r.split] || 0) + 1;

  stats.versions[r.featureVersion] =
    (stats.versions[r.featureVersion] || 0) + 1;

  if (stats.records % 1000 === 0)
    console.log(`Validated ${stats.records} records...`);
}

console.log("\n========== FEATURE VALIDATION ==========");
console.log(JSON.stringify(stats, null, 2));
