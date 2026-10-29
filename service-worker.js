/**
 * JSR Finance - Progressive Web App Service Worker
 * Enables 100% Offline Application Loading & Instant Village Launch (0.1s)
 */

const CACHE_NAME = 'jsr-finance-pwa-v1.1.2';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=67',
  './app.js?v=67',
  './firebase-config.js?v=67',
  './firebase-sync.js?v=67',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './login-hero.jpg'
];

// External CDN dependencies to cache for full offline capability
const EXTERNAL_LIBRARIES = [
  'https://accounts.google.com/gsi/client',
  'https://unpkg.com/lucide@latest',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore-compat.js'
];

// 1. Install Event: Cache app shell & offline assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching local app shell & CDN assets');
      // Cache local assets
      const localPromises = cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[ServiceWorker] Some local assets failed to pre-cache:', err);
      });
      // Cache external libraries gracefully
      const extPromises = Promise.all(
        EXTERNAL_LIBRARIES.map((url) =>
          fetch(url, { mode: 'cors' })
            .then((res) => {
              if (res.ok) return cache.put(url, res);
            })
            .catch((e) => console.warn('[ServiceWorker] CDN cache skip:', url, e))
        )
      );
      return Promise.all([localPromises, extPromises]);
    })
  );
});

// 2. Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[ServiceWorker] Deleting old cache version:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Cache-First strategy with Stale-While-Revalidate for app assets
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never intercept or cache Firestore live websockets / googleapis live channels
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('accounts.google.com')
  ) {
    return; // Pass through directly to network
  }

  // Non-GET requests pass directly to network
  if (request.method !== 'GET') {
    return;
  }

  // Handle app shell, scripts, styles, images, and fonts
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch fresh copy in background to update cache (stale-while-revalidate)
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse);
              });
            }
          })
          .catch(() => {}); // Ignore network errors when offline in villages

        return cachedResponse;
      }

      // Not in cache: fetch from network and store in cache
      return fetch(request)
        .then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return networkResponse;
        })
        .catch(() => {
          // If offline and request is for an HTML page, serve index.html from cache
          if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
            return caches.match('./index.html');
          }
        });
    })
  );
});

// 4. Message Event: Allow skip waiting trigger from UI
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
