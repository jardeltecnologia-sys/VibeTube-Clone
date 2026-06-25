// SpeedVox service worker — app-shell caching for an installable, offline-tolerant PWA.
// Network calls (/api, /socket.io, /uploads) always go to the network; the static
// shell is cached so the app opens instantly and survives flaky connectivity —
// the first step toward the mesh/blackout resilience story.

const CACHE = 'speedvox-shell-v39';
const SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/env.js',
  '/js/api.js',
  '/js/mesh.js',
  '/js/mesh-nearby.js',
  '/js/offline.js',
  '/js/calls.js',
  '/js/groupcall.js',
  '/js/webrtc-quality.js',
  '/js/ringtone.js',
  '/js/e2ee.js',
  '/js/ratchet.js',
  '/js/qrcode.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/icon-180.png',
  // Mesh core (Phase 2) — cached so identity/diagnostics work offline too.
  '/mesh-core/index.js',
  '/mesh-core/identity.js',
  '/mesh-core/crypto.js',
  '/mesh-core/envelope.js',
  '/mesh-core/dedupe.js',
  '/mesh-core/forward.js',
  '/mesh-core/base64.js',
  '/mesh-core/chunk.js',
  '/mesh-core/callsignal.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// --- Web Push: show a notification for an incoming message ---
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const isCall = data.type === 'call';
  const title = data.title || 'SpeedVox';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || (isCall ? 'Chamada recebida' : 'Nova mensagem'),
      tag: data.tag || undefined,
      data: {
        chatId: data.chatId || null,
        callId: data.callId || null,
        type: data.type || 'message',
      },
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      renotify: Boolean(data.tag),
      // Calls: keep the notification up until tapped, and vibrate like a ring.
      requireInteraction: isCall,
      vibrate: isCall ? [500, 300, 500, 300, 500, 300, 500] : undefined,
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache realtime/API/media — go straight to the network.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/uploads')
  ) {
    return;
  }

  if (request.method !== 'GET') return;

  // Cache-first for the static shell, falling back to network and updating cache.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached || caches.match('/index.html'));
      return cached || network;
    })
  );
});
