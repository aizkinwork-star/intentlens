// observationContext.js - canonical observation-first context schema
export const IDENTITY_STATES = Object.freeze({
  DETECTED: 'DETECTED',
  CANDIDATE: 'CANDIDATE',
  UNCONFIRMED: 'UNCONFIRMED',
  USER_CONFIRMED: 'USER_CONFIRMED',
  VERIFIED: 'VERIFIED',
  LOST: 'LOST',
});

export const IDENTITY_TRANSITIONS = {
  DETECTED: ['CANDIDATE', 'LOST'],
  CANDIDATE: ['UNCONFIRMED', 'USER_CONFIRMED', 'LOST'],
  UNCONFIRMED: ['CANDIDATE', 'USER_CONFIRMED', 'LOST'],
  USER_CONFIRMED: ['VERIFIED', 'LOST'],
  VERIFIED: ['LOST'],
  LOST: ['DETECTED'],
};

export function canTransition(from, to) {
  return (IDENTITY_TRANSITIONS[from] || []).includes(to);
}

export function createObservation({
  trackId, bbox, center, normalized, cropHash,
  firstSeen = Date.now(), lastSeen = Date.now(), state = IDENTITY_STATES.DETECTED,
} = {}) {
  if (!trackId) throw new Error('trackId required');
  return {
    trackId,
    bbox: bbox || null,
    center: center || null,
    normalized: normalized || null,
    cropHash: cropHash || null,
    firstSeen,
    lastSeen,
    state,
    classification: null, // { candidates: [{label,score,distance}], cropHash, timestamp }
    userCorrection: null, // { label, note, timestamp }
    externalVerification: null,
  };
}

export function setClassification(obs, candidates, cropHash) {
  obs.classification = {
    candidates: (candidates || []).map(c => ({ label: c.label, score: c.score ?? null, distance: c.distance ?? null })),
    cropHash: cropHash || obs.cropHash,
    timestamp: Date.now(),
  };
  if (obs.state === IDENTITY_STATES.DETECTED) obs.state = IDENTITY_STATES.CANDIDATE;
  else if (obs.state === IDENTITY_STATES.CANDIDATE && (candidates||[]).length > 0) obs.state = IDENTITY_STATES.UNCONFIRMED;
  return obs;
}

export function confirmIdentity(obs, label, note = null) {
  obs.userCorrection = { label, note, timestamp: Date.now() };
  obs.state = IDENTITY_STATES.USER_CONFIRMED;
  return obs;
}

export function markLost(obs) {
  obs.state = IDENTITY_STATES.LOST;
  obs.lastSeen = Date.now();
  return obs;
}

export function buildSharedContext({ sessionId, boardId, observations = [], instructions = [], completedSteps = [] } = {}) {
  const obsFacts = observations.map(o => ({
    trackId: o.trackId,
    bbox: o.bbox,
    center: o.center,
    normalized: o.normalized,
    cropHash: o.cropHash,
    firstSeen: o.firstSeen,
    lastSeen: o.lastSeen,
    trackingState: o.state,
  }));
  const predictions = observations.map(o => ({
    trackId: o.trackId,
    candidates: o.classification ? o.classification.candidates : [],
    cropHash: o.classification ? o.classification.cropHash : null,
    timestamp: o.classification ? o.classification.timestamp : null,
    uncertainty: o.classification ? 'model_prediction' : 'none',
  }));
  const confirmed = observations.map(o => ({
    trackId: o.trackId,
    userConfirmed: o.userCorrection ? o.userCorrection.label : null,
    externalVerification: o.externalVerification,
    source: o.userCorrection ? 'user' : (o.externalVerification ? 'external' : null),
  }));
  const payload = {
    version: '1.0',
    sessionId: sessionId || null,
    boardId: boardId || null,
    observedFacts: obsFacts,
    predictions,
    confirmedInformation: confirmed,
    instructions: instructions || [],
    completedSteps: completedSteps || [],
  };
  // canonical hash (simple deterministic JSON)
  const str = JSON.stringify(payload, Object.keys(payload).sort());
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
  payload.contextHash = 'ctx_' + (h >>> 0).toString(16);
  return payload;
}

export function createClassificationCache() {
  const map = new Map();
  return {
    get(trackId, cropHash) { return map.get(trackId + '::' + cropHash) || null; },
    set(trackId, cropHash, result) { map.set(trackId + '::' + cropHash, { ...result, timestamp: Date.now() }); },
    invalidate(trackId) { for (const k of [...map.keys()]) if (k.startsWith(trackId + '::')) map.delete(k); },
    size() { return map.size; },
  };
}

export function buildExportSample({ observation, session, imageQuality = null }) {
  return {
    cropHash: observation.cropHash,
    sessionId: session || null,
    trackId: observation.trackId,
    timestamp: observation.lastSeen,
    prediction: observation.classification ? observation.classification.candidates : null,
    userCorrection: observation.userCorrection,
    imageQuality,
  };
}
