'use strict';
// ATENÇÃO: subir CACHE_NAME a cada deploy que mude assets do shell.
// Só o "shell" (HTML/CSS/JS/ícones) é cacheado. /api/*, autenticação e qualquer
// requisição não-GET ou de outra origem (ex.: Supabase) vão SEMPRE à rede.
const CACHE_NAME = 'alianca-v2';
const OFFLINE_URL = '/offline.html';
const SHELL = [
  '/', '/offline.html', '/manifest.json', '/css/style.css',
  '/js/util.js', '/js/api.js', '/js/ui.js', '/js/pdv.js', '/js/estoque.js',
  '/js/vendas.js', '/js/relatorio.js', '/js/usuarios.js', '/js/app.js',
  '/js/pwa.js', '/js/offline.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/icon-maskable-192.png', '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isCode = url => url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') || url.pathname === '/manifest.json';
const isMedia = url => url.pathname.startsWith('/icons/') || /[.](png|jpe?g|svg|gif|webp|ico)$/i.test(url.pathname);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // Supabase/terceiros
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  if (req.mode === 'navigate') {                              // HTML: rede primeiro
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  if (isCode(url)) {                                          // JS/CSS: rede primeiro, cache de reserva
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  if (isMedia(url)) {                                         // ícones/imagens: stale-while-revalidate
    e.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(req);
        const net = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
  }
});
