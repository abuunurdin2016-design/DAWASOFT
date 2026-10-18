/**
 * service-worker.js — app-shell caching + background sync trigger.
 * Enables the app to load and run (sales entry etc.) with no network.
 */
const CACHE = 'pharmacy-shell-v2';
const SHELL = [
  'index.html', 'home.html', 'sales.html', 'assistant.html', 'inventory.html',
  'alerts.html', 'reports.html', 'settings.html', 'users.html', 'sales-management.html',
  'manifest.webmanifest', 'icons/icon.svg',
  'css/base.css', 'css/themes.css', 'css/layout.css', 'css/components.css',
  'js/config.js', 'js/icons.js', 'js/format.js', 'js/db.js', 'js/api.js', 'js/auth.js',
  'js/permissions.js', 'js/sync.js', 'js/ui.js', 'js/charts.js', 'js/app.js',
  'js/pages/login.js', 'js/pages/home.js', 'js/pages/sales.js', 'js/pages/assistant.js',
  'js/pages/inventory.js', 'js/pages/alerts.js', 'js/pages/reports.js', 'js/pages/settings.js',
  'js/pages/users.js', 'js/pages/sales-management.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never cache the API (POST) or cross-origin traffic.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('home.html')))
    );
    return;
  }

  // Static assets: cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Background Sync: wake the page so its outbox can flush.
self.addEventListener('sync', (event) => {
  if (event.tag === 'ph-sync') {
    event.waitUntil(self.clients.matchAll().then((clients) => {
      clients.forEach((c) => c.postMessage({ type: 'ph-flush' }));
    }));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
