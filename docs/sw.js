const CACHE = "alpha-swing-v11";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll([
          "./",
          "./index.html",
          "./manifest.webmanifest",
          "./strategist.js",
          "./auth.js",
          "./data/strategist-plan.json",
          "./data/market-intelligence.json",
          "./data/scanner-results.json",
        ]),
      ),
  );
});
self.addEventListener("activate", (e) =>
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
          ),
        ),
    ]),
  ),
);
self.addEventListener("fetch", (e) =>
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request)),
  ),
);
