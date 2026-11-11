// pwa/camera.js — pure camera helpers so they can be tested without a phone.
// A mocked test does NOT prove a physical Android camera works.

export function cameraErrorMessage(error) {
  const name = String(error?.name || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site in the browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is busy or unreadable. Close other camera apps and try again.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'This camera cannot satisfy the requested settings. Retry without the rear-camera preference.';
  }
  if (name === 'AbortError') {
    return 'Camera start was interrupted. Try again.';
  }
  return String(error?.message || error || 'Camera could not start.');
}

/** Capture canvas size from the true video frame, never from CSS display size. */
export function computeCaptureSize(videoWidth, videoHeight, maxSide = 1600) {
  const width = Number(videoWidth);
  const height = Number(videoHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    scale,
    portrait: height > width,
  };
}

/** Ask for landscape, but never depend on it: some browsers reject the lock. */
export async function tryLockLandscape() {
  try {
    if (!screen?.orientation?.lock) return { locked: false, reason: 'unsupported' };
    await screen.orientation.lock('landscape');
    return { locked: true };
  } catch (error) {
    return { locked: false, reason: String(error?.message || error) };
  }
}

export async function unlockOrientation() {
  try {
    if (screen?.orientation?.unlock) screen.orientation.unlock();
  } catch {
    /* nothing to unlock */
  }
}

/**
 * Build an ordered, most-specific-first list of video constraints.
 *
 * A phone can reject `width: {ideal: 1920}` or a saved deviceId that no longer
 * exists. Rather than giving up, the caller walks this ladder until one entry
 * opens. Every step is still a normal constraint object, so a browser that
 * supports only the last entry still works.
 */
export function buildCameraConstraintLadder({
  deviceId = '',
  facingMode = 'environment',
  width = 1920,
  height = 1080,
} = {}) {
  const ladder = [];
  const add = (video, reason) => ladder.push({ video, audio: false, reason });

  if (deviceId) {
    add({ deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } }, 'selected camera, full resolution');
    add({ deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, 'selected camera, 720p');
    add({ deviceId: { exact: deviceId } }, 'selected camera, any resolution');
  }
  add({ facingMode: { ideal: facingMode }, width: { ideal: width }, height: { ideal: height } }, 'rear camera preferred, full resolution');
  add({ facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }, 'rear camera preferred, 720p');
  add({ facingMode: { ideal: facingMode } }, 'rear camera preferred, any resolution');
  // The final entry is deliberately unconstrained. On a laptop this opens the
  // only webcam; on a phone it opens whatever the browser considers default.
  add(true, 'any available camera');
  return ladder;
}

const RETRYABLE_CAMERA_ERRORS = new Set([
  'OverconstrainedError',
  'ConstraintNotSatisfiedError',
  'NotFoundError',
  'DevicesNotFoundError',
  'TypeError',
]);

/**
 * Try each constraint in order. Permission, busy-camera and security failures
 * are rethrown immediately because retrying cannot fix them. Constraint and
 * missing-device failures move to the next, less specific step.
 *
 * Returns { stream, step, attempts }. `step.reason` names what actually worked.
 */
export async function openCameraWithFallback(mediaDevices, ladder) {
  if (!mediaDevices?.getUserMedia) {
    const error = new Error('This browser does not expose getUserMedia. Serve the page from HTTPS or localhost; GitHub Pages is HTTPS.');
    error.name = 'NotSupportedError';
    throw error;
  }
  if (!Array.isArray(ladder) || !ladder.length) {
    throw new Error('openCameraWithFallback needs at least one constraint');
  }

  const attempts = [];
  for (const step of ladder) {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: step.audio === true, video: step.video });
      return { stream, step, attempts };
    } catch (error) {
      attempts.push({
        reason: step.reason,
        name: String(error?.name || ''),
        message: String(error?.message || error),
      });
      if (!RETRYABLE_CAMERA_ERRORS.has(String(error?.name || ''))) throw error;
    }
  }

  const last = attempts[attempts.length - 1];
  const error = new Error('No camera could be opened with any supported constraint.');
  error.name = last?.name || 'NotFoundError';
  error.attempts = attempts;
  throw error;
}

/**
 * Read torch/zoom/focus support from a live video track.
 *
 * `getCapabilities` is not implemented by every browser, so an absent or
 * throwing implementation reports "unsupported" instead of guessing.
 */
export function cameraCapabilities(track) {
  let capabilities = {};
  let settings = {};
  try {
    if (typeof track?.getCapabilities === 'function') capabilities = track.getCapabilities() || {};
  } catch { capabilities = {}; }
  try {
    if (typeof track?.getSettings === 'function') settings = track.getSettings() || {};
  } catch { settings = {}; }

  const zoomCap = capabilities.zoom;
  const zoom = zoomCap
    && Number.isFinite(zoomCap.min)
    && Number.isFinite(zoomCap.max)
    && zoomCap.max > zoomCap.min
    ? {
      min: zoomCap.min,
      max: zoomCap.max,
      step: Number.isFinite(zoomCap.step) && zoomCap.step > 0 ? zoomCap.step : 0.1,
      current: Number.isFinite(settings.zoom) ? settings.zoom : zoomCap.min,
    }
    : null;

  return {
    torch: capabilities.torch === true,
    zoom,
    continuousFocus: Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous'),
    settings: {
      width: Number.isFinite(settings.width) ? settings.width : null,
      height: Number.isFinite(settings.height) ? settings.height : null,
      frameRate: Number.isFinite(settings.frameRate) ? settings.frameRate : null,
      facingMode: settings.facingMode || null,
    },
  };
}

/** Toggle a phone torch. Returns applied:false instead of throwing at the UI. */
export async function setTorch(track, enabled) {
  if (!track || typeof track.applyConstraints !== 'function') {
    return { applied: false, enabled: false, error: 'no video track' };
  }
  try {
    await track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
    return { applied: true, enabled: Boolean(enabled) };
  } catch (error) {
    return { applied: false, enabled: false, error: String(error?.message || error) };
  }
}

/** Clamp and apply zoom. Returns the value the camera reported, not the request. */
export async function setZoom(track, value) {
  const capabilities = cameraCapabilities(track);
  if (!capabilities.zoom) return { applied: false, zoom: null, error: 'zoom is not supported' };
  const { min, max, step } = capabilities.zoom;
  const requested = Number(value);
  if (!Number.isFinite(requested)) return { applied: false, zoom: capabilities.zoom.current, error: 'zoom must be a number' };
  const clamped = Math.max(min, Math.min(max, requested));
  const snapped = Math.round((clamped - min) / step) * step + min;
  const zoom = Math.max(min, Math.min(max, snapped));
  try {
    await track.applyConstraints({ advanced: [{ zoom }] });
    const after = cameraCapabilities(track).zoom;
    return { applied: true, zoom: after ? after.current : zoom };
  } catch (error) {
    return { applied: false, zoom: capabilities.zoom.current, error: String(error?.message || error) };
  }
}
