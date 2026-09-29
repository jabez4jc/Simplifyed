/**
 * Offline shell for the PWA.
 *
 * CACHE_NAME is bumped whenever the caching RULES change, not just when assets do: the activate
 * handler below deletes every cache that is not the current one, so a bump is what evicts a
 * cache written under the old rules from browsers that already have it.
 *
 * It must ALSO be bumped whenever an asset served under an UNVERSIONED url changes. The fetch
 * handler is cache-first with no expiry, so such a url is pinned forever in any browser that has
 * already fetched it. Everything under /js and /css carries a `?v=` and is therefore safe;
 * /vendor does not, so the charting build (public/vendor/openalgo-charts, written by
 * scripts/sync-vendor-charts.js) is the one that matters in practice.
 *
 * v5: pages (navigations, *.html) are network-first. Cache-first had pinned dashboard.html, so
 *   the `?v=` versioning of /js and /css never took effect in a browser that already had it.
 *
 * v2: stop caching the API.
 *
 *   The previous version intercepted every same-origin GET, answered it from the cache whenever
 *   an entry existed, and wrote every successful response back into the cache. It excluded
 *   nothing, so `/api/v1/...` was cached too - permanently, and cache-first. Two consequences,
 *   both serious:
 *
 *   1. Correctness. The dashboard's whole write flow is "save, then re-list". Once a list URL had
 *      been fetched, every later fetch of it was answered from the cache, so an edit that saved
 *      correctly never appeared - the operator saw a success toast over unchanged data and could
 *      only conclude the feature was broken. No server-side Cache-Control could override this;
 *      a service worker that calls cache.put explicitly is not bound by response headers.
 *
 *   2. Disclosure. Those responses carry account balances, open positions, order history and
 *      masked credentials, and Cache Storage is per-origin, on disk, and NOT cleared when the
 *      operator logs out. The next person to open the browser could read the previous session's
 *      account data straight out of the cache.
 *
 *   The API is now never touched by the worker: no reads from cache, no writes to it. It falls
 *   through to the network exactly as it would with no service worker installed.
 */

/**
 * v3: evict the openalgo-charts 1.x modules.
 *
 *   The chart engine moved to 2.x. Its files are served from /vendor with no version query, so
 *   every returning operator would have gone on loading the 1.x modules out of this cache
 *   underneath 2.x-shaped application code - drawings silently failing to restore, series types
 *   the old build has no renderer for. Bumping the name is what drops them.
 */
/**
 * v4: openalgo-charts 2.5.9 and the vendored OpenScript engine (/vendor/openalgo-script), both
 * under unversioned /vendor urls - same reason as v3.
 */
const CACHE_NAME = 'simplifyed-v5';

const OFFLINE_ASSETS = [
  '/',
  '/manifest.json',
  '/css/landing.css',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/** Paths the worker must never read from, or write to, its cache. */
const NEVER_CACHE = ['/api/', '/webhook/', '/auth/', '/stream'];

function isCacheable(url) {
  // Same-origin only - a cross-origin response is not ours to store.
  if (url.origin !== self.location.origin) return false;
  return !NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Let the API - and anything else carrying live account state - go straight to the network.
  // Returning without calling respondWith hands the request back to the browser untouched.
  if (!isCacheable(url)) return;

  // Pages are network-first. Cache-first pinned dashboard.html forever, and with it every
  // `?v=` it references - so no JS/CSS change ever reached a browser that had the old page
  // (seen: expired watchlist rows still enabled after the fix shipped). Offline still gets the
  // cached copy.
  const isPage = event.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/';
  if (isPage) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') return caches.match('/');
        });
    })
  );
});
