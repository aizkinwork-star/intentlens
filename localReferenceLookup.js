// localReferenceLookup.js — supporting k-NN lookup, never a component authority.
//
// The medoid experiment did not meet its accuracy/coverage gate, so this module
// exposes every result as an UNVERIFIED candidate. A raw nearest-neighbour
// distance is not a probability and is never shown as a percentage.

export const UNVERIFIED_NOTE = 'Unverified local dataset candidate. Raw distance is not a probability.';
export const MATCHER_NOTE = 'The local k-NN index is a reference lookup only; the AI analysis and user confirmation decide identity.';

function roundDistance(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

/**
 * Turn a KNNClassifier result into candidate objects. Even when the classifier
 * rejects the match (too far/ambiguous), nearby labels can be useful context,
 * but they stay explicitly unverified.
 */
export function toUnverifiedCandidates(result, { max = 5 } = {}) {
  if (!result || !Array.isArray(result.neighbors) || result.neighbors.length === 0) return [];
  const byLabel = new Map();
  for (const neighbor of result.neighbors) {
    const label = String(neighbor?.label || '').trim();
    if (!label || label === 'unknown') continue;
    const dist = Number(neighbor.dist);
    if (!Number.isFinite(dist)) continue;
    const current = byLabel.get(label);
    if (!current || dist < current.distance) byLabel.set(label, { distance: dist });
  }
  return [...byLabel.entries()]
    .sort((a, b) => a[1].distance - b[1].distance)
    .slice(0, max)
    .map(([name, info]) => ({
      name,
      distance: roundDistance(info.distance),
      status: 'unverified_candidate',
      scoreKind: 'uncalibrated_distance',
      note: UNVERIFIED_NOTE,
    }));
}

/**
 * Run the local matcher over a capture region. Feature extraction is pure JS and
 * uses the frozen scaler + reference DB. The region is the whole capture unless
 * a caller supplies a user-selected box.
 */
export function lookupCandidates({ tracker, imageData, box = { x: 0, y: 0, width: 1, height: 1 } } = {}) {
  if (!tracker || !tracker.classifier || !tracker.featureExtractor) {
    return { available: false, reason: 'reference_index_not_loaded', candidates: [] };
  }
  if (!tracker.classifier.compact?.count && !tracker.classifier.examples?.length) {
    return { available: false, reason: 'no_reference_examples', candidates: [] };
  }
  try {
    const features = tracker.extractFeatures(imageData, box);
    const result = tracker.classifier.classify(features, tracker.featureExtractor.version);
    return {
      available: true,
      matcherDecision: result?.reason || 'unknown',
      nearestDistance: roundDistance(result?.neighbors?.[0]?.dist),
      acceptedByMatcher: result?.reason === 'ok',
      candidates: toUnverifiedCandidates(result),
      note: MATCHER_NOTE,
    };
  } catch (err) {
    return { available: false, reason: err.message || String(err), candidates: [] };
  }
}
