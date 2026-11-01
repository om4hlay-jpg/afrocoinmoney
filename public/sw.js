// afrocoinmoney service worker
//
// Design rules (important - this is a money app):
//   1. NEVER cache anything under /api/. Balances, transactions and tokens must
//      always come from the network or fail loudly. A stale balance is worse
//      than no balance, so API calls are network-only with an explicit offline
//      error the app can surface.
//   2. Only GET requests are cached, and only same-origin static assets.
//   3. Navigations are network-first with a cache fallback so a returning
//      visitor on a flaky connection still gets the app shell instead of the
//      browser's offline dinosaur.
//   4. Static assets are stale-while-revalidate: instant paint, quiet refresh.

const VERSION = 'v3';
const SHELL_CACHE = 'acm-shell-' + VERSION;
const ASSET_CACHE = 'acm-assets-' + VERSION;
const OFFLINE_URL = '/offline.html';

// App shell - the minimum needed to render the app without a network.
const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.json',
  '/dashboard.html',
  '/login.html',
  '/index.html',
  '/about.html',
  '/css/style.css',
  '/css/components.css',
  '/js/app.js',
  '/js/main.js',
  '/js/pages-util.js',
  '/js/pages-home.js',
  '/js/pages-bots.js',
  '/js/pages-team.js',
  '/js/pages-profile.js',
  '/js/chart.umd.min.js',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
  '/logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll fails the whole install if any single asset 404s, so add
      // individually and tolerate misses.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('acm-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// --- Helpers ----------------------------------------------------------------

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/logo.png' ||
    url.pathname === '/favicon.png' ||
    url.pathname === '/manifest.json'
  );
}

// Cache-first for static assets, refreshed in the background.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);
  return cached || network || Response.error();
}

// Network-first: fresh HTML when online, cached copy when not.
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = (await cache.match(request)) || (await cache.match('/dashboard.html'));
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('You are offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// --- Routing ----------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable. Anything else (deposits, withdrawals, logins) goes
  // straight to the network and is never intercepted.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only - never touch third-party requests.
  if (url.origin !== self.location.origin) return;

  // NEVER cache the API. Money and auth must be live or fail.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({ error: 'You are offline. Reconnect to continue.', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    return;
  }

  // Navigations.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets.
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});