#!/usr/bin/env node
// Copy the shared pure modules into pwa/lib before local preview or Pages deploy.
// The copies are generated and gitignored, so there is one source of truth in
// the repository root.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pwa = join(root, 'pwa');
const lib = join(pwa, 'lib');

const shared = [
  'grid.js',
  'componentResult.js',
];

mkdirSync(lib, { recursive: true });
for (const file of shared) {
  copyFileSync(join(root, file), join(lib, file));
  console.log(`copied ${file} -> pwa/lib/${file}`);
}

writeFileSync(join(pwa, '.nojekyll'), '');
console.log('PWA prepared. Serve the pwa/ folder over HTTPS (or localhost).');
