// Serves the static frontend from the repo root. No build step, so no bundler.
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Files/directories that must never be served, even by accident.
const BLOCKED_NAMES = new Set([
  '.env', '.git', '.gitignore', 'package-lock.json', 'intentlens-config.json',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.db-wal', '.db-shm',
  '.log', '.rar', '.zip', '.key', '.pem',
]);
const BLOCKED_PREFIXES = [
  'intentlens-data/', 'server/', 'electron/', 'node_modules/',
];

function isBlocked(relPath) {
  const normalized = relPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const base = lower.split('/').pop() || '';
  if (BLOCKED_NAMES.has(base)) return true;
  for (const ext of BLOCKED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  // double extension like .sqlite-wal already covered
  for (const prefix of BLOCKED_PREFIXES) {
    if (lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix)) return true;
  }
  if (lower.split('/').some((seg) => seg.startsWith('.'))) return true;
  return false;
}

export async function serveStatic(root, pathname, req, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const target = resolve(join(root, normalize(rel)));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  // Directory traversal guard: the resolved path must stay under the repo root.
  if (target !== root && !target.startsWith(rootWithSep)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const relPath = target.slice(rootWithSep.length).replaceAll('\\', '/');
  if (isBlocked(relPath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
    if (stat.isDirectory()) {
      stat = await fs.stat(join(target, 'index.html'));
      return serveFile(join(target, 'index.html'), stat, req, res);
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  return serveFile(target, stat, req, res);
}

function serveFile(file, stat, req, res) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    // Dev server: always fresh, so an edited app.js shows up on the phone.
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
