// server/lib/credentialStore.js — secret persistence for provider credentials.
//
// Two backends, both encrypt at rest:
//   1. Electron: the backend child process asks the main process over IPC.
//      Main uses Electron safeStorage (DPAPI on Windows, Keychain on macOS,
//      libsecret on Linux).
//   2. Standalone server / tests: DPAPI on Windows. If neither is available we
//      refuse to write secrets rather than falling back to plaintext.
//
// Provider keys are NEVER logged and never returned to the renderer.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeNimBaseUrl, normalizeTier, buildRuntimeState } from '../config.js';
import { ALL_SECRET_ENV_KEYS } from '../../modelRegistry.js';

// Every provider key/model/base-url variable is allowed to be persisted. The
// registry is the source of truth so adding a provider cannot silently drop a
// credential on the next save.
const SECRET_KEYS = [...new Set([
  ...ALL_SECRET_ENV_KEYS,
  'NIM_API_KEY', 'NIM_BASE_URL', 'NIM_ENABLED', 'NIM_MODEL_ID',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_MODEL_ID',
  'GROQ_API_KEY', 'GROQ_TEXT_MODEL', 'GROQ_VISION_MODEL', 'GROQ_MODEL_ID',
  'OPENROUTER_API_KEY', 'OPENROUTER_MODEL_ID',
  'BLOCKRUN_API_KEY', 'BLOCKRUN_MODEL_ID',
  'MODAL_API_KEY', 'MODAL_BASE_URL', 'MODAL_MODEL_ID',
  'REPLICATE_API_TOKEN', 'REPLICATE_SAM_MODEL', 'REPLICATE_SAM_VERSION',
  'SAM2_ENABLED', 'SAM2_INPUT_STYLE',
  'PROVIDER_PRIORITY', 'MODEL_ACCESS_TIER',
])];

let cachedCredentials = null;
let cachedSource = 'none';

function sanitizeCredentials(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of SECRET_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value);
    if (!text) continue;
    out[key] = text;
  }
  return out;
}

function askParent(action, payload, timeoutMs = 8000) {
  return new Promise((resolvePromise, reject) => {
    if (typeof process.send !== 'function') {
      resolvePromise(null);
      return;
    }
    const id = `cred_${randomUUID()}`;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('secure credential request timed out'));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!message || message.type !== 'credential-response' || message.id !== id) return;
      if (done) return;
      done = true;
      cleanup();
      if (message.ok) resolvePromise(message.data ?? null);
      else reject(new Error(message.error || 'secure credential request failed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      try { process.off('message', onMessage); } catch {}
    };
    process.on('message', onMessage);
    try {
      process.send({ type: 'credentials', id, action, payload });
    } catch (err) {
      done = true;
      cleanup();
      reject(err);
    }
  });
}

function dataDir() {
  return resolve(process.env.DATA_DIR || './intentlens-data');
}

function encryptedPath() {
  return resolve(dataDir(), 'credentials.dpapi');
}

function dpapiAvailable() {
  return process.platform === 'win32';
}

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  }).trim();
}

function dpapiProtect(plaintext) {
  const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${b64}')`,
    "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    '[Convert]::ToBase64String($e)',
  ].join('\n');
  return runPowerShell(script);
}

function dpapiUnprotect(ciphertext) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${ciphertext.replace(/'/g, "''")}')`,
    "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    '[Convert]::ToBase64String($d)',
  ].join('\n');
  return Buffer.from(runPowerShell(script), 'base64').toString('utf8');
}

function readLegacyPlaintext() {
  // Migration path only. The file is deleted after a successful secure write.
  const candidates = [
    resolve(dataDir(), 'provider-config.json'),
    resolve(process.cwd(), 'intentlens-config.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return { file, credentials: sanitizeCredentials(parsed) };
    } catch { /* ignore malformed legacy config */ }
  }
  return null;
}

/** Load credentials from the most secure available store. */
export async function loadCredentials() {
  if (cachedCredentials) return { credentials: { ...cachedCredentials }, source: cachedSource };

  // Electron main process owns the safeStorage key.
  try {
    const fromParent = await askParent('load');
    if (fromParent && typeof fromParent === 'object') {
      cachedCredentials = sanitizeCredentials(fromParent);
      cachedSource = 'electron-safe-storage';
      return { credentials: { ...cachedCredentials }, source: cachedSource };
    }
  } catch (err) {
    // Standalone server (no parent channel) or main process unavailable.
  }

  if (dpapiAvailable() && existsSync(encryptedPath())) {
    try {
      const json = dpapiUnprotect(readFileSync(encryptedPath(), 'utf8').trim());
      cachedCredentials = sanitizeCredentials(JSON.parse(json));
      cachedSource = 'windows-dpapi';
      return { credentials: { ...cachedCredentials }, source: cachedSource };
    } catch { /* fall through to migration */ }
  }

  const legacy = readLegacyPlaintext();
  if (legacy) {
    cachedCredentials = legacy.credentials;
    cachedSource = 'legacy-plaintext-migrated';
    try {
      await saveCredentials(cachedCredentials);
      try { unlinkSync(legacy.file); } catch {}
    } catch { /* keep migration source; never destroy the only copy */ }
    return { credentials: { ...cachedCredentials }, source: cachedSource };
  }

  cachedCredentials = {};
  cachedSource = 'none';
  return { credentials: {}, source: cachedSource };
}

/** Persist credentials securely. Throws when no secure store is available. */
export async function saveCredentials(input) {
  const credentials = sanitizeCredentials(input);

  if (typeof process.send === 'function') {
    await askParent('save', credentials);
    cachedCredentials = credentials;
    cachedSource = 'electron-safe-storage';
    return { ok: true, source: cachedSource };
  }

  if (!dpapiAvailable()) {
    throw new Error('No secure credential store is available on this platform. Set provider keys in the server environment instead.');
  }

  mkdirSync(dataDir(), { recursive: true });
  const ciphertext = dpapiProtect(JSON.stringify(credentials));
  const target = encryptedPath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, ciphertext, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, target);
  cachedCredentials = credentials;
  cachedSource = 'windows-dpapi';
  return { ok: true, source: cachedSource };
}

export async function clearCredentials() {
  cachedCredentials = {};
  cachedSource = 'none';
  if (typeof process.send === 'function') {
    try { await askParent('clear'); } catch { /* still clear local cache */ }
  }
  try { if (existsSync(encryptedPath())) unlinkSync(encryptedPath()); } catch {}
}

export function getCredentialSource() {
  return cachedSource;
}

/** Apply credentials to process.env (never to logs). */
export function applyCredentialsToEnv(credentials) {
  if (!credentials || typeof credentials !== 'object') return;
  for (const [key, value] of Object.entries(sanitizeCredentials(credentials))) {
    process.env[key] = value;
  }
}

/** Refresh the live config object after credential changes. */
export async function applyCredentialsToConfig(config) {
  if (!config) return;
  const env = process.env;
  const next = buildRuntimeState();

  // Generic runtime state is authoritative for the router and provider routes.
  config.providers = next.providers;
  config.providerPriority = next.priority;
  config.accessTier = normalizeTier(env.MODEL_ACCESS_TIER || config.accessTier);

  // Keep legacy flattened fields in sync for older modules/tests.
  config.cloudflareAccountId = (env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  config.cloudflareApiToken = (env.CLOUDFLARE_API_TOKEN || '').trim();
  config.cloudflareModelId = (env.CLOUDFLARE_MODEL_ID || config.cloudflareModelId || '@cf/meta/llama-3.2-11b-vision-instruct').trim();
  config.nimApiKey = (env.NIM_API_KEY || '').trim();
  config.nimBaseUrl = normalizeNimBaseUrl(env.NIM_BASE_URL || config.nimBaseUrl);
  config.nimModelId = (env.NIM_MODEL_ID || config.nimModelId || 'meta/muse-glimmer-30b').trim();
  config.nimEnabled = env.NIM_ENABLED === undefined
    ? config.nimEnabled
    : String(env.NIM_ENABLED).toLowerCase() === 'true' || String(env.NIM_ENABLED) === '1';
  config.groqApiKey = (env.GROQ_API_KEY || '').trim();
  config.groqTextModel = (env.GROQ_TEXT_MODEL || config.groqTextModel || '').trim();
  config.groqVisionModel = (env.GROQ_VISION_MODEL || env.GROQ_MODEL_ID || '').trim();
  config.openrouterApiKey = (env.OPENROUTER_API_KEY || '').trim();
  config.openrouterModelId = (env.OPENROUTER_MODEL_ID || config.openrouterModelId || 'meta-llama/llama-4-maverick').trim();
  config.blockrunApiKey = (env.BLOCKRUN_API_KEY || '').trim();
  config.blockrunModelId = (env.BLOCKRUN_MODEL_ID || config.blockrunModelId || '').trim();
  config.modalApiKey = (env.MODAL_API_KEY || '').trim();
  config.modalBaseUrl = (env.MODAL_BASE_URL || config.modalBaseUrl || '').trim();
  config.modalModelId = (env.MODAL_MODEL_ID || config.modalModelId || '').trim();

  // Hosted segmentation is optional; keep its runtime state in sync when a
  // token or toggle is saved without requiring a server restart.
  if (config.sam2) {
    config.sam2.apiToken = (env.REPLICATE_API_TOKEN || config.sam2.apiToken || '').trim();
    config.sam2.modelId = (env.REPLICATE_SAM_MODEL || config.sam2.modelId || 'meta/sam-2').trim();
    config.sam2.version = (env.REPLICATE_SAM_VERSION ?? config.sam2.version ?? '').trim();
    if (env.SAM2_ENABLED !== undefined) {
      config.sam2.enabled = String(env.SAM2_ENABLED).toLowerCase() === 'true' || String(env.SAM2_ENABLED) === '1';
    }
    config.sam2.inputStyle = (env.SAM2_INPUT_STYLE || config.sam2.inputStyle || 'automatic').trim().toLowerCase();
    config.sam2Enabled = config.sam2.enabled === true;
  }
}

export const SECRET_ENV_KEYS = SECRET_KEYS;
