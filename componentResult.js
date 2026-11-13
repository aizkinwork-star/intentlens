// componentResult.js — shared structured component result validation.
//
// The model speaks in 0..1000 integer coordinates. The app stores normalized
// 0..1 coordinates. This module is the single boundary that converts and
// validates a result. It never clamps an invalid coordinate into a valid one:
// a wrong marker is worse than no marker.
//
// Used by the server (before persisting/returning a result) and by the client
// (before drawing one), so both sides enforce the same rules.

export const IDENTITY_STATUSES = ['confirmed_by_user', 'ai_candidate', 'unknown'];
export const MODEL_IDENTITY_STATUSES = ['ai_candidate', 'unknown'];
export const UNCERTAINTIES = ['low', 'medium', 'high'];
export const NEXT_ACTIONS = ['instruction', 'request_closer_image', 'ask_question'];

const MAX_NAME = 120;
const MAX_EVIDENCE = 6;
const MAX_INSTRUCTION = 700;

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function strictModelUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1000 ? value / 1000 : null;
}

function strictModelPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const x = strictModelUnit(point.x);
  const y = strictModelUnit(point.y);
  if (x == null || y == null) return null;
  return { x, y };
}

function strictUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function strictNormalizedPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const x = strictUnit(point.x);
  const y = strictUnit(point.y);
  if (x == null || y == null) return null;
  return { x, y };
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

// A component outline is a simple, consistently wound quadrilateral. Reject
// self-intersecting or bow-tie corner orders instead of drawing them.
function cornersAreConsistent(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const area = cross(a, b, c);
    if (Math.abs(area) < 1e-9) continue;
    const next = Math.sign(area);
    if (sign === 0) sign = next;
    else if (sign !== next) return false;
  }
  return sign !== 0;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Convert and validate the model's raw component JSON.
 * Raw coordinates are 0..1000 integers (the model coordinate convention).
 * Returns { ok: true, result } or { ok: false, errors }.
 */
export function toComponentResult(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['The model did not return a JSON object.'] };
  }

  const rawComponent = raw.component;
  if (!rawComponent || typeof rawComponent !== 'object') {
    errors.push('component is required.');
  }
  const component = rawComponent && typeof rawComponent === 'object' ? rawComponent : {};

  let name = text(component.name, MAX_NAME);
  const identity = text(component.identity_status, 30);
  if (!MODEL_IDENTITY_STATUSES.includes(identity)) {
    if (identity === 'confirmed_by_user') {
      errors.push('The model cannot mark its own identification as user-confirmed.');
    } else {
      errors.push('component.identity_status must be ai_candidate or unknown.');
    }
  }

  if (!name) {
    if (identity === 'unknown') name = 'Unknown component';
    else errors.push('component.name is required when the component is a candidate.');
  }

  const evidence = Array.isArray(component.evidence)
    ? component.evidence.map((item) => text(item, 180)).filter(Boolean).slice(0, MAX_EVIDENCE)
    : [];
  if (component.evidence != null && !Array.isArray(component.evidence)) {
    errors.push('component.evidence must be an array of strings.');
  }

  const uncertainty = text(component.uncertainty, 20);
  if (!UNCERTAINTIES.includes(uncertainty)) {
    errors.push('component.uncertainty must be low, medium or high.');
  }

  let location = null;
  if (raw.location != null) {
    if (typeof raw.location !== 'object') {
      errors.push('location must be an object or null.');
    } else {
      const center = strictModelPoint(raw.location.center);
      if (!center) {
        errors.push('location.center must be two numbers between 0 and 1000.');
      }

      const rawCorners = raw.location.corners;
      if (!Array.isArray(rawCorners) || rawCorners.length !== 4) {
        errors.push('location.corners must contain exactly four points.');
      } else {
        const corners = rawCorners.map(strictModelPoint);
        if (corners.some((point) => !point)) {
          errors.push('Every location.corners point must be between 0 and 1000.');
        } else if (!cornersAreConsistent(corners)) {
          errors.push('location.corners are not a consistent, non-crossing outline.');
        } else if (center && !pointInPolygon(center, corners)) {
          errors.push('location.center is outside the corner outline.');
        } else if (center) {
          location = { center, corners };
        }
      }
    }
  }

  const nextAction = text(raw.next_action, 40);
  if (!NEXT_ACTIONS.includes(nextAction)) {
    errors.push('next_action must be instruction, request_closer_image or ask_question.');
  }

  const instruction = text(raw.instruction, MAX_INSTRUCTION);
  if (!instruction) errors.push('instruction is required.');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    result: {
      component: { name, identity_status: identity, evidence, uncertainty },
      location,
      next_action: nextAction,
      instruction,
    },
  };
}

/**
 * Validate an already-normalized result (server output, before the client draws
 * it). This is a second, independent check: the model is never trusted blindly.
 */
export function validateNormalizedComponentResult(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Result must be an object.'] };

  const component = raw.component;
  if (!component || typeof component !== 'object') {
    errors.push('component is required.');
  } else {
    if (!text(component.name, MAX_NAME)) errors.push('component.name is required.');
    if (!IDENTITY_STATUSES.includes(component.identity_status)) {
      errors.push('component.identity_status is invalid.');
    }
    if (!UNCERTAINTIES.includes(component.uncertainty)) {
      errors.push('component.uncertainty is invalid.');
    }
    if (component.evidence != null && !Array.isArray(component.evidence)) {
      errors.push('component.evidence must be an array.');
    }
  }

  if (!NEXT_ACTIONS.includes(raw.next_action)) errors.push('next_action is invalid.');
  if (!text(raw.instruction, MAX_INSTRUCTION)) errors.push('instruction is required.');

  if (raw.location != null) {
    if (typeof raw.location !== 'object') {
      errors.push('location must be an object or null.');
    } else {
      const center = strictNormalizedPoint(raw.location.center);
      if (!center) errors.push('location.center must be within 0..1.');
      const rawCorners = raw.location.corners;
      if (!Array.isArray(rawCorners) || rawCorners.length !== 4) {
        errors.push('location.corners must contain exactly four points.');
      } else {
        const corners = rawCorners.map(strictNormalizedPoint);
        if (corners.some((point) => !point)) {
          errors.push('location.corners must be within 0..1.');
        } else if (!cornersAreConsistent(corners)) {
          errors.push('location.corners are not a consistent outline.');
        } else if (center && !pointInPolygon(center, corners)) {
          errors.push('location.center is outside the corner outline.');
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, result: raw };
}
