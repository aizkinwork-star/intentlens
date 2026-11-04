// server/services/benchmark.js — performance measurement (§15).
//
// Measures and logs real device performance:
//   - UI FPS (frontend-reported)
//   - Tracker updates/sec
//   - Model latency per provider
//   - Provider fallback time
//
// Nothing is advertised until measured on real devices.

const samples = new Map(); // metric name => { values: number[], count: number }

export function record(metric, value) {
  if (!samples.has(metric)) samples.set(metric, { values: [], count: 0 });
  const s = samples.get(metric);
  s.values.push(value);
  s.count += 1;
  // Keep only last 100 samples per metric
  if (s.values.length > 100) s.values.shift();
}

export function getStats(metric) {
  const s = samples.get(metric);
  if (!s || !s.values.length) return null;
  const vals = s.values.slice();
  vals.sort((a, b) => a - b);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const p50 = vals[Math.floor(vals.length * 0.5)];
  const p95 = vals[Math.floor(vals.length * 0.95)];
  const p99 = vals[Math.floor(vals.length * 0.99)];
  return { count: s.count, avg, p50, p95, p99, min: vals[0], max: vals[vals.length - 1] };
}

export function getAllStats() {
  const out = {};
  for (const [metric] of samples) {
    out[metric] = getStats(metric);
  }
  return out;
}

export function reset() {
  samples.clear();
}
