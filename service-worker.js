// Static assets (CSS, JS, icons, manifest) are cache-first for speed —
// repeat page navigations reuse them instantly instead of re-fetching.
// Everything else (HTML pages, Supabase/serverless function calls) stays
// network-only, so homework data, progress counts, and submissions are
// always live and never served stale from a cache.

const CACHE_NAME = 'homework-app-static-v2';
const STATIC_PATTERNS = [/\/css\//, /\/js\//, /\/icons\//, /\/manifest\.json$/, /\/nav\.js$/];

function isStaticAsset(url) {
  return STATIC_PATTERNS.some(p => p.test(url.pathname));
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !isStaticAsset(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    const networkFetch = fetch(event.request).then((response) => {
      if (response && response.ok) cache.put(event.request, response.clone());
      return response;
    }).catch(() => null);

    // Stale-while-revalidate: serve the cached copy instantly if we have
    // one (fast repeat loads), while quietly refreshing it in the
    // background so the next load picks up any change.
    return cached || (await networkFetch) || fetch(event.request);
  })());
});
