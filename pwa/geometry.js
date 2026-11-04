// pwa/geometry.js — marker geometry shared by the overlay and tests.
// Normalized model coordinates are 0..1. The SVG overlay uses a 0..1000
// viewBox, so every drawn point is multiplied by 1000 (never clamped).

export function markerSvgPoints(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return [];
  return corners.map((point) => {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: x * 1000, y: y * 1000 };
  });
}

export function polygonPointsAttribute(corners) {
  const points = markerSvgPoints(corners);
  if (points.some((point) => !point)) return '';
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

/** Four edge midpoints of a rectangle, in top, right, bottom, left order. */
export function edgeMidpoints(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return [];
  const [tl, tr, br, bl] = corners;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [mid(tl, tr), mid(tr, br), mid(br, bl), mid(bl, tl)];
}
