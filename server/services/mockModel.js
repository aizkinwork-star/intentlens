// Mock grounding so the whole pipeline can be demoed with no API key and no network.
// It answers from the fixed demo phone board in ../../phoneBoard.js, and returns the
// exact same GroundingResult shape as the live adapter (already normalized to 0..1).
// The UI labels this mode as MOCK everywhere, so nobody mistakes it for vision.
import { COMPONENTS } from '../../phoneBoard.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const LOW_CONFIDENCE = 0.7;

function asTarget(p) {
  const point = { x: p.x, y: p.y };
  const box = { x: p.x - p.w / 2, y: p.y - p.h / 2, width: p.w, height: p.h };
  return {
    targetId: p.id,
    label: p.label,
    point,
    box,
    confidence: p.conf,
    freshness: 'current_frame',
  };
}

function byId(id) {
  return COMPONENTS.find((p) => p.id === id) || null;
}

function nearest(point, excludeId) {
  return [...COMPONENTS]
    .filter((p) => p.id !== excludeId)
    .sort((a, b) => dist(a, point) - dist(b, point))[0];
}

export async function mockGrounding({ requestId, frameId, command, userSelectedRegion, lastTargetId }) {
  const started = Date.now();
  await wait(700);

  const text = String(command || '').toLowerCase();
  let hit = COMPONENTS.find((p) => p.re.test(text)) || null;

  // "nearby", "next to that" etc: find the closest different part to the last target.
  if (!hit && /\bnearby|next to|beside|adjacent|close to\b/.test(text)) {
    const anchor = byId(lastTargetId);
    if (anchor) hit = nearest(anchor, anchor.id);
  }

  // "what is this / here / that": use the region the user tapped.
  if (!hit && userSelectedRegion && /\bthis|here|that|these|it\b/.test(text)) {
    hit = [...COMPONENTS].sort((a, b) => dist(a, userSelectedRegion) - dist(b, userSelectedRegion))[0];
  }

  if (!hit) {
    const answer =
      'I can’t tell which part you mean in this demo board. Try “point to the processor”, “where is the battery connector”, or tap a region and say “what is this”.';
    return {
      requestId,
      frameId,
      resultStatus: 'needs_clarification',
      answerShort: answer,
      target: null,
      uncertaintyNote: 'Mock mode matches fixed demo parts by keyword; it is not looking at the image.',
      evidenceKind: 'none',
      evidence: [],
      needsConfirmation: true,
      requestedClarification:
        'Name a part (processor, RAM, storage, battery connector, USB port) or tap the region you mean.',
      meta: { latencyMs: Date.now() - started },
    };
  }

  const target = asTarget(hit);
  const unsure = hit.conf < LOW_CONFIDENCE;

  return {
    requestId,
    frameId,
    resultStatus: 'target_found',
    answerShort: hit.desc,
    target,
    uncertaintyNote: unsure
      ? 'Mock guess from a fixed demo layout with low confidence. Verify it against the real board.'
      : 'Mock answer from the fixed demo layout, not from the camera image.',
    evidenceKind: 'visual_inference',
    evidence: [],
    needsConfirmation: unsure,
    requestedClarification: null,
    meta: { latencyMs: Date.now() - started },
  };
}

export const MOCK_COMPONENT_IDS = COMPONENTS.map((c) => c.id);
