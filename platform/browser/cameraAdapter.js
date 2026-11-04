// platform/browser/cameraAdapter.js — Browser camera adapter.
// Uses navigator.mediaDevices.getUserMedia. Works in browser PWA,
// Electron renderer, and Capacitor WebView.

import { CameraAdapter, CameraFrame } from '../cameraAdapter.js';

export class BrowserCameraAdapter extends CameraAdapter {
  constructor({ kind = 'phone-camera', facingMode = 'environment', width = 1280, height = 720, deviceId = '' } = {}) {
    super({ kind, facingMode, width, height, deviceId });
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
      const stream = await this._openStream();
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

  // Opens the chosen camera (e.g. an external USB webcam) by deviceId. If it was
  // unplugged, falls back to the default camera instead of failing.
  async _openStream() {
    const size = { width: { ideal: this.requestedWidth }, height: { ideal: this.requestedHeight } };
    const gum = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (this.deviceId) {
      try {
        return await gum({ ...size, deviceId: { exact: this.deviceId } });
      } catch (err) {
        if (!['OverconstrainedError', 'NotFoundError'].includes(err.name)) throw err;
        this.deviceId = '';
      }
    }
    return gum({
      ...size,
      facingMode: this.kind === 'phone-camera' ? { ideal: 'environment' } : this.facingMode,
    });
  }

  // Video inputs the OS exposes. Labels are empty until camera permission is granted.
  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
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
