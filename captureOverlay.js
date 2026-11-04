// captureOverlay.js — grid overlay geometry, shared by the browser and server.
//
// The original capture is immutable. This module produces a *separate* overlay:
//   - buildGridOverlaySvg() returns an SVG string (server side / tests / display)
//   - drawGridOnCanvas() draws the same grid onto a copy canvas in the browser
//
// Coordinate convention, everywhere:
//   origin top-left, x increases right, y increases down.
//   Row/column labels are 1-based (R1C1 is the top-left cell).

import { GRID_SIZES, DEFAULT_GRID_SIZE } from './grid.js';

export function safeGridSize(value) {
  const n = Number(value);
  return GRID_SIZES.includes(n) ? n : DEFAULT_GRID_SIZE;
}

function safeDimension(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 && n <= 20000 ? n : null;
}

/**
 * Build a standalone SVG overlay sized to the capture. It has a transparent
 * background so it can sit on top of the original image without changing it.
 */
export function buildGridOverlaySvg({ width, height, gridSize = DEFAULT_GRID_SIZE } = {}) {
  const w = safeDimension(width);
  const h = safeDimension(height);
  if (!w || !h) throw new Error('buildGridOverlaySvg requires valid width and height');
  const size = safeGridSize(gridSize);
  const cellW = w / size;
  const cellH = h / size;
  const labelEvery = size > 32 ? 8 : size > 16 ? 4 : 2;
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Coordinate grid overlay">`);
  parts.push('<rect x="0" y="0" width="100%" height="100%" fill="none"/>');

  for (let i = 1; i < size; i += 1) {
    const x = Number((i * cellW).toFixed(3));
    const y = Number((i * cellH).toFixed(3));
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#50c8ff" stroke-opacity="0.28" stroke-width="1"/>`);
    parts.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#50c8ff" stroke-opacity="0.28" stroke-width="1"/>`);
  }

  // Axis labels every few cells. 1-based to match R1C1.
  const fontSize = Math.max(9, Math.round(Math.min(w, h) / 70));
  for (let i = 0; i < size; i += labelEvery) {
    const x = Number((i * cellW + 3).toFixed(3));
    const y = Number((i * cellH + fontSize + 2).toFixed(3));
    parts.push(`<text x="${x}" y="${y}" fill="#50c8ff" fill-opacity="0.85" font-family="monospace" font-size="${fontSize}">C${i + 1}</text>`);
    parts.push(`<text x="3" y="${Number((i * cellH + fontSize + 2).toFixed(3))}" fill="#50c8ff" fill-opacity="0.85" font-family="monospace" font-size="${fontSize}">R${i + 1}</text>`);
  }

  parts.push(`<text x="${Number(w - 6).toFixed(3)}" y="${Number(h - 6).toFixed(3)}" text-anchor="end" fill="#50c8ff" fill-opacity="0.9" font-family="monospace" font-size="${fontSize}">${size}x${size} | origin top-left</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Draw the same grid onto a browser canvas context. Used to make a raster
 * overlay for the vision request without touching the original capture.
 */
export function drawGridOnCanvas(ctx, { width, height, gridSize = DEFAULT_GRID_SIZE } = {}) {
  const w = safeDimension(width);
  const h = safeDimension(height);
  if (!ctx || !w || !h) return;
  const size = safeGridSize(gridSize);
  const cellW = w / size;
  const cellH = h / size;
  const labelEvery = size > 32 ? 8 : size > 16 ? 4 : 2;
  const fontSize = Math.max(9, Math.round(Math.min(w, h) / 70));

  ctx.save();
  ctx.strokeStyle = 'rgba(80, 200, 255, 0.28)';
  ctx.lineWidth = 1;
  for (let i = 1; i < size; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * cellW, 0);
    ctx.lineTo(i * cellW, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cellH);
    ctx.lineTo(w, i * cellH);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(80, 200, 255, 0.85)';
  ctx.font = `${fontSize}px monospace`;
  ctx.textBaseline = 'top';
  for (let i = 0; i < size; i += labelEvery) {
    ctx.fillText(`C${i + 1}`, i * cellW + 3, 3);
    ctx.fillText(`R${i + 1}`, 3, i * cellH + 3);
  }
  ctx.fillText(`${size}x${size} | origin top-left`, w - fontSize * 12, h - fontSize - 4);
  ctx.restore();
}
