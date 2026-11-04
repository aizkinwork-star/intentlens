import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { json } from './http.js';

let currentToken = null;
let tokenFile = null;

/**
 * Load the local pairing token, creating it once. Persisting the token means a
 * backend restart (or an Electron crash/restart) no longer invalidates a page
 * that is already open. The token is a local capability, not a user account.
 */
export function initSessionToken(dataDir = './intentlens-data') {
  tokenFile = resolve(dataDir, '.session-token');
  try {
    if (existsSync(tokenFile)) {
      const existing = readFileSync(tokenFile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(existing)) {
        currentToken = existing;
        return currentToken;
      }
    }
  } catch { /* create a new token below */ }

  currentToken = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tokenFile, currentToken, { encoding: 'utf8', mode: 0o600 });
  } catch { /* an in-memory token still authenticates this process */ }
  return currentToken;
}

export function generateSessionToken() {
  currentToken = randomBytes(32).toString('hex');
  return currentToken;
}

export function getSessionToken() { return currentToken; }

export function validateSessionToken(token) {
  if (!currentToken || !token) return false;
  const a = Buffer.from(currentToken);
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function authMiddleware(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return true;
  if (path === '/api/health' || path === '/api/pair') return true;
  const header = req.headers['x-intentlens-token'] || req.headers['authorization'];
  const token = header && String(header).startsWith('Bearer ') ? String(header).slice(7) : header;
  if (!validateSessionToken(token)) {
    json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'This page is out of date after a server restart. Reload to reconnect.', retryable: true } });
    return false;
  }
  return true;
}
