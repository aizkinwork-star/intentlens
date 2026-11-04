// grid.js — all coordinate math lives here, in ONE place.
// Shared by the browser app and the Node backend (import it from both; never duplicate).
//
// Canonical coordinates are "normalized": x and y are between 0 and 1.
// x=0 is the left edge, x=1 the right edge. y=0 is the top, y=1 the bottom.
// This way a point means the same thing whatever size the screen or image is.
//
// The Meta model speaks a DIFFERENT grid (integers 0..1000), so convert at the
// boundary with modelPointToNormalized / modelBoxToNormalized and keep 0..1 inside.
//
// Grid size (16, 24, 32, 64 or 128) only changes the VISUAL cell address. It never
// changes the stored normalized coordinates, the tracker resolution, or the image
// sent to a model. Use setGridSize() to switch; everything else reads gridSize().

export const GRID_SIZES = [16, 24, 32, 64, 128];
// The product default is 64x64. One source of truth for the browser, the
// backend, and the tests; do not carry a second "test default" here.
export const DEFAULT_GRID_SIZE = 64;

export let GRID = DEFAULT_GRID_SIZE;

export function gridSize() {
  return GRID;
}

export function setGridSize(size) {
  if (!GRID_SIZES.includes(size)) {
    throw new Error(`Unsupported grid size ${size}; use one of ${GRID_SIZES.join(', ')}`);
  }
  GRID = size;
}

// Muse Spark reports positions on a 0..1000 grid (see architecture.md §8).
export const MODEL_GRID = 1000;

// The docs warn the model can emit a value slightly outside the range (e.g. 1001)
// for something touching the edge. Small overshoot is clamped; anything wilder is junk.
const MODEL_TOLERANCE = 20;

export const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Is this a usable point? (finite numbers between 0 and 1)
export function isValidPoint(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

// Turn a normalized point into a grid cell like "R8C11" (architecture.md §14.2).
// row/col are 0-based internally; id is 1-based for display.
// Math.floor(x * size) gives 0..size, but x=1 would give size (doesn't exist), so clamp.
export function gridCell(point, size = GRID) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error("Invalid normalized point");
  }
  const n = Math.min(size - 1, Math.max(0, Math.floor(point.x * size)));
  const m = Math.min(size - 1, Math.max(0, Math.floor(point.y * size)));
  const col = n;
  const row = m;
  return { row, col, id: `R${row + 1}C${col + 1}` };
}

// Backward-compatible wrapper used by older callers: returns { row, col, cellId }.
export function pointToCell(x, y, size = GRID) {
  const { row, col, id } = gridCell({ x, y }, size);
  return { row, col, cellId: id };
}

// The reverse: the center point of a cell (row/col counted from 0).
export function cellToCenter(row, col, size = GRID) {
  return { x: (col + 0.5) / size, y: (row + 0.5) / size };
}

// Turn a tap on screen into a normalized point.
// rect = the on-screen rectangle of the frame (from element.getBoundingClientRect()).
// The frame element is exactly what gets sent to the model, so no letterbox maths is
// needed here: a tap at 25% across the frame is x=0.25 in the analysed image too.
export function clientToNormalized(clientX, clientY, rect) {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  return { x: clamp01(x), y: clamp01(y) };
}

// ---------------------------------------------------------------------------
// Bounding boxes (normalized 0..1, origin top-left)
// ---------------------------------------------------------------------------

// A box must be finite, positive-sized and inside the frame.
// 1e-4 of slack absorbs float noise like 0.9999999 + 0.0000002.
export function isValidBox(b) {
  if (!b || typeof b !== 'object') return false;
  const { x, y, width, height } = b;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (width <= 0 || height <= 0) return false;
  if (x < 0 || y < 0) return false;
  return x + width <= 1 + 1e-4 && y + height <= 1 + 1e-4;
}

export function boxCenter(b) {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// ---------------------------------------------------------------------------
// Model grid (0..1000 integers) -> normalized (0..1)
// ---------------------------------------------------------------------------

// Returns NaN when the value is missing or materially out of range.
export function modelToNormalized(value) {
  if (!Number.isFinite(value)) return NaN;
  if (value < -MODEL_TOLERANCE || value > MODEL_GRID + MODEL_TOLERANCE) return NaN;
  return clamp01(value / MODEL_GRID);
}

// Returns null instead of a half-valid point.
export function modelPointToNormalized(x, y) {
  const nx = modelToNormalized(x);
  const ny = modelToNormalized(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: nx, y: ny };
}

// Model boxes arrive as corners (x_min, y_min, x_max, y_max). Corners in the wrong
// order are swapped rather than rejected; a degenerate box is rejected.
export function modelBoxToNormalized(xMin, yMin, xMax, yMax) {
  const xs = [modelToNormalized(xMin), modelToNormalized(xMax)];
  const ys = [modelToNormalized(yMin), modelToNormalized(yMax)];
  if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) return null;
  const [x0, x1] = xs[0] <= xs[1] ? xs : [xs[1], xs[0]];
  const [y0, y1] = ys[0] <= ys[1] ? ys : [ys[1], ys[0]];
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return isValidBox(box) && box.width > 0 && box.height > 0 ? box : null;
}

// ---------------------------------------------------------------------------
// Letterboxing
// ---------------------------------------------------------------------------
// A 4:3 phone camera in a 16:9 frame leaves black bars. The frame element is still
// what the model sees, so coordinates stay valid across the whole frame -- but the
// grid should only be drawn over real image content, and taps on the bars ignored.
//
// fitContain returns the drawn image rectangle in FRAME PIXELS.
export function fitContain(sourceW, sourceH, frameW, frameH) {
  if (!(sourceW > 0 && sourceH > 0 && frameW > 0 && frameH > 0)) {
    return { left: 0, top: 0, width: frameW || 0, height: frameH || 0 };
  }
  const scale = Math.min(frameW / sourceW, frameH / sourceH);
  const width = sourceW * scale;
  const height = sourceH * scale;
  return { left: (frameW - width) / 2, top: (frameH - height) / 2, width, height };
}

// The same rectangle expressed in normalized 0..1 frame coordinates.
export function rectToNormalized(rect, frameW, frameH) {
  return {
    x0: clamp01(rect.left / frameW),
    y0: clamp01(rect.top / frameH),
    x1: clamp01((rect.left + rect.width) / frameW),
    y1: clamp01((rect.top + rect.height) / frameH),
  };
}

export function isInsideNormalizedRect(x, y, r, slack = 0.004) {
  return x >= r.x0 - slack && x <= r.x1 + slack && y >= r.y0 - slack && y <= r.y1 + slack;
}
