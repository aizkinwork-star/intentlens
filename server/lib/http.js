// Request/response helpers. Small on purpose: the whole API is two routes.
import { appError } from './errors.js';

export function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Reads a JSON body, refusing anything bigger than `limit` bytes.
// The limit exists mainly for base64 images: a 50 MB inline image would hang the demo.
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(appError('IMAGE_TOO_LARGE', `Request body is ${declared} bytes; the limit is ${limit}.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(appError('IMAGE_TOO_LARGE', `Request body exceeded ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(appError('BAD_JSON', 'The request body was not valid JSON.'));
      }
    });

    req.on('error', (err) => {
      if (failed) return;
      failed = true;
      reject(err);
    });
  });
}

const SERVER_LOGS = [];
const MAX_SERVER_LOGS = 150;

export function recordServerLog({ level = 'info', category = 'server', message, detail, code, status, ms }) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    time: new Date().toISOString(),
    level, // 'info' | 'warn' | 'error' | 'ok'
    category, // 'api' | 'provider' | 'model' | 'server'
    message,
    detail: detail ? String(detail).slice(0, 500) : undefined,
    code,
    status,
    ms,
  };
  SERVER_LOGS.unshift(entry);
  if (SERVER_LOGS.length > MAX_SERVER_LOGS) SERVER_LOGS.pop();
  return entry;
}

export function getServerLogs() {
  return [...SERVER_LOGS];
}

export function clearServerLogs() {
  SERVER_LOGS.length = 0;
}

// Only requestId / timing / status ever get logged. Never images, audio or keys.
// User-Agent helps identify what's hitting endpoints (extensions, scanners, etc.).
export function logRequest({ requestId, method, path, status, ms, mode, ua }) {
  const id = requestId || '-';
  const suffix = [mode && `mode=${mode}`, `${ms}ms`, ua ? `ua=${ua}` : ''].filter(Boolean).join(' ');
  console.log(`[${id}] ${method} ${path} ${status} ${suffix}`);
  recordServerLog({
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    category: path.startsWith('/api') ? 'api' : 'static',
    message: `${method} ${path} ${status} (${ms}ms)`,
    status,
    ms,
  });
}

export function logError(requestId, err) {
  const id = requestId || '-';
  const code = err?.code || (err?.name === 'AppError' ? 'APP_ERROR' : 'ERROR');
  const message = err?.message || String(err);
  if (err?.name === 'AppError') {
    console.warn(`[${id}] ${err.code}: ${err.message}`);
  } else {
    console.error(`[${id}] unhandled: ${err?.message || err}`);
  }
  recordServerLog({
    level: 'error',
    category: 'api',
    message: `${code}: ${message}`,
    detail: undefined,
    code,
  });
}
