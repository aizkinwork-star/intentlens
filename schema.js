// schema.js — checks a GroundingResult BEFORE the UI trusts it.
// A real model can return junk (coordinates outside the image, a target with no
// position, a citation that was never fetched), so nothing gets drawn until it
// passes this check. Used by the browser app and by the server.
import { isValidPoint, isValidBox } from './grid.js';

export const RESULT_STATUSES = ['target_found', 'needs_clarification', 'no_target'];

export const EVIDENCE_KINDS = ['verified_reference', 'web_source', 'visual_inference', 'user_confirmed', 'none'];

const isText = (v) => typeof v === 'string';
const isFilled = (v) => isText(v) && v.trim().length > 0;
const isConfidence = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

function validateTarget(t) {
  if (!t || typeof t !== 'object') return 'target is missing';
  if (!isFilled(t.targetId)) return 'target has no targetId';
  if (!isFilled(t.label)) return 'target has no label';
  if (!isConfidence(t.confidence)) return 'target confidence must be a number in [0,1]';
  if (t.freshness !== 'current_frame') return 'target is not associated with the current frame';
  if (t.point == null && t.box == null) return 'target has neither a point nor a box';

  if (t.point != null) {
    if (!isValidPoint(t.point.x, t.point.y)) return 'target point is outside the image';
  }
  if (t.box != null) {
    if (!isValidBox(t.box)) return 'target box is malformed or outside the image';
  }
  return null;
}

function validateEvidence(list) {
  if (!Array.isArray(list)) return 'evidence must be an array';
  for (const e of list) {
    if (!e || typeof e !== 'object') return 'evidence entry is not an object';
    if (!isFilled(e.title)) return 'evidence entry has no title';
    if (!isFilled(e.claim)) return 'evidence entry has no claim';
    if (!EVIDENCE_KINDS.includes(e.kind)) return `evidence entry has unknown kind: ${e.kind}`;
    if (e.url != null && !/^https?:\/\//i.test(e.url)) return 'evidence url must be http(s)';
  }
  return null;
}

// expected = { requestId, frameId } — pass the active request so a late or stale
// response can never be applied to the wrong frame.
export function validateResult(r, expected = {}) {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'No result returned' };

  if (expected.requestId && r.requestId !== expected.requestId) {
    return { ok: false, reason: 'Result belongs to a different request' };
  }
  if (expected.frameId && r.frameId !== expected.frameId) {
    return { ok: false, reason: 'Result belongs to a different frame' };
  }

  if (!RESULT_STATUSES.includes(r.resultStatus)) {
    return { ok: false, reason: `Unknown resultStatus: ${r.resultStatus}` };
  }
  if (!isFilled(r.answerShort)) return { ok: false, reason: 'Missing answerShort' };
  if (!EVIDENCE_KINDS.includes(r.evidenceKind)) {
    return { ok: false, reason: `Unknown evidenceKind: ${r.evidenceKind}` };
  }
  if (typeof r.needsConfirmation !== 'boolean') return { ok: false, reason: 'needsConfirmation must be a boolean' };
  if (r.uncertaintyNote != null && !isText(r.uncertaintyNote)) return { ok: false, reason: 'uncertaintyNote must be text or null' };
  if (r.requestedClarification != null && !isText(r.requestedClarification)) {
    return { ok: false, reason: 'requestedClarification must be text or null' };
  }

  const evidenceProblem = validateEvidence(r.evidence ?? []);
  if (evidenceProblem) return { ok: false, reason: evidenceProblem };

  if (r.resultStatus === 'target_found') {
    const targetProblem = validateTarget(r.target);
    if (targetProblem) return { ok: false, reason: targetProblem };
  } else if (r.target != null) {
    // A target with no "target_found" status would tempt the UI into drawing a
    // marker the model never actually committed to. Refuse it.
    return { ok: false, reason: `target present but resultStatus is ${r.resultStatus}` };
  }

  return { ok: true };
}
