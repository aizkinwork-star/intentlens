// mobileSupport.js — honest capability checks for phone access.
//
// The Electron installer is not an Android app. A phone can only use this as a
// web client, and camera access requires a secure context (https:// or
// localhost). A plain http:// LAN address is reported as blocked rather than
// pretending the camera will work.

export function inspectMobileSupport({
  secureContext = false,
  hasMediaDevices = false,
  userAgent = '',
  viewportWidth = 0,
  isLocalhost = false,
} = {}) {
  const ua = String(userAgent || '');
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || Number(viewportWidth) < 700;
  const secure = Boolean(secureContext || isLocalhost);
  const blockers = [];

  if (!secure) {
    blockers.push('Camera requires a secure context. Use https:// or localhost; a plain http:// LAN address cannot open the camera.');
  }
  if (!hasMediaDevices) {
    blockers.push('This browser does not expose getUserMedia, so still capture from the phone camera is unavailable.');
  }

  return {
    isMobile,
    secureContext: secure,
    cameraSupported: secure && Boolean(hasMediaDevices),
    rearCameraRequested: true,
    installKind: 'progressive-web-app',
    apkAvailable: false,
    blockers,
    note: 'IntentLens is a desktop Electron app and a responsive web client. There is no APK build.',
  };
}

export function describeMobileSupport(report) {
  if (!report) return 'Mobile capability unknown.';
  if (report.cameraSupported) {
    return report.isMobile
      ? 'Phone web client: camera supported on this secure origin. Install is via the browser PWA prompt.'
      : 'Desktop browser: camera supported on this secure origin.';
  }
  return `Camera unavailable: ${report.blockers.join(' ')}`;
}
