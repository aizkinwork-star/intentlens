// platform/cameraAdapter.js — Camera source adapter contract.
//
// Platform implementations:
//   - browser/CameraAdapter.js — Web getUserMedia (PWA, Electron renderer)
//   - capacitor/cameraAdapter.js — Capacitor Camera plugin (Android/iOS)
//
// Every adapter implements: start(), stop(), captureFrame(), getStatus().
// The UI never talks to getUserMedia directly — it goes through this adapter.

export const CAMERA_KINDS = ['phone-camera', 'laptop-camera', 'external-webcam', 'meta-glasses'];

// A single clean frame. Never bake the grid/target overlay into this image.
export class CameraFrame {
  constructor({ frameId, capturedAt, width, height, rotationDegrees, source, blob }) {
    this.frameId = frameId;
    this.capturedAt = capturedAt;
    this.width = width;
    this.height = height;
    this.rotationDegrees = rotationDegrees; // 0 | 90 | 180 | 270
    this.source = source;
    this.blob = blob;
  }
}

export class CameraAdapter {
  constructor({ kind = 'phone-camera', facingMode = 'environment', width = 1280, height = 720 } = {}) {
    if (!CAMERA_KINDS.includes(kind)) {
      throw new Error(`Unknown camera kind ${kind}`);
    }
    this.kind = kind;
    this.facingMode = facingMode;
    this.requestedWidth = width;
    this.requestedHeight = height;

    this.stream = null;
    this.video = null;
    this.state = 'idle'; // idle | starting | ready | error
    this.detail = null;
    this._captureCanvas = null;
  }

  async start() {
    throw new Error('start() not implemented by platform adapter');
  }

  async stop() {
    throw new Error('stop() not implemented by platform adapter');
  }

  getStatus() {
    return { state: this.state, detail: this.detail };
  }

  async captureFrame() {
    throw new Error('captureFrame() not implemented by platform adapter');
  }
}
