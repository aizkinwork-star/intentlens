// perception/learning/FeatureExtractor.js — corrected feature extraction.
// v4.0: Added spatial uniform LBP (2x2 grid, 59 bins per cell = 236 dims).
// Total: 1791 + 236 = 2027 dimensions.
export class FeatureExtractor {
  constructor(scaler = null) {
    this.version = '4.0';
    this.scaler = scaler; // { mean: [], std: [] }
  }

  extract(imageData, box) {
    if (!this.scaler || !this.scaler.mean || !this.scaler.std) {
      throw new Error('FeatureExtractor: scaler not loaded. Call loadScaler() first. No silent fallback to raw features.');
    }
    const region = extractRegion(imageData, box);
    const resized = resizeRegion(region, 64, 64);
    const features = [];
    // 1. Aspect ratio and area (from original box)
    features.push(box.width / Math.max(box.height, 1e-6));
    features.push(box.width * box.height);
    // 2. HSV histogram (16 bins) from resized
    features.push(...hsvHistogram(resized));
    // 3. Hu moments from binary mask (7, log-transformed) from resized
    features.push(...huMomentsBinary(resized));
    // 4. HOG with spatial cells (1764) from resized
    features.push(...hogCells(resized));
    // 5. Shape descriptors from resized
    features.push(...shapeDescriptors(resized));
    // 6. Spatial uniform LBP (236 dims) from resized
    features.push(...spatialUniformLbp(resized, 2, 2));

    // Validate dimension before scaling.
    if (features.length !== 2027) {
      throw new Error('FeatureExtractor: expected 2027 features, got ' + features.length);
    }
    // Validate scaler dimension.
    if (this.scaler.mean.length !== 2027 || this.scaler.std.length !== 2027) {
      throw new Error('FeatureExtractor: scaler dimension mismatch. Expected 2027, got ' + this.scaler.mean.length);
    }
    // Standardize (exactly once).
    const scaled = features.map((v, i) => (v - this.scaler.mean[i]) / (this.scaler.std[i] + 1e-6));
    // Validate output.
    if (scaled.length !== 2027) {
      throw new Error('FeatureExtractor: scaled output dimension mismatch');
    }
    for (let i = 0; i < scaled.length; i++) {
      if (!Number.isFinite(scaled[i])) {
        throw new Error('FeatureExtractor: non-finite value at index ' + i);
      }
    }
    return scaled;
  }

  static fitScaler(featureVectors) {
    if (!featureVectors || featureVectors.length === 0) return null;
    const dim = featureVectors[0].length;
    const mean = new Array(dim).fill(0);
    const std = new Array(dim).fill(0);
    for (const fv of featureVectors) {
      for (let i = 0; i < dim; i++) mean[i] += fv[i];
    }
    for (let i = 0; i < dim; i++) mean[i] /= featureVectors.length;
    for (const fv of featureVectors) {
      for (let i = 0; i < dim; i++) std[i] += (fv[i] - mean[i]) ** 2;
    }
    for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / featureVectors.length);
    for (let i = 0; i < dim; i++) if (std[i] < 1e-6) std[i] = 1e-6;
    return { mean, std, version: '4.0' };
  }
}

// Uniform LBP mapping (8 neighbors, radius 1): 256 patterns -> 59 bins
const UNIFORM_MAP = (function() {
  const map = new Array(256).fill(0);
  let idx = 0;
  for (let pattern = 0; pattern < 256; pattern++) {
    const bits = [];
    for (let i = 0; i < 8; i++) bits.push((pattern >> i) & 1);
    let transitions = 0;
    for (let i = 0; i < 8; i++) {
      if (bits[i] !== bits[(i + 1) % 8]) transitions++;
    }
    if (transitions <= 2) {
      map[pattern] = idx++;
    } else {
      map[pattern] = 58; // non-uniform bin
    }
  }
  return map;
})();
const N_UNIFORM_BINS = 59;

// Spatial uniform LBP: 2x2 grid, 59 bins per cell = 236 dims
function spatialUniformLbp(region, gridX, gridY) {
  const w = region.width, h = region.height;
  const cellW = Math.floor(w / gridX);
  const cellH = Math.floor(h / gridY);
  const result = [];
  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      const xStart = gx * cellW;
      const xEnd = (gx === gridX - 1) ? w : (gx + 1) * cellW;
      const yStart = gy * cellH;
      const yEnd = (gy === gridY - 1) ? h : (gy + 1) * cellH;
      // Compute LBP for this cell
      const cellW2 = xEnd - xStart;
      const cellH2 = yEnd - yStart;
      const hist = new Array(N_UNIFORM_BINS).fill(0);
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          if (y === 0 || y === h - 1 || x === 0 || x === w - 1) continue;
          const idx = y * w + x;
          const center = region.data[idx * 4] * 0.299 + region.data[idx * 4 + 1] * 0.587 + region.data[idx * 4 + 2] * 0.114;
          // 8 neighbors
          const neighbors = [
            [-1, -1], [0, -1], [1, -1], [1, 0],
            [1, 1], [0, 1], [-1, 1], [-1, 0]
          ];
          let pattern = 0;
          for (let ni = 0; ni < 8; ni++) {
            const nx = x + neighbors[ni][0];
            const ny = y + neighbors[ni][1];
            const nidx = ny * w + nx;
            const nval = region.data[nidx * 4] * 0.299 + region.data[nidx * 4 + 1] * 0.587 + region.data[nidx * 4 + 2] * 0.114;
            if (nval >= center) {
              pattern |= (1 << ni);
            }
          }
          hist[UNIFORM_MAP[pattern]]++;
        }
      }
      // L1 normalize
      const total = hist.reduce((a, b) => a + b, 0) || 1;
      result.push(...hist.map(v => v / total));
    }
  }
  // Pad to 236 if needed (4 cells * 59 bins)
  while (result.length < 236) result.push(0);
  return result.slice(0, 236);
}

function extractRegion(imageData, box) {
  const w = imageData.width, h = imageData.height;
  const x = Math.max(0, Math.floor(box.x * w));
  const y = Math.max(0, Math.floor(box.y * h));
  const bw = Math.max(1, Math.floor(box.width * w));
  const bh = Math.max(1, Math.floor(box.height * h));
  const data = new Uint8ClampedArray(bw * bh * 4);
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      const src = ((Math.min(h-1, y+yy)) * w + Math.min(w-1, x+xx)) * 4;
      const dst = (yy * bw + xx) * 4;
      data[dst]=imageData.data[src]; data[dst+1]=imageData.data[src+1];
      data[dst+2]=imageData.data[src+2]; data[dst+3]=imageData.data[src+3];
    }
  }
  return { data, width: bw, height: bh };
}

function resizeRegion(region, targetW, targetH) {
  const srcW = region.width, srcH = region.height;
  const data = new Uint8ClampedArray(targetW * targetH * 4);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor(x * srcW / targetW));
      const srcY = Math.min(srcH - 1, Math.floor(y * srcH / targetH));
      const srcIdx = (srcY * srcW + srcX) * 4;
      const dstIdx = (y * targetW + x) * 4;
      data[dstIdx] = region.data[srcIdx];
      data[dstIdx+1] = region.data[srcIdx+1];
      data[dstIdx+2] = region.data[srcIdx+2];
      data[dstIdx+3] = region.data[srcIdx+3];
    }
  }
  return { data, width: targetW, height: targetH };
}

function hsvHistogram(region) {
  const w = region.width, h = region.height;
  const bins = new Array(16).fill(0);
  for (let i = 0; i < region.data.length; i += 4) {
    const r = region.data[i]/255, g = region.data[i+1]/255, b = region.data[i+2]/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const d = max - min;
    let hue = 0;
    if (d > 0) {
      if (max === r) hue = ((g-b)/d) % 6;
      else if (max === g) hue = (b-r)/d + 2;
      else hue = (r-g)/d + 4;
      hue *= 60; if (hue < 0) hue += 360;
    }
    const sat = max === 0 ? 0 : d / max;
    const val = max;
    const bin = Math.floor(hue / 22.5) + Math.floor(sat * 4) * 6 + Math.floor(val * 4);
    bins[Math.min(15, bin % 16)]++;
  }
  const total = bins.reduce((a,b)=>a+b,0) || 1;
  return bins.map((v) => v/total);
}

function toBinary(region) {
  const gray = [];
  for (let i = 0; i < region.data.length; i += 4) {
    gray.push(0.299*region.data[i]+0.587*region.data[i+1]+0.114*region.data[i+2]);
  }
  const mean = gray.reduce((a,b)=>a+b,0)/gray.length;
  return gray.map((v) => v > mean ? 1 : 0);
}

function huMomentsBinary(region) {
  const w = region.width, h = region.height;
  const binary = toBinary(region);
  let m00 = 0, m10 = 0, m01 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = binary[y*w+x];
    m00 += v; m10 += x*v; m01 += y*v;
  }
  const cx = m00 ? m10/m00 : 0;
  const cy = m00 ? m01/m00 : 0;
  let mu20=0, mu02=0, mu11=0, mu30=0, mu03=0, mu21=0, mu12=0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = binary[y*w+x];
    const dx = x - cx, dy = y - cy;
    mu20 += dx*dx*v; mu02 += dy*dy*v; mu11 += dx*dy*v;
    mu30 += dx*dx*dx*v; mu03 += dy*dy*dy*v;
    mu21 += dx*dx*dy*v; mu12 += dx*dy*dy*v;
  }
  const norm = m00 || 1;
  const n20 = mu20/norm, n02 = mu02/norm, n11 = mu11/norm;
  const n30 = mu30/norm, n03 = mu03/norm, n21 = mu21/norm, n12 = mu12/norm;
  const hu = [
    n20 + n02,
    (n20-n02)**2 + 4*n11*n11,
    (n30-3*n12)**2 + (3*n21-n03)**2,
    (n30+n12)**2 + (n21+n03)**2,
    (n30-3*n12)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2) + (3*n21-n03)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2),
    (n20-n02)*((n30+n12)**2-(n21+n03)**2) + 4*n11*(n30+n12)*(n21+n03),
    (3*n21-n03)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2) - (n30-3*n12)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2),
  ];
  const eps = 1e-10;
  return hu.map((v) => -Math.sign(v) * Math.log10(Math.abs(v) + eps));
}

function hogCells(region) {
  const w = region.width, h = region.height;
  const cellSize = 8, bins = 9;
  const cellsX = Math.max(1, Math.floor(w / cellSize));
  const cellsY = Math.max(1, Math.floor(h / cellSize));
  const cellHists = [];
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const hist = new Array(bins).fill(0);
      for (let y = cy*cellSize; y < (cy+1)*cellSize && y < h-1; y++) {
        for (let x = cx*cellSize; x < (cx+1)*cellSize && x < w-1; x++) {
          const idx = y*w+x;
          const gx = (region.data[idx*4+4]||0) - (region.data[idx*4-4]||0);
          const gy = (region.data[(y+1)*w*4+x*4]||0) - (region.data[(y-1)*w*4+x*4]||0);
          const mag = Math.sqrt(gx*gx+gy*gy);
          let ang = Math.atan2(gy, gx) * 180 / Math.PI;
          if (ang < 0) ang += 180;
          const bin = Math.floor(ang / 20);
          hist[Math.min(bins-1, bin)] += mag;
        }
      }
      const total = hist.reduce((a,b)=>a+b,0) || 1;
      cellHists.push(hist.map((v) => v/total));
    }
  }
  const out = [];
  for (let by = 0; by < cellsY - 1; by++) {
    for (let bx = 0; bx < cellsX - 1; bx++) {
      const block = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const ci = (by+dy)*cellsX + (bx+dx);
          if (cellHists[ci]) block.push(...cellHists[ci]);
        }
      }
      let norm = Math.sqrt(block.reduce((a,b)=>a+b*b,0)) + 1e-6;
      const normalized = block.map((v) => v / norm);
      const clipped = normalized.map((v) => Math.min(v, 0.2));
      const norm2 = Math.sqrt(clipped.reduce((a,b)=>a+b*b,0)) + 1e-6;
      out.push(...clipped.map((v) => v / norm2));
    }
  }
  return out.length > 0 ? out : new Array(36).fill(0);
}

function shapeDescriptors(region) {
  const w = region.width, h = region.height;
  const area = w * h;
  let fg = 0;
  for (let i = 0; i < region.data.length; i += 4) {
    if (region.data[i] + region.data[i+1] + region.data[i+2] > 128) fg++;
  }
  const solidity = fg / Math.max(1, area);
  const extent = area / Math.max(1, region.data.length / 4);
  return [solidity, extent];
}