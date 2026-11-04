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
