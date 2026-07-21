var CACHE = 'ai-router-v44';
/* Relative (no leading slash) so these resolve against this script's own
   location. The app is served from a subpath (e.g. /openai-router/), and
   an absolute '/index.html' would resolve to the site ROOT, not the app -
   causing cache.addAll() to fail on a 404 and the install step to abort
   with nothing cached at all. */
var FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-32.png',
  './icon-192.png',
  './icon-512.png'
];

/* Install - cache core files */
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(FILES);
    })
  );
});

/* Activate - delete old caches */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

/* Fetch - network first, fall back to cache */
self.addEventListener('fetch', function(e) {
  /* Skip non-GET and cross-origin requests */
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request).then(function(res) {
      /* Clone and cache the fresh response */
      var copy = res.clone();
      caches.open(CACHE).then(function(cache) {
        cache.put(e.request, copy);
      });
      return res;
    }).catch(function() {
      /* Offline fallback */
      return caches.match(e.request);
    })
  );
});
