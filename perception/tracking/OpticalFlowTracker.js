// perception/tracking/OpticalFlowTracker.js — Lucas-Kanade optical flow (OpenCV.js).
export class OpticalFlowTracker {
  constructor() { this.prevGray = null; this.points = null; }

  init(imageData, points) {
    if (!window.cv) return false;
    const cv = window.cv;
    this.prevGray = new cv.Mat();
    cv.cvtColor(cv.matFromImageData(imageData), this.prevGray, cv.COLOR_RGBA2GRAY);
    this.points = cv.matFromArray(points.length/2, 1, cv.CV_32FC2, points);
    return true;
  }

  update(imageData) {
    if (!this.prevGray || !window.cv) return null;
    const cv = window.cv;
    const gray = new cv.Mat();
    cv.cvtColor(cv.matFromImageData(imageData), gray, cv.COLOR_RGBA2GRAY);
    const nextPts = new cv.Mat();
    const status = new cv.Mat();
    const err = new cv.Mat();
    cv.calcOpticalFlowPyrLK(this.prevGray, gray, this.points, nextPts, status, err);
    const out = [];
    for (let i = 0; i < nextPts.rows; i++) {
      if (status.data[i]) {
        out.push({ x: nextPts.data32F[i*2], y: nextPts.data32F[i*2+1] });
      } else {
        out.push(null);
      }
    }
    this.prevGray.delete();
    this.prevGray = gray;
    this.points = nextPts;
    status.delete(); err.delete();
    return out;
  }

  reset() {
    if (this.prevGray) this.prevGray.delete();
    if (this.points) this.points.delete();
    this.prevGray = null; this.points = null;
  }
}