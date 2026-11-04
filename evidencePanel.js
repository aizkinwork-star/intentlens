// evidencePanel.js — pure model for the right-side image evidence card.
//
// The card only shows a coordinate outline when the analysis passed validation.
// Invalid or contradictory corners are dropped rather than drawn.

const VALID_CORNERS = (corners) => Array.isArray(corners)
  && corners.length === 4
  && corners.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

export function buildEvidenceCard({ capture = null, object = null, analysis = null, candidates = [], expanded = false, analysisState = null } = {}) {
  const component = analysis?.component || null;
  const location = analysis?.location || null;
  const corners = VALID_CORNERS(object?.corners) ? object.corners : VALID_CORNERS(location?.corners) ? location.corners : null;
  const center = object?.center || location?.center || null;
  const gridCell = location?.grid_cell || object?.gridCell || null;
  const identityStatus = object?.identityStatus || component?.identity_status || 'unknown';
  const confirmed = Boolean(object?.confirmed) || identityStatus === 'confirmed_by_user';

  let statusLabel = 'No capture yet';
  if (capture) statusLabel = 'Captured — waiting for analysis';
  if (capture && analysisState === 'unavailable') statusLabel = 'Captured — AI unavailable, saved locally';
  if (capture && analysisState === 'rejected') statusLabel = 'Captured — AI result rejected, no box drawn';
  if (capture && analysisState === 'invalid') statusLabel = 'Captured — coordinates failed validation';
  if (analysis && !analysis.location) statusLabel = 'Captured — no reliable location';
  if (analysis && !confirmed) statusLabel = 'AI candidate — confirm or correct';
  if (confirmed) statusLabel = 'Confirmed by you';

  return {
    captureId: capture?.captureId || object?.captureId || null,
    originalUrl: capture?.originalUrl || null,
    overlayUrl: capture?.overlayUrl || null,
    width: capture?.width || null,
    height: capture?.height || null,
    gridSize: capture?.gridSize || null,
    title: object?.name || component?.name || (capture ? 'Component candidate' : 'No component yet'),
    statusLabel,
    identityStatus,
    confirmed,
    gridCell,
    center,
    corners,
    evidence: Array.isArray(component?.evidence) ? component.evidence.slice(0, 6) : [],
    uncertainty: component?.uncertainty || object?.uncertainty || null,
    instruction: analysis?.instruction || object?.instruction || '',
    nextAction: analysis?.next_action || object?.nextAction || null,
    candidates: Array.isArray(candidates) ? candidates.slice(0, 5) : [],
    analysisState: analysisState || null,
    expanded: Boolean(expanded),
    canExpand: Boolean(capture?.originalUrl),
    drawOutline: Boolean(corners),
  };
}

export function toggleExpanded(card) {
  if (!card || !card.canExpand) return card;
  return { ...card, expanded: !card.expanded };
}
