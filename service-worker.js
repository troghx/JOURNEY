const CACHE_NAME = 'control-asistencia-cache-v2';
const OFFLINE_URLS = [
  './',
  './control_asistencia.html',
  './assets/css/tailwind.css',
  './assets/css/fonts.css',
  './assets/js/feather.min.js',
  './assets/js/xlsx.full.min.js',
  './assets/fonts/inter-latin-300-normal.woff2',
  './assets/fonts/inter-latin-400-normal.woff2',
  './assets/fonts/inter-latin-500-normal.woff2',
  './assets/fonts/inter-latin-600-normal.woff2',
  './assets/fonts/inter-latin-700-normal.woff2',
  './journey_no_bg.png',
  './journey_background.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isApiRequest =
    isSameOrigin && requestUrl.pathname.startsWith('/.netlify/functions/');

  if (isApiRequest) {
    // Always hit the network for dynamic API responses so attendance updates
    // are never served from the HTTP cache.
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('./control_asistencia.html'))
        )
    );
    return;
  }

  const isPrecachedAsset = OFFLINE_URLS.some((asset) => requestUrl.pathname.endsWith(asset.replace('./', '/')));

  if (isPrecachedAsset || isSameOrigin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached);
      })
    );
  }
});

