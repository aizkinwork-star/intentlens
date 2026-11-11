// server/routes/sync.js — LAN photo transfer for the desktop server.
//
// The only unauthenticated endpoint is POST /api/sync/receive: it is guarded by
// a one-time 6-digit code instead of the session token, because the phone page
// is not paired with the desktop session. Everything that lists or reads items
// still requires the normal session token.

import { networkInterfaces } from 'node:os';
import { readJson, json } from '../lib/http.js';
import { config } from '../config.js';
import { syncStore, SYNC_MAX_ITEM_BYTES } from '../services/syncStore.js';

const RECEIVE_LIMIT_BYTES = SYNC_MAX_ITEM_BYTES + 512 * 1024;
const SYNC_PAGE = 'sync.html';

function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function lanAddresses() {
  const out = [];
  try {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family !== 'IPv4' || entry.internal) continue;
        out.push({ name, address: entry.address });
      }
    }
  } catch { /* no interfaces available */ }
  return out;
}

/**
 * Local page URLs a phone on the same Wi-Fi can open. If the browser already
 * used a LAN address, that one is listed first. Loopback is included last
 * because a phone cannot reach it.
 */
function uploadUrls(req) {
  const port = config.port || 8787;
  const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
  const seen = new Set();
  const urls = [];
  const push = (label, host) => {
    if (!host || seen.has(host)) return;
    seen.add(host);
    urls.push({ label, url: `http://${host}:${port}/${SYNC_PAGE}` });
  };
  const isLoopback = /^(localhost|127\.|\[::1\]|::1)/i.test(hostHeader);
  if (hostHeader && !isLoopback) push('This address', hostHeader);
  for (const { name, address } of lanAddresses()) push(name, address);
  push('This computer only', 'localhost');
  return urls;
}

export async function handleCreateSyncCode(req, res) {
  const created = syncStore.create();
  json(res, 200, {
    ...created,
    urls: uploadUrls(req),
    ttlSeconds: Math.round((created.expiresAt - Date.now()) / 1000),
    note: 'Open the URL on a phone on the same Wi-Fi, enter the code, and send a photo. Codes expire and only exist in this server process.',
  });
}

/** Public: guarded by the one-time code, not the session token. */
export async function handleReceiveSyncItem(req, res) {
  const key = clientKey(req);
  if (syncStore.isBlocked(key)) {
    json(res, 429, { error: { code: 'SYNC_RATE_LIMITED', message: 'Too many invalid upload codes. Wait a few minutes.', retryable: true } });
    return;
  }
  let body;
  try {
    body = await readJson(req, RECEIVE_LIMIT_BYTES);
  } catch (err) {
    const message = err?.code === 'IMAGE_TOO_LARGE'
      ? `That upload is larger than ${Math.round(RECEIVE_LIMIT_BYTES / 1024 / 1024)} MB. Send a smaller photo.`
      : (err?.message || 'The upload could not be read.');
    json(res, err?.status || 400, { error: { code: err?.code || 'BAD_JSON', message, retryable: false } });
    return;
  }
  try {
    const item = syncStore.receive(body?.code, body || {});
    json(res, 201, { ok: true, item });
  } catch (err) {
    const code = err?.code || 'SYNC_FAILED';
    if (code === 'SYNC_CODE_INVALID') {
      const allowed = syncStore.recordFailure(key);
      if (!allowed) {
        json(res, 429, { error: { code: 'SYNC_RATE_LIMITED', message: 'Too many invalid upload codes. Wait a few minutes.', retryable: true } });
        return;
      }
      json(res, 404, { error: { code, message: err.message, retryable: false } });
      return;
    }
    json(res, code === 'SYNC_FULL' ? 409 : 400, { error: { code, message: err.message, retryable: false } });
  }
}

export async function handleListSyncItems(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const code = url.searchParams.get('code') || '';
  const data = syncStore.list(code);
  if (!data) {
    json(res, 404, { error: { code: 'SYNC_CODE_INVALID', message: 'That upload code is invalid or has expired.', retryable: false } });
    return;
  }
  json(res, 200, data);
}

export async function handleGetSyncItem(req, res, code, id) {
  const item = syncStore.get(code, id);
  if (!item) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'That transferred item is not available.', retryable: false } });
    return;
  }
  json(res, 200, item);
}

export async function handleDeleteSyncCode(req, res, code) {
  const removed = syncStore.remove(code);
  json(res, 200, { ok: true, removed });
}
