/* Forza Maggica Roma — service worker
   - guscio dell'app in cache: si apre anche offline
   - font e immagini: cache con aggiornamento in background
   - notizie e partite: le gestisce l'app (con copia salvata sul dispositivo) */
const VERSION = 'fmr-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SHELL_FILES = [
  './', './index.html', './css/style.css', './js/app.js', './manifest.webmanifest',
  './icons/emblem.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // pagina: prima la rete, poi la copia salvata
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // file dell'app: copia salvata subito, aggiornamento in background
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // font Google: cache-first
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); return res;
      }))
    );
    return;
  }

  // immagini (stemmi, foto delle notizie): stale-while-revalidate, cache limitata
  if (req.destination === 'image') {
    e.respondWith(
      caches.open(RUNTIME).then(async c => {
        const hit = await c.match(req);
        const net = fetch(req).then(res => {
          if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimCache(RUNTIME, 250); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
