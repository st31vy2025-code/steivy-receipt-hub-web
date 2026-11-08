/* Steivy Receipt Hub: service worker
   - Makes the Hub installable and gives it a cached app shell for a fast start.
   - Only touches files from this same site. Firebase, Firestore, Auth and fonts are never cached here.
   - Code files (html/js/css/json) are NETWORK-FIRST, so a new GitHub deploy shows up on the next load;
     the cached copy is only used when the network is down.
   - Images and icons are stale-while-revalidate.
   Bump VERSION to force every device to drop its old cache. */
const VERSION = 'steivy-hub-v15';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'firebase-config.js', 'manifest.json',
  'assets/icon-192.png', 'assets/icon-512.png', 'assets/logo.jpg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // add one by one so a single missing file can never block the install
    await Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k.startsWith('steivy-hub-')).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isCode = url => /\.(?:html|js|css|json|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase, Google Fonts etc. go straight to the network

  if (req.mode === 'navigate' || isCode(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req, { cache: 'no-cache' }); // revalidate, never serve a stale copy from the HTTP cache
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
