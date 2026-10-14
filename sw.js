/* 語言訓練場 Service Worker
 * 策略：network-first（有網路永遠拿最新版），失敗時回退 cache（離線可開）。
 */
const CACHE_NAME = 'langhub-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './modules.js',
  './modules/en/index.html',
  './modules/fr/index.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // 只處理同源請求；跨網域（例如 Supabase 雲端同步）一律交給瀏覽器原生處理，不攔截、不快取。
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone).catch(() => {});
        }).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        const p = new URL(event.request.url).pathname;
        if(p.indexOf('/modules/en/') !== -1) return caches.match('./modules/en/index.html');
        if(p.indexOf('/modules/fr/') !== -1) return caches.match('./modules/fr/index.html');
        return caches.match('./index.html');
      }))
  );
});
