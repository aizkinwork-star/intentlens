// perception/pcb/ComponentPresenceVerifier.js — per-component presence verification.
export class ComponentPresenceVerifier {
  constructor() { this.history = new Map(); } // id -> array of outcomes

  // Extract region from imageData given a box (normalized 0..1).
  extractRegion(imageData, box) {
    const w = imageData.width, h = imageData.height;
    const x = Math.max(0, Math.floor(box.x * w));
    const y = Math.max(0, Math.floor(box.y * h));
    const bw = Math.max(1, Math.floor(box.width * w));
    const bh = Math.max(1, Math.floor(box.height * h));
    const region = new Uint8ClampedArray(bw * bh * 4);
    for (let yy = 0; yy < bh; yy++) {
      for (let xx = 0; xx < bw; xx++) {
        const srcIdx = ((y + yy) * w + (x + xx)) * 4;
        const dstIdx = (yy * bw + xx) * 4;
        if (y + yy < h && x + xx < w) {
          region[dstIdx] = imageData.data[srcIdx];
          region[dstIdx+1] = imageData.data[srcIdx+1];
          region[dstIdx+2] = imageData.data[srcIdx+2];
          region[dstIdx+3] = imageData.data[srcIdx+3];
        }
      }
    }
    return { data: region, width: bw, height: bh };
  }

  // Compute simple sharpness (Laplacian variance) and mean brightness.
  regionQuality(region) {
    // Laplacian variance focus measure.
    const w = region.width, h = region.height;
    const gray = [];
    for (let i = 0; i < region.data.length; i += 4) {
      gray.push(0.299*region.data[i] + 0.587*region.data[i+1] + 0.114*region.data[i+2]);
    }
    // Compute Laplacian (second derivative) variance.
    let sum = 0, sumSq = 0, count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const lap = gray[idx-1] + gray[idx+1] + gray[idx-w] + gray[idx+w] - 4*gray[idx];
        sum += lap;
        sumSq += lap * lap;
        count++;
      }
    }
    const mean = count > 0 ? sum / count : 0;
    const variance = count > 0 ? sumSq / count - mean * mean : 0;
    const brightness = gray.reduce((a,b)=>a+b,0)/gray.length;
    return { sharpness: Math.max(0, variance), brightness, pixelCount: gray.length };
  }

  // Compare two regions by normalized color histogram correlation.
  compareRegions(refRegion, curRegion) {
    const refHist = colorHistogram(refRegion);
    const curHist = colorHistogram(curRegion);
    return histogramCorrelation(refHist, curHist);
  }

  // Verify a single component.
  verify(component, imageData, referenceRegion) {
    const curRegion = this.extractRegion(imageData, component.projectedBox || component.box);
    const q = this.regionQuality(curRegion);
    const similarity = referenceRegion ? this.compareRegions(referenceRegion, curRegion) : 0;

    let state = 'uncertain';
    if (q.sharpness < 50) state = 'occluded';
    else if (similarity >= 0.7) state = 'visible';
    else if (similarity >= 0.4) state = 'uncertain';
    else state = 'possibly_absent';

    // Track consecutive outcomes
    const hist = this.history.get(component.id) || [];
    hist.push({ t: Date.now(), state, similarity, sharpness: q.sharpness });
    if (hist.length > 20) hist.shift();
    this.history.set(component.id, hist);

    // Reacquisition: if was possibly_absent and now visible
    const prev = hist.length > 1 ? hist[hist.length-2].state : null;
    if (prev === 'possibly_absent' && state === 'visible') state = 'reacquired';

    return { state, similarity, quality: q, consecutiveCount: hist.filter((h) => h.state === state).length };
  }

  getHistory(id) { return this.history.get(id) || []; }
}

function colorHistogram(region) {
  const hist = new Array(24).fill(0);
  for (let i = 0; i < region.data.length; i += 4) {
    const r = region.data[i], g = region.data[i+1], b = region.data[i+2];
    const bin = Math.floor((r+g+b) / 32) % 8 + Math.floor(r/64)*8;
    hist[Math.min(23, bin % 24)]++;
  }
  const total = hist.reduce((a,b)=>a+b,0) || 1;
  return hist.map((v) => v / total);
}

function histogramCorrelation(a, b) {
  let meanA = 0, meanB = 0;
  for (let i = 0; i < a.length; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= a.length; meanB /= b.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}