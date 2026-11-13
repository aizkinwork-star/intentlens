// Converts the model's schema-constrained JSON into the GroundingResult the UI uses,
// and decides the evidence labels. Anything materially wrong is rejected rather than
// "repaired", because a wrong marker is worse than no marker.
import { modelPointToNormalized, modelBoxToNormalized } from '../../grid.js';
import { appError } from '../lib/errors.js';

const MAX_ANSWER = 220;

function tidyAnswer(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= MAX_ANSWER) return flat;
  const cut = flat.slice(0, MAX_ANSWER);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// A citation is only evidence if the API actually returned one AND a search really
// ran. The model's own prose is never allowed to create a source.
function buildEvidence({ citations, referencePack, searchedWeb }) {
  const evidence = [];
  if (searchedWeb) {
    for (const citation of citations || []) {
      evidence.push({
        title: citation.title || citation.url,
        url: citation.url,
        kind: 'web_source',
        claim: citation.citedText || 'Source cited by the model while answering.',
      });
    }
  }
  for (const ref of referencePack || []) {
    if (!ref.verifiedByUser) continue;
    evidence.push({
      title: ref.title,
      kind: 'verified_reference',
      claim: ref.summary ? String(ref.summary).slice(0, 200) : `User-confirmed ${ref.kind || 'reference'}.`,
    });
  }
  return evidence;
}

function deriveEvidenceKind({ evidence, searchedWeb, resultStatus }) {
  if (evidence.some((e) => e.kind === 'verified_reference')) return 'verified_reference';
  if (searchedWeb && evidence.some((e) => e.kind === 'web_source')) return 'web_source';
  if (resultStatus === 'target_found') return 'visual_inference';
  return 'none';
}

export function toGroundingResult({ raw, request, citations = [], searchedWeb = false }) {
  if (!raw || typeof raw !== 'object') throw appError('MODEL_BAD_RESPONSE', 'The model did not return a JSON object.');

  const status = raw.resultStatus;
  if (!['target_found', 'needs_clarification', 'no_target'].includes(status)) {
    throw appError('RESULT_SCHEMA_INVALID', `Unknown resultStatus from the model: ${String(status)}`);
  }

  const answerShort = tidyAnswer(raw.answerShort);
  if (!answerShort) throw appError('RESULT_SCHEMA_INVALID', 'The model returned no answer text.');

  let target = null;
  let droppedTarget = false;

  if (status === 'target_found') {
    const t = raw.target;
    if (!t || typeof t !== 'object') {
      throw appError('RESULT_SCHEMA_INVALID', 'The model reported target_found with no target.');
    }

    // Muse Spark grounds on 0..1000. Convert here, once, to the canonical 0..1 frame.
    const point = modelPointToNormalized(t.x, t.y);
    if (!point) {
      throw appError('RESULT_SCHEMA_INVALID', `The model returned an unusable point (${t.x}, ${t.y}).`);
    }

    let box = null;
    if (t.box != null) {
      box = modelBoxToNormalized(t.box.x_min, t.box.y_min, t.box.x_max, t.box.y_max);
      if (!box) {
        throw appError('RESULT_SCHEMA_INVALID', 'The model returned a box outside the image.');
      }
    }

    if (!Number.isFinite(t.confidence) || t.confidence < 0 || t.confidence > 1) {
      throw appError('RESULT_SCHEMA_INVALID', 'The model returned a confidence outside [0,1].');
    }

    const label = String(t.label ?? '').replace(/\s+/g, ' ').trim();
    const targetId = String(t.targetId ?? '').replace(/\s+/g, ' ').trim();
    if (!label || !targetId) {
      throw appError('RESULT_SCHEMA_INVALID', 'The model returned a target with no id or label.');
    }

    target = {
      targetId,
      label,
      point,
      box,
      confidence: t.confidence,
      freshness: 'current_frame',
    };
  } else if (raw.target != null) {
    // Inconsistent model output: refuse to turn it into a marker.
    droppedTarget = true;
  }

  const evidence = buildEvidence({ citations, referencePack: request.referencePack, searchedWeb });

  const requestedClarification =
    status === 'needs_clarification'
      ? String(raw.requestedClarification || answerShort).replace(/\s+/g, ' ').trim()
      : null;

  // A low-confidence point plus a quiet "not sure" is how markers get trusted when
  // they should not. Force the confirmation step instead.
  const lowConfidence = target ? target.confidence < 0.6 : false;
  const needsConfirmation = Boolean(raw.needsConfirmation) || lowConfidence || status === 'needs_clarification';

  return {
    resultStatus: status,
    answerShort,
    target,
    uncertaintyNote: raw.uncertaintyNote ? String(raw.uncertaintyNote).replace(/\s+/g, ' ').trim().slice(0, 240) : null,
    evidenceKind: deriveEvidenceKind({ evidence, searchedWeb, resultStatus: status }),
    evidence,
    needsConfirmation,
    requestedClarification,
    plan: raw.plan && typeof raw.plan === 'object' ? raw.plan : null,
    ...(droppedTarget ? { droppedTarget: true } : {}),
  };
}
