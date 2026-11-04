import { app, BrowserWindow, ipcMain, session, safeStorage, shell } from 'electron';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let backendProcess = null;
let mainWindow = null;
let backendRestartTimer = null;
let quitting = false;

const PORT = process.env.PORT || '8000';
const HOST = '127.0.0.1';
const APP_ORIGIN = `http://${HOST}:${PORT}`;

/**
 * Open provider console links in the user's real browser (Chrome/Edge/...).
 * In-window popups are blocked by the sandboxed renderer and the strict CSP,
 * which made provider setup links look broken.
 */
function openInBrowser(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    shell.openExternal(target.toString()).catch((err) => {
      log(`openExternal failed: ${err.message}`);
    });
    return true;
  } catch {
    return false;
  }
}

function userDataDir() {
  return app.getPath('userData');
}

function logFile() {
  const dir = path.join(userDataDir(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'intentlens-main.log');
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
  console.log(line);
}

/** Locate server/index.js in development and in a packaged app. */
function resolveBackendPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'server', 'index.js'),
    path.join(__dirname, '..', 'server', 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[1];
}

function backendEnv(backendPath) {
  const dataDir = path.join(userDataDir(), 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    INTENTLENS_ELECTRON: '1',
    PORT,
    HOST,
    DATA_DIR: dataDir,
    INTENTLENS_BACKEND: backendPath,
    // The packaged app does not ship .env, so the server default would allow
    // outbound calls. Keep cloud access opt-in: set ALLOW_OUTBOUND_NETWORK=true
    // in the environment to enable it deliberately on a packaged install.
    ALLOW_OUTBOUND_NETWORK: process.env.ALLOW_OUTBOUND_NETWORK || 'false',
  };
}

function startBackend() {
  const backendPath = resolveBackendPath();
  const appRoot = path.dirname(path.dirname(backendPath));
  const env = backendEnv(backendPath);

  log(`starting backend: ${backendPath}`);
  log(`backend cwd: ${appRoot}`);

  backendProcess = spawn(process.execPath, [backendPath], {
    cwd: appRoot,
    // 'ipc' is required for the backend to ask this process to encrypt or
    // decrypt provider credentials with Electron safeStorage. Without it the
    // backend silently falls back to Windows DPAPI.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
  });

  backendProcess.stdout.on('data', (d) => log(`[backend] ${String(d).trimEnd()}`));
  backendProcess.stderr.on('data', (d) => log(`[backend err] ${String(d).trimEnd()}`));
  backendProcess.on('message', (message) => handleCredentialMessage(message));
  backendProcess.on('error', (err) => log(`[backend] spawn error: ${err.message}`));
  backendProcess.on('exit', (code, signal) => {
    log(`[backend] exited code=${code} signal=${signal || 'none'}`);
    backendProcess = null;
    if (quitting || code === 0) return;
    if (backendRestartTimer) return;
    backendRestartTimer = setTimeout(async () => {
      backendRestartTimer = null;
      if (quitting) return;
      log('backend crashed; restarting');
      startBackend();
      const ready = await waitForBackend(PORT);
      if (ready && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://${HOST}:${PORT}`);
      }
    }, 2000);
  });
}

function stopBackend() {
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  if (backendProcess && !backendProcess.killed) {
    try { backendProcess.kill('SIGTERM'); } catch {}
    backendProcess = null;
  }
}

function waitForBackend(port, retries = 80) {
  return new Promise((resolve) => {
    const tryOnce = (n) => {
      const req = http.get(`http://${HOST}:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true);
        else if (n > 0) setTimeout(() => tryOnce(n - 1), 250);
        else resolve(false);
      });
      req.on('error', () => {
        if (n > 0) setTimeout(() => tryOnce(n - 1), 250);
        else resolve(false);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce(retries);
  });
}

// ---------------------------------------------------------------------------
// Secure credential store for the backend child process.
//
// The renderer never gets encrypt/decrypt access. Only the backend over its
// private IPC channel can request it, and only opaque ciphertext is stored on
// disk. The plaintext credentials exist in memory only while the request is
// being served.
// ---------------------------------------------------------------------------
function credentialFile() {
  return path.join(userDataDir(), 'credentials.safe');
}

function readEncryptedCredentials() {
  try {
    if (!fs.existsSync(credentialFile())) return null;
    const raw = fs.readFileSync(credentialFile(), 'utf8').trim();
    if (!raw) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      log('safeStorage unavailable while loading saved credentials');
      return null;
    }
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch (err) {
    log(`credential decrypt failed: ${err.message}`);
    return null;
  }
}

function writeEncryptedCredentials(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage is not available on this system.');
  }
  const ciphertext = safeStorage.encryptString(plaintext);
  const target = credentialFile();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, ciphertext.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

function handleCredentialMessage(message) {
  if (!message || message.type !== 'credentials') return;
  const { id, action, payload } = message;
  const respond = (ok, data, error) => {
    if (!backendProcess || backendProcess.killed) return;
    try {
      backendProcess.send({ type: 'credential-response', id, ok, data, error });
    } catch (err) {
      log(`credential response failed: ${err.message}`);
    }
  };

  try {
    if (action === 'load') {
      const plaintext = readEncryptedCredentials();
      if (!plaintext) return respond(true, null);
      const parsed = JSON.parse(plaintext);
      return respond(true, parsed && typeof parsed === 'object' ? parsed : null);
    }
    if (action === 'save') {
      if (!payload || typeof payload !== 'object') {
        return respond(false, null, 'invalid credential payload');
      }
      writeEncryptedCredentials(JSON.stringify(payload));
      return respond(true, { saved: true });
    }
    if (action === 'clear') {
      try { fs.unlinkSync(credentialFile()); } catch {}
      return respond(true, { cleared: true });
    }
    return respond(false, null, `unknown credential action: ${action}`);
  } catch (err) {
    log(`credential ${action} failed: ${err.message}`);
    return respond(false, null, err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
    title: 'IntentLens',
  });

  // Security headers. wasm-unsafe-eval is needed for the locally bundled
  // OpenCV build; no remote scripts are permitted.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:*; worker-src 'self' blob:",
        ],
        'X-Frame-Options': ['DENY'],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  waitForBackend(PORT).then((ready) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!ready) log('backend did not become ready in time');
    mainWindow.loadURL(`http://${HOST}:${PORT}`);
  });

  mainWindow.on('closed', () => { mainWindow = null; stopBackend(); app.quit(); });

  // Provider help links must leave the app. The renderer is sandboxed and the
  // CSP forbids remote content, so an in-app popup would stay blank.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === APP_ORIGIN) return;
    } catch {
      return;
    }
    event.preventDefault();
    openInBrowser(url);
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

// Single-instance lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    startBackend();
    createWindow();
  });
}

app.on('window-all-closed', () => { stopBackend(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { quitting = true; stopBackend(); });

ipcMain.handle('get-app-info', () => ({ name: 'IntentLens', version: '0.4.0', platform: process.platform }));
// Non-secret diagnostics for the renderer/UI. Never returns key material.
ipcMain.handle('get-credential-store-info', () => ({
  available: safeStorage.isEncryptionAvailable(),
  backend: safeStorage.isEncryptionAvailable() ? 'electron-safe-storage' : 'unavailable',
  platform: process.platform,
}));

process.on('SIGINT', () => { quitting = true; stopBackend(); app.quit(); });
process.on('SIGTERM', () => { quitting = true; stopBackend(); app.quit(); });
