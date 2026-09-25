/*
 * pi-webui service worker — caches the app shell so the UI installs and opens
 * offline. Live data (/events SSE, /sessions, /health, /api/*) always goes to
 * the network and is never cached.
 *
 * Bump VERSION whenever the precache list changes.
 */
const VERSION = 'v3';
const SHELL = `pi-webui-shell-${VERSION}`;
const RUNTIME = `pi-webui-runtime-${VERSION}`;

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/vendor/marked.min.js',
  '/vendor/highlight.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isLive(pathname) {
  return /^\/(events|sessions|health|api)(\/|$)/.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;               // POST /prompt, /abort, … pass through
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isLive(url.pathname)) return;               // SSE + APIs: network only

  // The manifest drives installability — never serve it stale.
  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(req, { cache: 'reload' })
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Navigations: network-first, falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'reload' })
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets (vendor bundles, icons, manifest): cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
