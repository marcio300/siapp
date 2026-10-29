/* SIAPP service worker — app shell + offline ticket view (docs/BUILD_PLAN.md Phase 10).
 *
 * - Navigations: network first; the response for ticket pages, the tickets list, the home
 *   screen and the scanner is kept in the "pages" cache so a member can open their QR with no
 *   signal. Anything else offline falls back to /offline.
 * - /_next/static: cache first (immutable, hashed).
 * - Selfies and ticket images (/uploads, blob storage): stale-while-revalidate, so the door
 *   still sees faces when the venue's wifi dies.
 * - /api/* and non-GET requests are never cached (the scanner keeps its own queue).
 */
const VERSION = "siapp-v1";
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const MEDIA = `${VERSION}-media`;
const OFFLINE_URL = "/offline";
const KEEP_PAGES = [/^\/app\/tickets(\/|$)/, /^\/app$/, /^\/app\/wallet$/, /^\/scan$/, /^\/offline$/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGES).then((cache) => cache.addAll([OFFLINE_URL, "/icon.svg"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin && !/^https:\/\/[a-z0-9.-]*\.(public\.blob\.vercel-storage\.com)$/.test(url.origin)) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && KEEP_PAGES.some((re) => re.test(url.pathname))) {
            const copy = res.clone();
            caches.open(PAGES).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match(OFFLINE_URL))),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(caches.open(STATIC).then(async (cache) => (await cache.match(req)) || fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })));
    return;
  }

  if (url.pathname.startsWith("/uploads/") || url.origin !== self.location.origin || /\.(png|jpg|jpeg|webp|svg)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(MEDIA).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
        return cached || network;
      }),
    );
  }
});
