// crossModeTransfer.js — appearance-based identity transfer from PCB to loose.
import { IdentityRegistry } from './spatial/IdentityRegistry.js';
import { FeatureExtractor } from './perception/learning/FeatureExtractor.js';

export class CrossModeTransfer {
  constructor(registry) {
    this.registry = registry || new IdentityRegistry();
    this.featureExtractor = new FeatureExtractor();
    this.referenceDescriptors = new Map(); // pcbId -> feature vector
  }

  // Capture reference appearance during PCB enrollment.
  captureReference(pcbComponentId, imageData, box) {
    const features = this.featureExtractor.extract(imageData, box);
    this.referenceDescriptors.set(pcbComponentId, features);
  }

  // Find candidates among loose tracks using feature similarity.
  findCandidates(pcbComponentId, looseTracks, looseImageData, threshold = 0.6) {
    const refFeatures = this.referenceDescriptors.get(pcbComponentId);
    if (!refFeatures) return [];
    const pcb = this.registry.get(pcbComponentId);
    const candidates = [];
    for (const t of looseTracks) {
      if (!t.box) continue;
      const looseFeatures = this.featureExtractor.extract(looseImageData, t.box);
      const dist = euclidean(refFeatures, looseFeatures);
      const similarity = 1 / (dist + 1e-6);
      // Type compatibility check.
      const typeMatch = pcb && t.label && pcb.type && t.label.toLowerCase() === pcb.type.toLowerCase();
      const score = similarity * (typeMatch ? 1.2 : 0.8);
      if (score >= threshold) {
        candidates.push({ trackId: t.id || t.trackId, similarity: score, typeMatch, distance: dist });
      }
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    // Ambiguity: if top two are close, mark ambiguous.
    if (candidates.length >= 2 && candidates[0].similarity - candidates[1].similarity < 0.1) {
      for (const c of candidates) c.ambiguous = true;
    }
    return candidates;
  }

  // Transfer identity with user confirmation flag.
  transfer(pcbComponentId, looseTrackId, userConfirmed = false) {
    const pcb = this.registry.get(pcbComponentId);
    if (!pcb) return { ok: false, reason: 'pcb not found' };
    if (!userConfirmed) {
      return { ok: false, reason: 'requires user confirmation', needsConfirmation: true };
    }
    this.registry.transferMode(pcbComponentId, 'loose');
    this.registry.markState(pcbComponentId, 'removed_from_board');
    this.registry.register(looseTrackId, {
      type: pcb.type,
      identitySource: 'transferred_from_pcb',
      originalPcbId: pcbComponentId,
      originalPcbCoords: pcb.locations?.pcb || null,
      mode: 'loose',
      state: 'visible',
      transferredAt: Date.now(),
    });
    this.registry.updateLocation(looseTrackId, { loose: pcbComponentId });
    return { ok: true };
  }
}

function euclidean(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i]-b[i])**2;
  return Math.sqrt(s);
}

export default { CrossModeTransfer };