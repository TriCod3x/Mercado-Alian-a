'use strict';
// Registro do service worker (compartilhado por todas as páginas HTML).
(function () {
  try {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(function () {});
    });
  } catch (e) { /* PWA é opcional */ }
})();
