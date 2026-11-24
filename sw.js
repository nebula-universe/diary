// 離線快取：修改任何檔案後，把版本號加 1，手機才會載入新版
const CACHE = 'photo-diary-v4';
const FONT_CACHE = 'photo-diary-fonts';   // 字體另外存，更新版本時不會被清掉
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google 字體：第一次下載後存起來，之後離線也能用
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async cache => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          // 最多等 5 秒，網路太慢就先放棄（會用手機內建字型）
          const res = await Promise.race([
            fetch(req),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        } catch (_) {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;
  // App 本身：先用快取（離線也能開），同時在背景更新
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
