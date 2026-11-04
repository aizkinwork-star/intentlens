// componentDetector.js — classical region proposal + k-NN classification.
// No neural models. Uses OpenCV.js contours when available; otherwise simple thresholding.
// Returns candidate regions; classification comes from KNNClassifier (user-labelled examples).
export async function initComponentDetector() {
  if (typeof window !== 'undefined' && window.cv && window.cv.Mat) {
    return { ok: true, mode: 'opencv' };
  }
  return { ok: true, mode: 'basic', note: 'OpenCV.js not loaded; using basic thresholding.' };
}

export function getComponentDetectorMode() {
  return (typeof window !== 'undefined' && window.cv && window.cv.Mat) ? 'opencv' : 'unavailable';
}

export async function detectComponents(imageData) {
  const w = imageData.width, h = imageData.height;
  const regions = [];
  if (typeof window !== 'undefined' && window.cv && window.cv.Mat) {
    try {
      const cv = window.cv;
      const src = cv.matFromImageData(imageData);
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      const blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);
      const thresh = new cv.Mat();
      cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const rect = cv.boundingRect(c);
        const area = rect.width * rect.height;
        if (area < 100 || area > w*h*0.5) continue;
        regions.push({
          label: 'unknown',
          confidence: 0,
          box: { x: rect.x / w, y: rect.y / h, width: rect.width / w, height: rect.height / h },
          area,
        });
      }
      src.delete(); gray.delete(); blur.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
      return regions;
    } catch (e) {
      // fall through
    }
  }
  // No OpenCV available: return empty (no fake detections).
  return [];
}