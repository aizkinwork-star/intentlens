// pcbContextBuilder.js — builds structured scene context for Meta AI from PCB registration + tracking state.
export function buildPcbSceneContext(state) {
  const board = state.pcbBoard || null;
  const projected = state.pcbAlignmentOk ? (state.pcbProjected || []) : [];
  const components = (board?.components || []).map((c) => {
    const p = projected?.find((pp) => pp.id === c.id);
    return {
      id: c.id,
      type: c.type,
      provenance: c.provenance || 'user_registered',
      pcbCoords: { x: c.x, y: c.y, width: c.width, height: c.height },
      cameraCoords: p?.projected ? { x: p.projected.x, y: p.projected.y } : null,
      trackingState: p?.valid ? 'visible' : (state.pcbAlignmentOk ? 'not_visible' : 'alignment_lost'),
      lastObservationTime: Date.now(),
      confidence: {
        localization: state.pcbAlignmentOk ? 0.9 : 0.0,
        tracking: state.pcbAlignmentOk ? 0.9 : 0.0,
        classification: c.provenance === 'user_registered' ? 1.0 : 0.5,
      },
    };
  });
  return {
    boardId: board?.id || null,
    alignment: state.pcbAlignmentOk ? 'stable' : 'lost',
    matchCount: state.pcbMatchCount || 0,
    components,
    uncertainties: state.pcbAlignmentOk ? [] : ['Board alignment lost; coordinates withheld.'],
    evidence: { referenceImageAvailable: !!state.pcbReferenceImage, currentFrameAvailable: true },
    requiredVerification: ['Confirm target identity before physical action.'],
  };
}
export default { buildPcbSceneContext };