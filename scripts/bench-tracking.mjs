#!/usr/bin/env node
// scripts/bench-tracking.mjs — synthetic, deterministic benchmark for TargetTracker.
//
// Scene generation lives in scripts/tracking-scenes.mjs so the test suite can
// exercise the same scenes. Metrics per scenario: mean IoU against the
// ground-truth box, the fraction of visible frames tracked (IoU > 0.35), the
// fraction of occluded frames falsely reported as TRACKING, and visible frames
// to recover after reappearance.
//
// Usage:
//   node scripts/bench-tracking.mjs [--json out.json] [--min 0.9] [--min-iou 0.6] [--verbose]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TargetTracker } from '../tracker.js';
import { SCENARIOS, runSequence } from './tracking-scenes.mjs';

const args = {
  json: 'datasets/processed/tracking_benchmark.json',
  min: 0.9,
  minIou: 0.55,
  verbose: false,
};
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token === '--json') args.json = process.argv[++i];
  else if (token === '--min') args.min = Number(process.argv[++i]);
  else if (token === '--min-iou') args.minIou = Number(process.argv[++i]);
  else if (token === '--verbose') args.verbose = true;
}

const results = {};
for (const [name, build] of Object.entries(SCENARIOS)) {
  const result = runSequence(build(), {
    TargetTracker,
    onFrame: args.verbose
      ? (index, entry, snap) => {
        const truth = entry.truth ? `${entry.truth.x.toFixed(3)},${entry.truth.y.toFixed(3)}` : 'hidden';
        const box = snap?.box ? `${snap.box.x.toFixed(3)},${snap.box.y.toFixed(3)},${snap.box.width.toFixed(3)}` : 'null';
        console.log(`  #${index} truth=${truth} state=${snap?.state} box=${box} conf=${(snap?.confidence ?? 0).toFixed(2)}`);
      }
      : null,
  });
  results[name] = result;
  const recovery = result.recoveryFrames === null ? 'n/a' : String(result.recoveryFrames);
  console.log(
    `${name.padEnd(22)} tracked=${(result.trackedRate * 100).toFixed(1).padStart(5)}% ` +
    `meanIoU=${(result.meanIou * 100).toFixed(1).padStart(5)}% ` +
    `falseTrack=${(result.falseTrackRate * 100).toFixed(0).padStart(3)}% recovery=${recovery}`,
  );
}

const entries = Object.entries(results);
const meanTracked = entries.reduce((sum, [, r]) => sum + r.trackedRate, 0) / entries.length;
const meanIou = entries.reduce((sum, [, r]) => sum + r.meanIou, 0) / entries.length;
const worstFalseTrack = entries.reduce((max, [, r]) => Math.max(max, r.falseTrackRate), 0);
const failedScenarios = entries
  .filter(([, r]) => r.trackedRate < args.min || r.meanIou < args.minIou || r.falseTrackRate > 0.05)
  .map(([name]) => name);
const passed = failedScenarios.length === 0 && meanTracked >= args.min;
const summary = {
  generatedAt: new Date().toISOString(),
  framesPerScenario: 30,
  scenarios: results,
  summary: { meanTrackedRate: meanTracked, meanIou, worstFalseTrackRate: worstFalseTrack },
  gates: { minTrackedRate: args.min, minMeanIou: args.minIou, maxFalseTrackRate: 0.05 },
  failedScenarios,
  passed,
};
console.log(`mean tracked=${(meanTracked * 100).toFixed(1)}%  mean IoU=${(meanIou * 100).toFixed(1)}%  worst false-track=${(worstFalseTrack * 100).toFixed(0)}%`);
if (!passed) {
  console.error(`below tracking gates (${failedScenarios.join(', ') || 'mean'})`);
}

mkdirSync(dirname(args.json), { recursive: true });
writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
process.exit(passed ? 0 : 1);
