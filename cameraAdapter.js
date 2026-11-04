// cameraAdapter.js — camera source behind the §3.4 adapter contract.
//
// The adapter owns start/stop/capture and frame metadata only. It never owns task
// logic, object memory, AI calls or grid math. Kind is one of:
//   "phone-camera" | "laptop-camera" | "external-webcam" | "meta-glasses"
//
// Meta glasses are future work behind a native Device Access Toolkit bridge; this
// browser adapter cannot open them directly (§3.4, §6).

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

export class BrowserCameraAdapter {
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.state = 'error';
      this.detail = 'getUserMedia not available on this origin (needs https:// or localhost).';
      throw new Error(this.detail);
    }
    this.state = 'starting';
    this.detail = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: this.kind === 'phone-camera' ? { ideal: 'environment' } : this.facingMode,
          width: { ideal: this.requestedWidth },
          height: { ideal: this.requestedHeight },
          audio: false,
        },
      });
      this.stream = stream;
      this.video = document.createElement('video');
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.srcObject = stream;
      await this.video.play();
      this.state = 'ready';
      this.detail = null;
    } catch (err) {
      this.state = 'error';
      this.detail = err.name === 'NotAllowedError'
        ? 'Camera permission was denied.'
        : err.name === 'NotFoundError'
          ? 'No camera found on this device.'
          : `Camera failed: ${err.message}`;
      throw err;
    }
  }

  async stop() {
    this.state = 'idle';
    this.detail = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  getStatus() {
    return { state: this.state, detail: this.detail };
  }

  // Capture one clean, unoverlaid frame as a JPEG blob.
  async captureFrame() {
    if (this.state !== 'ready' || !this.video || !this.video.videoWidth) {
      throw new Error('Camera not ready. Call start() first.');
    }

    if (!this._captureCanvas) {
      this._captureCanvas = document.createElement('canvas');
      this._captureCanvas.width = this.video.videoWidth;
      this._captureCanvas.height = this.video.videoHeight;
    }
    const ctx = this._captureCanvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0);

    const blob = await new Promise((resolve) => {
      this._captureCanvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82);
    });

    return new CameraFrame({
      frameId: `frame_${Date.now().toString(36)}`,
      capturedAt: new Date().toISOString(),
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      rotationDegrees: 0,
      source: this.kind,
      blob,
    });
  }
}
