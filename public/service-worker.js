const CACHE_NAME = 'atelier-express-v27';
const APP_FILES = [
  '/',
  '/suivi',
  '/app.js',
  '/suivi.js',
  '/offline-store.js',
  '/e-links-intro.js',
  '/e-links-intro.css',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith('atelier-express-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    const data = event.data ? event.data.json() : null;
    payload = data && typeof data === 'object' ? data : {};
  } catch (error) {
    console.error('Notification Push reçue dans un format invalide.', error);
  }
  event.waitUntil(self.registration.showNotification(
    payload.title || 'E-Links · Atelier Express',
    {
      body: payload.body || 'Le statut de votre appareil a été mis à jour.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [300, 120, 300, 120, 650],
      requireInteraction: true,
      renotify: true,
      silent: false,
      tag: 'atelier-express-appareil-pret',
      timestamp: Date.now(),
      data: { url: payload.url || '/suivi' },
      actions: [{ action: 'open-tracking', title: 'Voir le suivi' }],
    },
  ));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data.url || '/suivi', self.location.origin);
  const targetUrl = requestedUrl.origin === self.location.origin
    ? requestedUrl.href
    : new URL('/suivi', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url === targetUrl);
    if (existing && 'focus' in existing) return existing.focus();
    return self.clients.openWindow(targetUrl);
  }));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        return caches.match(new URL(event.request.url).pathname).then((page) => page || Response.error());
      }
      return Response.error();
    })),
  );
});
