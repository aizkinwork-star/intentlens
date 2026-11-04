// platform/index.js — factory that selects the correct adapters for the current platform.
import { detectPlatform } from './detector.js';

let _cameraAdapter = null;
let _storageAdapter = null;

export async function getCameraAdapter() {
  if (_cameraAdapter) return _cameraAdapter;
  const platform = detectPlatform();
  if (platform === 'electron' || platform === 'electron-dev') {
    try {
      const mod = await import('./electron/cameraAdapter.js');
      _cameraAdapter = new mod.ElectronCameraAdapter();
      return _cameraAdapter;
    } catch { /* fall through */ }
  }
  if (platform === 'capacitor' || platform === 'capacitor-dev') {
    try {
      const mod = await import('./capacitor/cameraAdapter.js');
      _cameraAdapter = new mod.CapacitorCameraAdapter();
      return _cameraAdapter;
    } catch { /* fall through */ }
  }
  const mod = await import('./browser/cameraAdapter.js');
  _cameraAdapter = new mod.BrowserCameraAdapter();
  return _cameraAdapter;
}

export async function getStorageAdapter() {
  if (_storageAdapter) return _storageAdapter;
  const platform = detectPlatform();
  if (platform === 'electron' || platform === 'electron-dev') {
    try {
      const mod = await import('./electron/storageAdapter.js');
      _storageAdapter = new mod.ElectronStorageAdapter();
      await _storageAdapter.init();
      return _storageAdapter;
    } catch { /* fall through */ }
  }
  if (platform === 'capacitor' || platform === 'capacitor-dev') {
    try {
      const mod = await import('./capacitor/storageAdapter.js');
      _storageAdapter = new mod.CapacitorStorageAdapter();
      await _storageAdapter.init();
      return _storageAdapter;
    } catch { /* fall through */ }
  }
  const mod = await import('./browser/storageAdapter.js');
  _storageAdapter = new mod.BrowserStorageAdapter();
  await _storageAdapter.init();
  return _storageAdapter;
}

// Backward-compatible synchronous export for the existing app.js.
// The app uses `camera` synchronously; async adapter selection is available via getCameraAdapter().
import { BrowserCameraAdapter } from './browser/cameraAdapter.js';
export const cameraAdapter = new BrowserCameraAdapter();

export function resetAdapters() {
  _cameraAdapter = null;
  _storageAdapter = null;
}