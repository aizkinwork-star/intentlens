// perception/pcb/BoardRegistrar.js — ORB feature registration + robust homography.
export class BoardRegistrar {
  constructor() { this.reference = null; this.lastGoodH = null; this.lastGoodTime = 0; }

  register(imageData, components) {
    if (!window.cv) throw new Error('OpenCV.js not loaded');
    const cv = window.cv;
    const src = cv.matFromImageData(imageData);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const orb = new cv.ORB(1500);
    const kp = new cv.KeyPointVector();
    const desc = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), kp, desc);
    this.reference = { keypoints: kp, descriptors: desc, image: src.clone(), components: components.map((c) => ({ ...c })), width: imageData.width, height: imageData.height };
    src.delete(); gray.delete();
    return { ok: true, keypointCount: kp.size() };
  }

  // Manual four-point registration: user provides 4 corners in current image (TL,TR,BR,BL).
  // Creates board-to-image homography.
  registerManual(corners, boardWidth, boardHeight) {
    if (corners.length !== 4) return { ok: false, reason: 'need 4 corners' };
    const cv = window.cv;
    const srcPts = cv.matFromArray(4, 2, cv.CV_32F, [0,0, boardWidth,0, boardWidth,boardHeight, 0,boardHeight]);
    const dstPts = cv.matFromArray(4, 2, cv.CV_32F, corners.flatMap((p) => [p.x, p.y]));
    const H = cv.getPerspectiveTransform(srcPts, dstPts);
    srcPts.delete(); dstPts.delete();
    this.reference = this.reference || {};
    this.reference.manualH = H;
    this.reference.manualMode = true;
    this.reference.width = boardWidth;
    this.reference.height = boardHeight;
    return { ok: true, H };
  }

  estimateHomography(currentImageData) {
    if (!this.reference || !window.cv) return { ok: false, reason: 'no reference' };
    const cv = window.cv;

    if (this.reference.manualMode && this.reference.manualH) {
      return { ok: true, H: this.reference.manualH, matches: 0, inliers: 0, method: 'manual' };
    }

    const src = cv.matFromImageData(currentImageData);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const orb = new cv.ORB(1500);
    const kp2 = new cv.KeyPointVector();
    const desc2 = new cv.Mat();
    orb.detectAndCompute(gray, new cv.Mat(), kp2, desc2);

    // knnMatch with k=2 for Lowe ratio test.
    const bf = new cv.BFMatcher(cv.NORM_HAMMING);
    const knnMatches = new cv.DMatchVectorVector();
    try { bf.knnMatch(this.reference.descriptors, desc2, knnMatches, 2); } catch (e) {
      src.delete(); gray.delete(); kp2.delete(); desc2.delete();
      return { ok: false, reason: 'match failed' };
    }

    // Lowe ratio test.
    const good = [];
    for (let i = 0; i < knnMatches.size(); i++) {
      const m = knnMatches.get(i);
      if (m.size() >= 2 && m.get(0).distance < 0.75 * m.get(1).distance) {
        good.push(m.get(0));
      }
    }

    if (good.length < 10) {
      src.delete(); gray.delete(); kp2.delete(); desc2.delete(); knnMatches.delete();
      return { ok: false, reason: 'too few good matches', matches: good.length };
    }

    const pts1 = [], pts2 = [];
    for (const m of good) {
      const p1 = this.reference.keypoints.get(m.queryIdx).pt;
      const p2 = kp2.get(m.trainIdx).pt;
      pts1.push(p1.x, p1.y);
      pts2.push(p2.x, p2.y);
    }
    const mat1 = cv.matFromArray(pts1.length/2, 2, cv.CV_32F, pts1);
    const mat2 = cv.matFromArray(pts2.length/2, 2, cv.CV_32F, pts2);
    const H = cv.findHomography(mat1, mat2, cv.RANSAC, 4.0);

    if (H.empty()) {
      cleanup(); return { ok: false, reason: 'homography failed' };
    }

    // Inlier count.
    const inliers = countInliers(cv, H, pts1, pts2, 4.0);
    const inlierRatio = inliers / good.length;

    // Spatial spread of INLIERS only.
    const inlierPts = [];
    const h = H.data64F || H.data32F;
    for (let i = 0; i < pts1.length; i += 2) {
      const x = pts1[i], y = pts1[i+1];
      const w = h[6]*x + h[7]*y + h[8];
      const px = (h[0]*x + h[1]*y + h[2]) / w;
      const py = (h[3]*x + h[4]*y + h[5]) / w;
      const dx = px - pts2[i], dy = py - pts2[i+1];
      if (Math.sqrt(dx*dx + dy*dy) < 4.0) {
        inlierPts.push(pts2[i], pts2[i+1]);
      }
    }
    const spread = spatialSpread(inlierPts, currentImageData.width, currentImageData.height);

    // Transform stability: compare projected board corners.
    let stable = true;
    if (this.lastGoodH) {
      stable = cornersStable(this.lastGoodH, H, this.reference.width, this.reference.height);
    }

    const valid = inlierRatio >= 0.4 && inliers >= 8 && spread >= 0.3 && stable;

    // Release previous lastGoodH before replacing.
    if (valid) {
      if (this.lastGoodH) { try { this.lastGoodH.delete(); } catch {} }
      this.lastGoodH = H.clone();
      this.lastGoodTime = Date.now();
    }

    // cleanup
    src.delete(); gray.delete(); kp2.delete(); desc2.delete(); knnMatches.delete(); mat1.delete(); mat2.delete();

    if (!valid) {
      H.delete();
      return { ok: false, reason: 'validation failed', inliers, inlierRatio, spread, stable, matches: good.length };
    }

    return { ok: true, H, inliers, inlierRatio, spread, matches: good.length, method: 'orb' };
  }

  projectPoint(H, u, v) {
    if (!H) return null;
    const refW = this.reference?.width || 1;
    const refH = this.reference?.height || 1;
    const x = u * refW, y = v * refH;
    const h = H.data64F || H.data32F;
    const w = h[6]*x + h[7]*y + h[8];
    if (Math.abs(w) < 1e-9) return null;
    const px = (h[0]*x + h[1]*y + h[2]) / w;
    const py = (h[3]*x + h[4]*y + h[5]) / w;
    return { x: px, y: py };
  }
}

function countInliers(cv, H, pts1, pts2, thresh) {
  const h = H.data64F || H.data32F;
  let count = 0;
  for (let i = 0; i < pts1.length; i += 2) {
    const x = pts1[i], y = pts1[i+1];
    const w = h[6]*x + h[7]*y + h[8];
    const px = (h[0]*x + h[1]*y + h[2]) / w;
    const py = (h[3]*x + h[4]*y + h[5]) / w;
    const dx = px - pts2[i], dy = py - pts2[i+1];
    if (Math.sqrt(dx*dx + dy*dy) < thresh) count++;
  }
  return count;
}

function spatialSpread(pts, w, h) {
  if (pts.length < 4) return 0;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i+1] < minY) minY = pts[i+1];
    if (pts[i+1] > maxY) maxY = pts[i+1];
  }
  const area = (maxX - minX) * (maxY - minY);
  return area / (w * h);
}

function cornersStable(H1, H2, w, h) {
  // Compare projected corners instead of raw coefficients.
  const corners = [[0,0],[w,0],[w,h],[0,h]];
  let maxDiff = 0;
  for (const [x,y] of corners) {
    const w1 = H1.data64F[6]*x + H1.data64F[7]*y + H1.data64F[8];
    const px1 = (H1.data64F[0]*x + H1.data64F[1]*y + H1.data64F[2]) / w1;
    const py1 = (H1.data64F[3]*x + H1.data64F[4]*y + H1.data64F[5]) / w1;
    const w2 = H2.data64F[6]*x + H2.data64F[7]*y + H2.data64F[8];
    const px2 = (H2.data64F[0]*x + H2.data64F[1]*y + H2.data64F[2]) / w2;
    const py2 = (H2.data64F[3]*x + H2.data64F[4]*y + H2.data64F[5]) / w2;
    const diff = Math.sqrt((px1-px2)**2 + (py1-py2)**2);
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff < 50; // pixels
}

function cleanup() {}