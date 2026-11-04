// platform/detector.js — Platform detection.
//
// Detects the running platform so the app can load the correct
// camera adapter, storage adapter, and UI behavior.
//
// Returns one of: 'web-pwa', 'electron-desktop', 'capacitor-android', 'capacitor-ios'
// Detects:
//   - Electron: process.versions.electron exists
//   - Capacitor Android: window.capacitor && navigator.userAgent contains Android
//   - Capacitor iOS: window.capacitor && navigator.userAgent contains iPhone/iPad
//   - Web PWA: everything else running in a browser
// ---------------------------------------------------------------------------

export function detectPlatform() {
  // Check if running in Electron
  if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
    return 'electron-desktop';
  }

  // Check if running in Capacitor (Capacitor injects window.capacitor)
  if (typeof window !== 'undefined' && window.capacitor) {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua)) {
      return 'capacitor-ios';
    }
    if (/Android/.test(ua)) {
      return 'capacitor-android';
    }
    // Capacitor but unknown platform — default to Android
    return 'capacitor-android';
  }

  // Everything else is a web/PWA app
  return 'web-pwa';
}

export function isWebPlatform() {
  return detectPlatform() === 'web-pwa';
}

export function isElectronPlatform() {
  return detectPlatform() === 'electron-desktop';
}

export function isCapacitorPlatform() {
  return detectPlatform() === 'capacitor-android' || detectPlatform() === 'capacitor-ios';
}

export function isMobilePlatform() {
  return detectPlatform() === 'capacitor-android' || detectPlatform() === 'capacitor-ios';
}

export function isDesktopPlatform() {
  return detectPlatform() === 'electron-desktop';
}
