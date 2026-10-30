const CACHE = 'kmc-remote-__VERSION__';
const FILES = __PRECACHE__;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('kmc-remote-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // Commands and live state always use the network; never queue or replay them.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/remote-api/')) return;
  if (url.pathname === '/remote.html' && request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/remote.html')));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
