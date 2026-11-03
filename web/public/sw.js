// Blackbird Studio service worker: makes the app installable and keeps the app shell available offline.
// It never touches /api (data always comes from the server), so nothing private is cached here.
const CACHE = 'blackbird-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add('/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // Page loads: network first, the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return res; }).catch(() => caches.match('/').then((r) => r ?? Response.error())));
    return;
  }
  // Built bundle files have hashed names, so cache first is safe.
  if (url.pathname.startsWith('/app/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
    return;
  }
  // Everything else (icons, logo, manifest) keeps its name when it changes: network first, cache when offline.
  if (url.pathname.startsWith('/app/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }).catch(() => caches.match(req).then((r) => r ?? Response.error())));
  }
});
