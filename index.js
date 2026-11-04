// IntentLens backend. Serves the static app and the API routes on one origin,
// so the browser never needs to know about the model provider or the API key.
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, modelMode } from './config.js';
import { analyzeHandler } from './routes/analyze.js';
import { json, logRequest, logError } from './lib/http.js';
import { serveStatic } from './lib/static.js';
import { Store } from './store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// User-owned data store (SQLite + image files). Kept out of the public frontend.
const store = new Store({ dataDir: config.dataDir });

function health(res) {
  const mode = modelMode();
  json(res, 200, {
    ok: true,
    service: 'intentlens',
    version: config.version,
    // Never include the key itself, only whether it exists.
    model: {
      mode,
      id: mode === 'live' ? config.modelId : 'mock-demo-board',
      configured: Boolean(config.modelApiKey),
      mockFallback: config.allowMockFallback,
      webSearchAvailable: mode === 'live',
    },
    limits: { maxImageBytes: config.maxImageBytes },
    time: new Date().toISOString(),
  });
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  let path = '/';

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    path = url.pathname;

    let status = 200;
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      status = code;
      return originalWriteHead(code, ...rest);
    };

    if (path === '/api/health' || path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.', retryable: false } });
      } else {
        health(res);
      }
    } else if (path === '/api/analyze') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      } else {
        await analyzeHandler(req, res, store);
      }
    } else if (path === '/api/objects') {
      if (req.method === 'GET') {
        await handleGetObjects(req, res);
      } else if (req.method === 'POST') {
        await handlePostObjects(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path === '/api/projects/current/data' && req.method === 'DELETE') {
      await handleDeleteProject(req, res, 'current');
    } else if (path.match(/^\/api\/projects\/([^\/]+)\/context$/) && req.method === 'GET') {
      const id = decodeURIComponent(path.match(/^\/api\/projects\/([^\/]+)\/context$/)[1]);
      await handleGetContext(req, res, id);
    } else if (path.match(/^\/api\/projects\/([^\/]+)\/end-session$/) && req.method === 'POST') {
      const id = decodeURIComponent(path.match(/^\/api\/projects\/([^\/]+)\/end-session$/)[1]);
      await handleEndSession(req, res, id);
    } else if (path.match(/^\/api\/projects\/([^\/]+)\/data$/) && req.method === 'DELETE') {
      const id = decodeURIComponent(path.match(/^\/api\/projects\/([^\/]+)\/data$/)[1]);
      await handleDeleteProject(req, res, id);
    } else if (path === '/v1/models' || path === '/models') {
      // Some browsers/extensions probe /v1/models. Return an empty list instead
      // of a 404 so the probing stops quickly.
      json(res, 200, { object: 'list', data: [] });
    } else if (path.startsWith('/api/')) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: `No API route ${path}.`, retryable: false } });
    } else if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Static files are read-only.', retryable: false } });
    } else {
      await serveStatic(ROOT, path, req, res);
    }

    logRequest({ method: req.method, path, status, ms: Date.now() - started, client: req.socket.remoteAddress, ua: req.headers['user-agent'] });
  } catch (err) {
    logError(null, err);
    if (!res.writableEnded) {
      json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.', retryable: false } });
    }
  }
});

// ------------------------------------------------------------------
// Object endpoints (§13)
// ------------------------------------------------------------------

async function handleGetObjects(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'projectId is required.', retryable: false } });
    return;
  }
  const objects = store.listObjects(projectId);
  json(res, 200, { objects });
}

async function handlePostObjects(req, res) {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const { id, projectId, userLabel, aiLabel, kind, originalImagePath, cropImagePath,
    sourceFrameId, anchor, box, appearance, partNumber, confidence,
    identityStatus, currentTrackingState, evidence } = body || {};
  if (!projectId) {
    json(res, 400, { error: { code: 'BAD_JSON', message: 'projectId is required.', retryable: false } });
    return;
  }
  store.getOrCreateProject(projectId, `Project ${projectId.slice(0, 6)}`);
  const record = { id, projectId, userLabel, aiLabel, kind, originalImagePath, cropImagePath,
    sourceFrameId, anchor, box, appearance, partNumber, confidence,
    identityStatus, currentTrackingState, evidence };
  const obj = store.createObject(record);
  json(res, 200, { object: obj });
}

// ------------------------------------------------------------------
// Project context / session endpoints (§13)
// ------------------------------------------------------------------

async function handleGetContext(req, res, projectId) {
  const ctx = store.getProjectContext(projectId);
  if (!ctx) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: `Project ${projectId} not found.`, retryable: false } });
    return;
  }
  json(res, 200, ctx);
}

async function handleEndSession(req, res, projectId) {
  // Finalize the session: stop tracking on the server side (client stops the camera),
  // write a summary and preserve history until the user deletes it.
  const body = await readJsonBody(req, config.maxBodyBytes);
  const summary = body && body.summary ? String(body.summary) : null;
  if (summary) store.updateProjectSummary(projectId, summary);
  json(res, 200, { ok: true, projectId });
}

async function handleDeleteProject(req, res, projectId) {
  store.deleteProject(projectId);
  json(res, 200, { ok: true, projectId });
}

async function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text.trim() ? JSON.parse(text) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------
// Startup / shutdown
// ------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

store.open();
server.listen(config.port, '0.0.0.0', () => {
  const mode = modelMode();
  console.log('');
  console.log('  IntentLens');
  console.log(`  local     http://localhost:${config.port}`);
  for (const ip of lanAddresses()) console.log(`  network   http://${ip}:${config.port}`);
  console.log(`  data      ${config.dataDir}`);
  console.log(
    `  model     ${mode === 'live' ? `live (${config.modelId})` : 'MOCK demo board (no MODEL_API_KEY set)'}`,
  );
  if (mode === 'mock') {
    console.log('  note      add MODEL_API_KEY to .env to analyse real camera frames');
  }
  console.log('  camera    needs https:// or localhost; use Upload photo over plain http');
  console.log('');
});

const shutdown = () => {
  store.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
