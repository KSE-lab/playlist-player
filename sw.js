// 앱 화면을 기기에 저장해 두어 인터넷이 없어도 열리게 해요. (영상은 인터넷 필요)
const CACHE = 'pp-1.4.1';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'app.js', 'store.js', 'google.js', 'importer.js', 'player.js', 'skip.js', 'config.js', 'icons.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// 같은 사이트 파일: 인터넷이 되면 새 파일, 안 되면 저장해 둔 파일
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
