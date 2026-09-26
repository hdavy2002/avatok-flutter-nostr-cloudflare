/* Saa Thum service worker — [DASH2-PWA 2026-09-25]
 *
 * Registered ONLY from Dashboard 2 pages (islands/dashboard2/InstallPrompt.tsx),
 * scope "/". Deliberately small and conservative:
 *
 *  - Static assets (same-origin /_astro/*, /fonts/*, /_images/*, /icons/*, images,
 *    plus Google Fonts) are cached as they are fetched, stale-while-revalidate.
 *  - Navigations always go to the network (HTML is private, no-store, and names
 *    hashed assets that change every deploy). If the network is down, the
 *    precached /offline.html is shown instead.
 *  - NEVER cached: /api/*, api.avatok.ai, any request carrying an Authorization
 *    header, /sign-in, /sign-out, /pay, /book, YouTube, and anything non-GET.
 *    Those requests are not intercepted at all (the browser handles them).
 *
 * Bump VERSION to drop every old cache on the next activate.
 *
 * [DASH2-PUSH 2026-09-26] Web push: the worker (lib/web_push.ts) sends an encrypted
 * JSON {title, body, url, tag}; `push` shows it, `notificationclick` focuses an open
 * dashboard tab (navigating it to the url) or opens a new one.
 */
const VERSION = 'saathum-sw-v2'; // v2: [DASH2-PUSH] push + notificationclick
const STATIC_CACHE = `${VERSION}-static`;
const SHELL_CACHE = `${VERSION}-shell`;
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/icons/icon-192.png', '/diya-logo.png'];
const MAX_STATIC_ENTRIES = 160;

const NEVER_HOSTS = [
  'api.avatok.ai',
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'ytimg.com', 'i.ytimg.com', 'googlevideo.com',
];
const NEVER_PATHS = [/^\/api(\/|$)/, /^\/sign-in(\/|$)/, /^\/sign-out(\/|$)/, /^\/sign-up(\/|$)/, /^\/pay(\/|$)/, /^\/book(\/|$)/];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const IMAGE_EXT = /\.(?:png|jpe?g|webp|avif|gif|svg|ico)$/i;

function hostMatches(host, list) {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function neverCache(req, url) {
  if (req.method !== 'GET') return true;
  if (req.headers.has('authorization')) return true;
  if (hostMatches(url.hostname, NEVER_HOSTS)) return true;
  if (url.origin === self.location.origin && NEVER_PATHS.some((re) => re.test(url.pathname))) return true;
  return false;
}

function isStaticAsset(url) {
  if (url.origin === self.location.origin) {
    const p = url.pathname;
    return p.startsWith('/_astro/') || p.startsWith('/fonts/') || p.startsWith('/_images/') || p.startsWith('/icons/') || IMAGE_EXT.test(p);
  }
  return FONT_HOSTS.includes(url.hostname);
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, SHELL_CACHE]);
    for (const key of await caches.keys()) {
      if (key.startsWith('saathum-sw-') && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    // Opaque cross-origin font responses are fine to keep; errors are not.
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      event.waitUntil(cache.put(req, copy).then(() => trim(STATIC_CACHE, MAX_STATIC_ENTRIES)));
    }
    return res;
  });
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network;
}

async function networkWithOfflineFallback(event) {
  try {
    return await fetch(event.request);
  } catch (err) {
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (neverCache(req, url)) return; // let the browser handle it, untouched

  if (req.mode === 'navigate') {
    if (url.origin !== self.location.origin) return;
    event.respondWith(networkWithOfflineFallback(event));
    return;
  }
  if (isStaticAsset(url)) event.respondWith(staleWhileRevalidate(event, req));
});

// ── [DASH2-PUSH] Web push ────────────────────────────────────────────────
const PUSH_ICON = '/icons/icon-192.png';
const PUSH_BADGE = '/icons/icon-192.png';

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {
    try { data = { body: event.data ? event.data.text() : '' }; } catch { data = {}; }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Saa Thum';
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/dashboard/my-events';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: PUSH_ICON,
    badge: PUSH_BADGE,
    tag: typeof data.tag === 'string' && data.tag ? data.tag : undefined,
    renotify: !!data.tag,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/dashboard/my-events';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const dash = wins.find((c) => { try { return new URL(c.url).pathname.startsWith('/dashboard'); } catch { return false; } });
    if (dash) {
      await dash.focus();
      if (dash.url !== target && 'navigate' in dash) { try { await dash.navigate(target); } catch { /* cross-scope */ } }
      return;
    }
    await self.clients.openWindow(target);
  })());
});
