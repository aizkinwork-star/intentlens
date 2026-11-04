import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGridOverlaySvg, safeGridSize } from './captureOverlay.js';

test('overlay SVG is a separate transparent grid with 1-based labels and the coordinate convention', () => {
  const svg = buildGridOverlaySvg({ width: 1280, height: 720, gridSize: 64 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 1280 720"/);
  assert.match(svg, /C1/);
  assert.match(svg, /R1/);
  assert.match(svg, /C57/);
  assert.match(svg, /64x64 \| origin top-left/);
  assert.match(svg, /fill="none"/);
  assert.doesNotMatch(svg, /data:image/);
});

test('overlay output is deterministic for the same capture metadata', () => {
  const a = buildGridOverlaySvg({ width: 640, height: 480, gridSize: 32 });
  const b = buildGridOverlaySvg({ width: 640, height: 480, gridSize: 32 });
  assert.equal(a, b);
});

test('an unsupported grid size falls back to the product default rather than inventing a size', () => {
  assert.equal(safeGridSize(999), 64);
  assert.equal(safeGridSize(32), 32);
  assert.throws(() => buildGridOverlaySvg({ width: 0, height: 720 }), /valid width and height/);
});
