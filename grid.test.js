// Coordinate math + result validation. Run with:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gridSize,
  setGridSize,
  GRID_SIZES,
  DEFAULT_GRID_SIZE,
  pointToCell,
  gridCell,
  cellToCenter,
  isValidPoint,
  isValidBox,
  clientToNormalized,
  modelPointToNormalized,
  modelBoxToNormalized,
  fitContain,
  rectToNormalized,
  isInsideNormalizedRect,
  boxCenter,
} from './grid.js';
import { validateResult } from './schema.js';

// ---------------------------------------------------------------------------
// Cell mapping (architecture.md §14.2)
// ---------------------------------------------------------------------------
test('top-left maps to R1C1', () => assert.equal(pointToCell(0, 0).cellId, 'R1C1'));
test('x=1,y=1 maps to R64C64 (not 65!)', () => assert.equal(pointToCell(1, 1).cellId, 'R64C64'));
test('0.999 lands in the last cell', () => assert.equal(pointToCell(0.999, 0.999).cellId, 'R64C64'));
test('the exact centre is row 32 col 32 -> R33C33', () => {
  const { row, col, cellId } = pointToCell(0.5, 0.5);
  assert.deepEqual({ row, col }, { row: 32, col: 32 });
  assert.equal(cellId, 'R33C33');
});
test('middle-ish point', () => assert.equal(pointToCell(0.62, 0.4).cellId, 'R26C40'));
test('out of range throws', () => assert.throws(() => pointToCell(1.2, 0.5)));

// ---------------------------------------------------------------------------
// All five grid sizes (§14.2): the same point lands in a different cell
// address as the grid changes, but the normalized point never moves.
// ---------------------------------------------------------------------------
test('grid sizes are exactly the five allowed sizes', () => {
  assert.deepEqual(GRID_SIZES, [16, 24, 32, 64, 128]);
});
test('default size is 64 and setGridSize changes it', () => {
  assert.equal(DEFAULT_GRID_SIZE, 64);
  assert.equal(gridSize(), 64);
  setGridSize(32);
  assert.equal(gridSize(), 32);
  setGridSize(64);
  assert.equal(gridSize(), 64);
});
test('setGridSize rejects unsupported sizes', () => {
  assert.throws(() => setGridSize(10));
  assert.equal(gridSize(), 64);
});
test('gridCell id for the top-left point at every size', () => {
  const expected = { 16: 'R1C1', 24: 'R1C1', 32: 'R1C1', 64: 'R1C1', 128: 'R1C1' };
  for (const size of GRID_SIZES) {
    setGridSize(size);
    assert.equal(gridCell({ x: 0, y: 0 }).id, expected[size], `size ${size}`);
  }
  setGridSize(64);
});
test('gridCell id for the centre point at every size', () => {
  const expected = { 16: 'R9C9', 24: 'R13C13', 32: 'R17C17', 64: 'R33C33', 128: 'R65C65' };
  for (const size of GRID_SIZES) {
    setGridSize(size);
    const c = gridCell({ x: 0.5, y: 0.5 });
    assert.deepEqual({ row: c.row, col: c.col }, { row: size / 2, col: size / 2 }, `size ${size}`);
    assert.equal(c.id, expected[size], `size ${size}`);
  }
  setGridSize(64);
});
test('gridCell id for the bottom-right edge point at every size', () => {
  const expected = { 16: 'R16C16', 24: 'R24C24', 32: 'R32C32', 64: 'R64C64', 128: 'R128C128' };
  for (const size of GRID_SIZES) {
    setGridSize(size);
    assert.equal(gridCell({ x: 1, y: 1 }).id, expected[size], `size ${size}`);
  }
  setGridSize(64);
});
test('pointToCell follows the active size and defaults to 64', () => {
  setGridSize(32);
  assert.equal(pointToCell(0.62, 0.4).cellId, 'R13C20');
  setGridSize(64);
  assert.equal(pointToCell(0.62, 0.4).cellId, 'R26C40');
});
test('cellToCenter round-trips through gridCell at every size', () => {
  for (const size of GRID_SIZES) {
    setGridSize(size);
    const p = cellToCenter(2, 3);
    const c = gridCell(p);
    assert.equal(c.id, `R3C4`);
  }
  setGridSize(64);
});
test('NaN and Infinity are invalid', () => {
  assert.equal(isValidPoint(NaN, 0.5), false);
  assert.equal(isValidPoint(0.5, Infinity), false);
  assert.equal(isValidPoint(0.5, 0.5), true);
});
test('cell center round-trips', () => {
  const { x, y } = cellToCenter(6, 9);
  assert.equal(pointToCell(x, y).cellId, 'R7C10');
});

// ---------------------------------------------------------------------------
// Model grid (0..1000) -> normalized (0..1)
// ---------------------------------------------------------------------------
test('model coordinates divide by 1000', () => {
  assert.deepEqual(modelPointToNormalized(600, 400), { x: 0.6, y: 0.4 });
  assert.deepEqual(modelPointToNormalized(0, 1000), { x: 0, y: 1 });
});
test('a small edge overshoot is clamped, a wild value is rejected', () => {
  assert.deepEqual(modelPointToNormalized(1001, 999), { x: 1, y: 0.999 });
  assert.equal(modelPointToNormalized(5000, 500), null);
  assert.equal(modelPointToNormalized(NaN, 500), null);
});
test('model box corners become a normalized x/y/width/height box', () => {
  const box = modelBoxToNormalized(560, 330, 640, 470);
  assert.ok(box);
  assert.equal(Number(box.x.toFixed(3)), 0.56);
  assert.equal(Number(box.width.toFixed(3)), 0.08);
  assert.equal(Number(box.height.toFixed(3)), 0.14);
});
test('reversed box corners are swapped, not rejected', () => {
  const box = modelBoxToNormalized(640, 470, 560, 330);
  assert.ok(box);
  assert.equal(Number(box.x.toFixed(3)), 0.56);
  assert.equal(Number(box.y.toFixed(3)), 0.33);
});
test('a degenerate box is rejected', () => {
  assert.equal(modelBoxToNormalized(500, 500, 500, 500), null);
});

// ---------------------------------------------------------------------------
// Boxes + letterboxing (§5.5)
// ---------------------------------------------------------------------------
test('box validity', () => {
  assert.equal(isValidBox({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), true);
  assert.equal(isValidBox({ x: 0.9, y: 0.9, width: 0.3, height: 0.1 }), false); // leaves the frame
  assert.equal(isValidBox({ x: 0.1, y: 0.1, width: 0, height: 0.2 }), false);
});
test('box centre', () => {
  const c = boxCenter({ x: 0.2, y: 0.4, width: 0.2, height: 0.2 });
  assert.equal(Number(c.x.toFixed(3)), 0.3);
  assert.equal(Number(c.y.toFixed(3)), 0.5);
});

test('a 4:3 image letterboxes inside a 16:9 frame and keeps its aspect ratio', () => {
  const r = fitContain(4000, 3000, 1280, 720);
  assert.equal(r.height, 720);
  assert.equal(r.width, 960);
  assert.equal(r.left, 160);
  assert.equal(r.top, 0);
  // No cropping: the whole source is drawn.
  assert.ok(r.width <= 1280 && r.height <= 720);
});

test('the drawn image rect converts to normalized frame coordinates', () => {
  const r = fitContain(4000, 3000, 1280, 720);
  const n = rectToNormalized(r, 1280, 720);
  assert.equal(Number(n.x0.toFixed(3)), 0.125);
  assert.equal(n.y0, 0);
  assert.equal(Number(n.x1.toFixed(3)), 0.875);
  assert.equal(n.y1, 1);
});

test('a tap converts to normalized coordinates against the frame rect', () => {
  const p = clientToNormalized(150, 250, { left: 50, top: 50, width: 200, height: 400 });
  assert.deepEqual(p, { x: 0.5, y: 0.5 });
});

test('taps on the letterbox bars are outside the image rect', () => {
  const n = rectToNormalized(fitContain(4000, 3000, 1280, 720), 1280, 720);
  assert.equal(isInsideNormalizedRect(0.5, 0.5, n), true);
  assert.equal(isInsideNormalizedRect(0.05, 0.5, n), false); // left black bar
  assert.equal(isInsideNormalizedRect(0.95, 0.5, n), false); // right black bar
});

// ---------------------------------------------------------------------------
// Result validation (§8.5, §14.1)
// ---------------------------------------------------------------------------
const good = {
  requestId: 'req_1',
  frameId: 'frame_001',
  resultStatus: 'target_found',
  answerShort: 'This looks like the display connector.',
  target: {
    targetId: 'J2',
    label: 'display connector (proposed)',
    point: { x: 0.68, y: 0.74 },
    box: { x: 0.62, y: 0.69, width: 0.12, height: 0.1 },
    gridCell: 'R48C44',
    confidence: 0.71,
    freshness: 'current_frame',
  },
  uncertaintyNote: null,
  evidenceKind: 'visual_inference',
  evidence: [],
  needsConfirmation: false,
  requestedClarification: null,
};

test('validator accepts a well-formed result', () => {
  assert.equal(validateResult(good).ok, true);
});
test('validator rejects coordinates outside the image', () => {
  const r = structuredClone(good);
  r.target.point.x = 3;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a malformed box', () => {
  const r = structuredClone(good);
  r.target.box.width = -0.1;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a confidence outside [0,1]', () => {
  const r = structuredClone(good);
  r.target.confidence = 1.4;
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a target that is not on the current frame', () => {
  const r = structuredClone(good);
  r.target.freshness = 'stale';
  assert.equal(validateResult(r).ok, false);
});
test('validator rejects a target with no position at all', () => {
  const r = structuredClone(good);
  delete r.target.point;
  delete r.target.box;
  assert.equal(validateResult(r).ok, false);
});
test('a result cannot claim a cell that disagrees with its point', () => {
  const r = structuredClone(good);
  r.target.gridCell = 'R1C1';
  assert.equal(validateResult(r).ok, false);
});
test('no marker is allowed when there is no target', () => {
  const r = { ...structuredClone(good), resultStatus: 'needs_clarification' };
  assert.equal(validateResult(r).ok, false, 'target present on a non-target result must be refused');
  r.target = null;
  assert.equal(validateResult(r).ok, true);
});
test('a stale frame id is refused, so an old overlay is never treated as current', () => {
  assert.equal(validateResult(good, { requestId: 'req_1', frameId: 'frame_002' }).ok, false);
  assert.equal(validateResult(good, { requestId: 'req_2', frameId: 'frame_001' }).ok, false);
  assert.equal(validateResult(good, { requestId: 'req_1', frameId: 'frame_001' }).ok, true);
});
test('evidence must be real, well-formed entries', () => {
  const r = structuredClone(good);
  r.evidence = [{ title: 'Manual', kind: 'web_source', claim: 'pin 1 is VBUS', url: 'javascript:alert(1)' }];
  assert.equal(validateResult(r).ok, false);
});
