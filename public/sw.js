const CACHE_NAME = 'web-chat-v1';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    self.clients.claim();
});

// Permite que la app cargue online sin interferir con los sockets
self.addEventListener('fetch', (e) => {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});