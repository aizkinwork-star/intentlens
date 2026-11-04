#!/usr/bin/env node
// Zero-dependency static server for the PWA. Useful before GitHub Pages exists.
// Usage: node scripts/serve-pwa.mjs  (then open http://localhost:8020)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const root = join(process.cwd(), 'pwa');
const port = Number(process.env.PORT || 8020);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const resolved = normalize(join(root, pathname));
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(resolved);
    const file = info.isDirectory() ? join(resolved, 'index.html') : resolved;
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`IntentLens PWA: http://localhost:${port}`);
  console.log('Camera and mic need localhost or HTTPS. Use a phone tunnel for a real device test.');
});
