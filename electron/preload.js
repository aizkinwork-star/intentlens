// electron/preload.js — Preload script for Electron.
// Exposes a minimal, non-secret API to the renderer process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intentlens', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  // Reports whether safeStorage is available. Never exposes encrypt/decrypt or
  // any credential value to the page; provider keys stay in the backend.
  getCredentialStoreInfo: () => ipcRenderer.invoke('get-credential-store-info'),
});
