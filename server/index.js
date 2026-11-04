// IntentLens backend — v8 local-first, strict Meta-only cloud providers.
//
// Serves the static app and the API routes on one origin, so the browser never
// needs to know about the model provider or any API key.
//
// v7 non-negotiables:
//   - Meta AI models only, hosted via cloud providers (NVIDIA NIM primary,
//     Cloudflare Workers AI next, Groq only with a Meta vision model).
//   - No hosted inference from non-Meta models.
//   - No API keys in browser code; keys live in backend .env.
//   - Outbound network restricted to allowlisted inference hosts.
//   - Fail closed when all providers unavailable.

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { markPhase, getStartupReport } from './lib/startup.js';
markPhase('server module evaluation started');

import { config, modelMode, localModelConfig, localModelAvailable, outboundNetworkAllowed, isAllowedOutboundHost, providerConfigured, perceptionStatus, META_MODEL_CATALOG } from './config.js';
import { analyzeHandler } from './routes/analyze.js';
import {
  projectCreateHandler,
  projectListHandler,
  projectGetHandler,
  projectUpdateHandler,
} from './routes/projects.js';
import {
  captureCreateHandler,
  captureGetHandler,
  captureFileHandler,
} from './routes/captures.js';
import { componentAnalyzeHandler } from './routes/componentAnalyze.js';
import { explainHandler } from './routes/explain.js';
import {
  handleGetCloudProviders,
  handleSaveCloudProvider,
  handleDeleteCloudProvider,
  handleTestCloudProvider,
  handleSetOutboundNetwork,
  loadCloudProviderEnv,
} from './routes/providers.js';
import { json, logRequest, logError, getServerLogs, clearServerLogs } from './lib/http.js';
import { serveStatic } from './lib/static.js';
import { handleGetScaler } from './routes/scaler.js';
import { handleTranscribe, handleTranscribeStatus } from './routes/transcribe.js';
import { initSessionToken, getSessionToken, validateSessionToken, authMiddleware } from './lib/auth.js';
import { providerHealthSnapshot } from './services/provider.js';
import { Store } from './store.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load securely stored credentials before the listener starts. In Electron the
// main process supplies safeStorage-decrypted values over IPC.
const credentialSource = await loadCloudProviderEnv();
markPhase('provider credentials loaded', { source: credentialSource });

// A stable local token means a backend restart does not invalidate an open page.
initSessionToken(config.dataDir);
markPhase('session token ready');

// User-owned data store (SQLite + image files). Kept out of the public frontend.
const store = new Store({ dataDir: config.dataDir });

function health(res) {
  const mode = modelMode();
  const configured = localModelAvailable();
  const active = configured ? config.providerPriority.find((id) => providerConfigured(id)) : null;
  json(res, 200, {
    ok: true,
    service: 'intentlens',
    version: config.version,
    // v8: never include key values. Distinguish local perception from cloud AI.
    model: {
      mode,
      id: active ? (active === 'nvidia-nim' ? config.nimModelId : active === 'cloudflare-workers-ai' ? config.cloudflareModelId : config.groqVisionModel) : 'offline',
      configured,
      provider: active,
      localLlm: false,
      localPerception: true,
      mockFallback: false,
      webSearchAvailable: false,
    },
    providers: config.providerPriority.map((id) => ({
      id,
      configured: providerConfigured(id),
      label: META_MODEL_CATALOG[id]?.label || id,
    })),
    providerHealth: providerHealthSnapshot(),
    network: { allowOutboundNetwork: outboundNetworkAllowed() },
    limits: { maxImageBytes: config.maxImageBytes },
    startup: getStartupReport(),
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

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '-';
    const ua = req.headers['user-agent'] || '-';

    // v7: Rate-limit noisy polling endpoints (/health, /v1/models).
    if (path === '/health' || path === '/v1/models' || path === '/models') {
      if (rateLimited(ip)) {
        json(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.', retryable: true } });
        logRequest({ method: req.method, path, status: 429, ms: Date.now() - started, ua });
        return;
      }
    }

    // API authentication gate.
    if (path.startsWith('/api/') && !authMiddleware(req, res)) {
      logRequest({ method: req.method, path, status: 401, ms: Date.now() - started, ua });
      return;
    }

    if (path === '/api/pair') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
      } else {
        const body = await readJsonBody(req, 4096);
        const code = body && body.code;
        if (code && validateSessionToken(code)) {
          json(res, 200, { sessionToken: getSessionToken() });
        } else {
          json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid pairing code.', retryable: false } });
        }
      }
      logRequest({ method: req.method, path, status: res.statusCode || 200, ms: Date.now() - started, ua });
      return;
    }

    if (path === '/api/scaler') {
      if (req.method !== 'GET') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
      } else {
        await handleGetScaler(req, res);
      }
    } else if (path === '/api/health' || path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.', retryable: false } });
      } else {
        res.setHeader('cache-control', 'public, max-age=5');
        health(res);
      }
    } else if (path === '/api/analyze') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      } else {
        await analyzeHandler(req, res, store);
      }
    } else if (path === '/api/local-model') {
      if (req.method === 'GET') {
        await handleGetCloudProviders(req, res);
      } else if (req.method === 'POST' || req.method === 'PUT') {
        await handleSaveCloudProvider(req, res);
      } else if (req.method === 'DELETE') {
        await handleDeleteCloudProvider(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET, POST or DELETE.', retryable: false } });
      }
    } else if (path === '/api/local-model/test') {
      if (req.method === 'GET' || req.method === 'POST') {
        await handleTestCloudProvider(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path === '/api/providers') {
      if (req.method === 'GET') {
        await handleGetCloudProviders(req, res);
      } else if (req.method === 'POST') {
        await handleSaveCloudProvider(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path === '/api/providers/network') {
      if (req.method === 'POST') {
        await handleSetOutboundNetwork(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      }
    } else if (path === '/api/providers/test') {
      if (req.method === 'GET' || req.method === 'POST') {
        await handleTestCloudProvider(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path === '/api/transcribe') {
      if (req.method === 'GET') {
        handleTranscribeStatus(res);
      } else if (req.method === 'POST') {
        await handleTranscribe(req, res);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path.startsWith('/api/providers/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/providers/'.length));
      await handleDeleteCloudProvider(req, res, id);
    } else if (path === '/api/startup') {
      json(res, 200, getStartupReport());
    } else if (path === '/api/logs') {
      if (req.method === 'GET') {
        json(res, 200, { logs: getServerLogs() });
      } else if (req.method === 'DELETE') {
        clearServerLogs();
        json(res, 200, { ok: true, cleared: true });
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or DELETE.' } });
      }
    } else if (path === '/api/component/analyze') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      } else {
        await componentAnalyzeHandler(req, res, store);
      }
    } else if (path === '/api/explain') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      } else {
        await explainHandler(req, res, store);
      }
    } else if (path === '/api/captures') {
      if (req.method !== 'POST') {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.', retryable: false } });
      } else {
        await captureCreateHandler(req, res, store);
      }
    } else if (path === '/api/projects') {
      if (req.method === 'GET') {
        await projectListHandler(req, res, store);
      } else if (req.method === 'POST') {
        await projectCreateHandler(req, res, store);
      } else {
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.', retryable: false } });
      }
    } else if (path.match(/^\/api\/captures\/([^\/]+)\/(original|overlay)$/) && req.method === 'GET') {
      const match = path.match(/^\/api\/captures\/([^\/]+)\/(original|overlay)$/);
      captureFileHandler(req, res, store, decodeURIComponent(match[1]), match[2]);
    } else if (path.match(/^\/api\/captures\/([^\/]+)$/) && req.method === 'GET') {
      const id = decodeURIComponent(path.match(/^\/api\/captures\/([^\/]+)$/)[1]);
      captureGetHandler(req, res, store, id);
    } else if (path.match(/^\/api\/projects\/([^\/]+)$/) && req.method === 'GET') {
      const id = decodeURIComponent(path.match(/^\/api\/projects\/([^\/]+)$/)[1]);
      await projectGetHandler(req, res, store, id);
    } else if (path.match(/^\/api\/projects\/([^\/]+)$/) && (req.method === 'PUT' || req.method === 'PATCH')) {
      const id = decodeURIComponent(path.match(/^\/api\/projects\/([^\/]+)$/)[1]);
      await projectUpdateHandler(req, res, store, id);
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
    } else if (path.startsWith('/api/')) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: `No API route ${path}.`, retryable: false } });
    } else if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Static files are read-only.', retryable: false } });
    } else {
      if (path === '/' || path === '/index.html') {
        const { readFileSync } = await import('node:fs');
        const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
        const injected = html.replace('</head>', `<meta name="intentlens-token" content="${getSessionToken()}"></head>`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(injected);
      } else {
        await serveStatic(ROOT, path, req, res);
      }
    }

    logRequest({ method: req.method, path, status, ms: Date.now() - started, ua });
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
  // v7: Finalize the session: stop tracking on the server side (client stops camera/mic),
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

const rateLimitMap = new Map(); // ip => [{ ts }]
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 10;

function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const hits = rateLimitMap.get(ip) || [];
  const recent = hits.filter((h) => h.ts > windowStart);
  if (recent.length >= RATE_MAX) return true;
  recent.push({ ts: now });
  rateLimitMap.set(ip, recent);
  return false;
}

markPhase('sqlite store opening');
store.open();
markPhase('sqlite store ready');
server.listen(config.port, config.host || '127.0.0.1', () => {
  const mode = modelMode();
  markPhase('http listener ready', { port: config.port });
  console.log('');
  console.log('  IntentLens');
  console.log(`  local     http://localhost:${config.port}`);
  for (const ip of lanAddresses()) console.log(`  network   http://${ip}:${config.port}`);
  console.log(`  data      ${config.dataDir}`);
  console.log(
    `  model     ${mode === 'meta-cloud' ? `cloud generative (Meta only)` : 'offline (local perception only)'}`,
  );
  console.log(`  priority  ${config.providerPriority.join(' -> ')}`);
  console.log(`  secrets   ${credentialSource}`);
  if (!localModelAvailable()) {
    console.log('  note      no Meta vision provider configured. Open Provider Setup in the app.');
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