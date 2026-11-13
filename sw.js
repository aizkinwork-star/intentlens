// IntentLens service worker — enables offline/PWA installability.
// The core app still needs the local Node backend for /api/* routes.
//
// Strategy: network-first for the shell and code so a rebuilt app is not stuck
// on an old cached UI. Cached copies are only an offline fallback.
const CACHE = 'intentlens-v5';
const ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './grid.js',
  './speech.js',
  './schema.js',
  './phoneBoard.js',
  './tracker.js',
  './cameraAdapter.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API and non-GET requests always go to the network.
  if (url.pathname.startsWith('/api/') || request.method !== 'GET') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          // Cache the HTML under the stable shell key so the offline fallback
          // does not depend on the exact query string.
          cache.put(new Request('./index.html'), fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = await caches.match('./index.html');
        return cached || new Response('IntentLens is offline. Start the local server and reload.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh.ok && url.origin === self.location.origin) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error(`offline and not cached: ${url.pathname}`);
    }
  })());
});
