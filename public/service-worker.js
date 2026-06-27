// SpeedVox service worker — app-shell caching for an installable, offline-tolerant PWA.
// Network calls (/api, /socket.io, /uploads) always bypass the service worker.
// The static shell is cached and updated with a Network-First strategy to avoid stale code.

const CACHE = 'speedvox-shell-v19';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/mesh.js',
  '/js/calls.js',
  '/js/groupcall.js',
  '/js/e2ee.js',
  '/js/ratchet.js',
  '/js/qrcode.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

// Install: cache-bust all files to get the fresh copies, but store under clean keys
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => {
        return Promise.all(
          SHELL.map((url) => {
            const cacheBustUrl = `${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}`;
            return fetch(new Request(cacheBustUrl, { cache: 'reload' }))
              .then((res) => {
                if (res.ok) {
                  return cache.put(url, res);
                }
                throw new Error(`Failed to fetch ${url} during SW install`);
              });
          })
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches immediately and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// --- Web Push: show a notification for an incoming message ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'SpeedVox';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Nova mensagem',
      tag: data.tag || undefined,
      data: { chatId: data.chatId || null },
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      renotify: Boolean(data.tag),
    })
  );
});

// Focus (or open) the app and jump to the relevant chat when tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chatId;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if (chatId) client.postMessage({ type: 'open-chat', chatId });
          return client.focus();
        }
      }
      return self.clients.openWindow(`/${chatId ? `?chat=${chatId}` : ''}`);
    })
  );
});

// Fetch: Network-First strategy with dynamic route bypass
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Dynamic bypass: API, WebSockets, media uploads, and the service worker itself
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/uploads') ||
    url.pathname === '/service-worker.js'
  ) {
    const fetchOptions = request.method === 'GET' ? { cache: 'no-store' } : {};
    event.respondWith(fetch(request, fetchOptions));
    return;
  }

  if (request.method !== 'GET') return;

  // 2. Network-First strategy for static assets and shell
  const isShellAsset = SHELL.includes(url.pathname);
  const fetchOptions = isShellAsset ? { cache: 'no-cache' } : {};

  event.respondWith(
    fetch(request, fetchOptions)
      .then((res) => {
        // If it's a valid local response, update the cache
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => {
        // Network failed (offline) -> fallback to cache (supporting query parameters)
        return caches.match(request, { ignoreSearch: true }).then((cached) => {
          if (cached) return cached;

          // If navigation or HTML request, serve index.html as SPA fallback
          if (request.mode === 'navigate' || (request.headers.get('accept') && request.headers.get('accept').includes('text/html'))) {
            return caches.match('/index.html', { ignoreSearch: true });
          }

          // Otherwise, return generic offline response
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
