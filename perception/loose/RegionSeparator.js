// perception/loose/RegionSeparator.js — separate touching objects via watershed + morphology.
export const RegionState = {
  SINGLE_OBJECT_CANDIDATE: 'SINGLE_OBJECT_CANDIDATE',
  MERGED_OBJECT_CANDIDATE: 'MERGED_OBJECT_CANDIDATE',
  AMBIGUOUS_REGION: 'AMBIGUOUS_REGION',
  INVALID_REGION: 'INVALID_REGION',
};

export const SeparatorResult = {
  SUCCESS: 'SUCCESS',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
};

export class RegionSeparator {
  constructor() { this.morphKernelSize = 3; this.opencvReady = false; this.initTimeout = 5000; }

  async waitForOpenCV() {
    const start = Date.now();
    while (Date.now() - start < this.initTimeout) {
      if (typeof window !== 'undefined' && window.cv && window.cv.Mat) {
        this.opencvReady = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    this.opencvReady = false;
    return false;
  }

  async separate(imageData, mask) {
    // Runtime readiness check.
    if (!this.opencvReady) {
      const ready = await this.waitForOpenCV();
      if (!ready) return { status: SeparatorResult.UNAVAILABLE, regions: [], reason: 'OpenCV not ready within timeout' };
    }
    if (typeof window === 'undefined' || !window.cv || !window.cv.Mat) {
      return { status: SeparatorResult.UNAVAILABLE, regions: [], reason: 'OpenCV not available' };
    }

    // Retry mechanism: up to 2 attempts.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = this._process(imageData, mask);
        return { status: SeparatorResult.SUCCESS, regions: result, reason: null };
      } catch (e) {
        if (attempt === 1) {
          return { status: SeparatorResult.ERROR, regions: [], reason: e?.message || String(e) };
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    return { status: SeparatorResult.ERROR, regions: [], reason: 'unknown' };
  }

  _process(imageData, mask) {
    const cv = window.cv;
    const w = imageData.width, h = imageData.height;
    let srcMask;
    if (mask instanceof cv.Mat) srcMask = mask;
    else {
      srcMask = new cv.Mat(h, w, cv.CV_8U);
      for (let i = 0; i < mask.length && i < srcMask.data.length; i++) srcMask.data[i] = mask[i];
    }

    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(this.morphKernelSize, this.morphKernelSize));
    const opened = new cv.Mat();
    cv.morphologyEx(srcMask, opened, cv.MORPH_OPEN, kernel);

    const dist = new cv.Mat();
    cv.distanceTransform(opened, dist, cv.DIST_L2, cv.DIST_MASK_PRECISE);
    const distNorm = new cv.Mat();
    cv.normalize(dist, distNorm, 0, 255, cv.NORM_MINMAX, cv.CV_8U);

    const sureFg = new cv.Mat();
    cv.threshold(distNorm, sureFg, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    const sureBg = new cv.Mat();
    const kernel2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.dilate(opened, sureBg, kernel2);

    const unknown = new cv.Mat();
    cv.subtract(sureBg, sureFg, unknown);

    const markers = new cv.Mat();
    cv.connectedComponents(sureFg, markers);
    const markersShifted = new cv.Mat();
    cv.add(markers, new cv.Mat(markers.rows, markers.cols, markers.type(), [1, 0, 0, 0]), markersShifted);

    for (let i = 0; i < unknown.rows * unknown.cols; i++) {
      if (unknown.data[i] > 0) markersShifted.data[i] = 0;
    }

    const src = cv.matFromImageData(imageData);
    cv.watershed(src, markersShifted);

    const regions = [];
    const markerCounts = {};
    for (let i = 0; i < markersShifted.rows * markersShifted.cols; i++) {
      const v = markersShifted.data[i];
      if (v > 1) markerCounts[v] = (markerCounts[v] || 0) + 1;
    }

    const uniqueMarkers = Object.keys(markerCounts);
    for (const mk of uniqueMarkers) {
      const m = parseInt(mk);
      const regionMask = new cv.Mat(markersShifted.rows, markersShifted.cols, cv.CV_8U);
      for (let i = 0; i < markersShifted.rows * markersShifted.cols; i++) {
        regionMask.data[i] = (markersShifted.data[i] === m) ? 255 : 0;
      }
      const cnts = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(regionMask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let c = 0; c < cnts.size(); c++) {
        const cnt = cnts.get(c);
        const rect = cv.boundingRect(cnt);
        const area = rect.width * rect.height;
        if (area < 50) { cnt.delete(); continue; }
        const hull = new cv.Mat();
        const hullIdx = new cv.Mat();
        cv.convexHull(cnt, hull, false, true);
        cv.convexHull(cnt, hullIdx, false, false);
        const defects = new cv.Mat();
        cv.convexityDefects(cnt, hullIdx, defects);
        let defectCount = 0;
        for (let d = 0; d < defects.rows; d++) {
          const depth = defects.data32S[d * 4 + 3] / 256.0;
          if (depth > 10) defectCount++;
        }
        let state = RegionState.SINGLE_OBJECT_CANDIDATE;
        if (defectCount > 2) state = RegionState.MERGED_OBJECT_CANDIDATE;
        if (area < 25) state = RegionState.INVALID_REGION;
        regions.push({ box: { x: rect.x / w, y: rect.y / h, width: rect.width / w, height: rect.height / h }, area, defectCount, state });
        cnt.delete(); hull.delete(); hullIdx.delete(); defects.delete();
      }
      cnts.delete(); hier.delete(); regionMask.delete();
    }

    // Ambiguity check.
    const totalFg = regions.reduce((a, r) => a + r.area, 0);
    for (const r of regions) {
      if (regions.length === 1 && r.area > totalFg * 0.6 && r.area > w * h * 0.3) {
        r.state = RegionState.AMBIGUOUS_REGION;
      }
    }

    // Cleanup.
    src.delete(); kernel.delete(); opened.delete(); dist.delete(); distNorm.delete();
    sureFg.delete(); sureBg.delete(); unknown.delete(); markers.delete(); markersShifted.delete();
    kernel2.delete();

    return regions;
  }

  basicSeparate() { return []; }
}

export default { RegionSeparator, RegionState, SeparatorResult };