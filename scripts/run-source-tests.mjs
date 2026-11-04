#!/usr/bin/env node
// Run only source tests. `node --test` with no arguments also discovers stale
// copies under electron/release, which makes the count and failures misleading.
// This runner walks the repository once and excludes build output.
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'datasets',
  'intentlens-data',
  'release',
  join('electron', 'release'),
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(rel) || EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(root).sort();
if (files.length === 0) {
  console.error('No source test files found.');
  process.exit(1);
}

console.log(`Running ${files.length} source test files (excluding build output).`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
