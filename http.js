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

// Only requestId / timing / status ever get logged. Never images, audio or keys.
export function logRequest({ requestId, method, path, status, ms, mode, client, ua }) {
  const id = requestId || '-';
  // client = who asked (address + short browser/app name), so odd repeated requests can be traced.
  const who = client ? `from ${client}${ua ? ` (${String(ua).slice(0, 48)})` : ''}` : '';
  const suffix = [mode && `mode=${mode}`, `${ms}ms`, who].filter(Boolean).join(' ');
  console.log(`[${id}] ${method} ${path} ${status} ${suffix}`);
}

export function logError(requestId, err) {
  const id = requestId || '-';
  if (err?.name === 'AppError') {
    console.warn(`[${id}] ${err.code}: ${err.message}`);
    return;
  }
  console.error(`[${id}] unhandled: ${err?.message || err}`);
}
