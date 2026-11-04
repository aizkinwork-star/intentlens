import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMobileSupport, describeMobileSupport } from './mobileSupport.js';

test('a phone on a plain http LAN address is reported as camera-blocked', () => {
  const report = inspectMobileSupport({
    secureContext: false,
    hasMediaDevices: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile Safari/537.36',
    viewportWidth: 390,
  });
  assert.equal(report.isMobile, true);
  assert.equal(report.cameraSupported, false);
  assert.match(report.blockers.join(' '), /https:\/\/ or localhost/);
  assert.equal(report.apkAvailable, false);
  assert.match(describeMobileSupport(report), /Camera unavailable/);
});

test('a phone on a secure origin reports camera support but still no APK', () => {
  const report = inspectMobileSupport({
    secureContext: true,
    hasMediaDevices: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile Safari/537.36',
    viewportWidth: 390,
  });
  assert.equal(report.cameraSupported, true);
  assert.equal(report.installKind, 'progressive-web-app');
  assert.equal(report.apkAvailable, false);
  assert.deepEqual(report.blockers, []);
});

test('local desktop without mediaDevices is not claimed as working', () => {
  const report = inspectMobileSupport({ secureContext: true, hasMediaDevices: false });
  assert.equal(report.cameraSupported, false);
  assert.match(report.blockers.join(' '), /getUserMedia/);
});
