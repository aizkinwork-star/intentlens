// pwa/sw.js — offline shell only.
//
// Never caches model requests, images or Authorization-bearing responses.
// Only same-origin GET assets are handled.

const CACHE = 'intentlens-pwa-v12';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './provider.js',
  './prompt.js',
  './safe.js',
  './camera.js',
  './geometry.js',
  './manifest.webmanifest',
  './lib/grid.js',
  './lib/componentResult.js',
  './lib/intentlens_tts.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' bypasses an unexpired HTTP cache. Without it a new
      // versioned worker can copy the previous app.js into the new cache and
      // keep serving the old UI even though sw.js changed.
      .then((cache) => Promise.all(SHELL.map(async (url) => {
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) await cache.put(url, response);
        } catch {
          /* an optional asset may be missing; the shell still installs */
        }
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('authorization')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    })),
  );
});
