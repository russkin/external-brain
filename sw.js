const CACHE = 'extbrain-v39';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './store.js',
  './sync.js',
  './src/logic.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './docs/USER_GUIDE.html'
];

self.addEventListener('install', (e) => {
  /* Файлы брать строго из сети (cache: 'reload'): GitHub Pages отдаёт
   * Cache-Control: max-age=600, и обычный addAll может положить в кэш
   * HTTP-устаревшие файлы прошлого релиза — тогда доработки видны,
   * а метка версии (она в app.js) остаётся старой. */
  var fresh = ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); });
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  /* Проверка новой версии (app.js?nocache=…): всегда строго из сети,
   * в кэш не кладём, чтобы не плодить мусорные записи. */
  if (e.request.url.indexOf('nocache=') !== -1) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok && e.request.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
