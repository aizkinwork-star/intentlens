// server/lib/startup.js — phase instrumentation for the backend.
const t0 = performance.now();
const phases = [];

export function markPhase(name, detail = {}) {
  phases.push({
    name,
    atMs: Math.round(performance.now() - t0),
    at: new Date().toISOString(),
    ...detail,
  });
}

export function getStartupReport() {
  return {
    processUptimeMs: Math.round(performance.now() - t0),
    phases: [...phases],
  };
}
