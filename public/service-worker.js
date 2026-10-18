const CACHE_NAME = "klai-offline-v1";
const SHELL = [
  "/",
  "/host.html",
  "/controller.html",
  "/emulator.html",
  "/css/host.css",
  "/css/controller.css",
  "/js/host.js",
  "/js/controller.js",
  "/js/emulator.js",
  "/js/emulator-controls.js",
  "/socket.io/socket.io.js",
  "/service-worker.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("klai-offline-") && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname === "/api/games" || url.pathname.startsWith("/emulator-data/") || /^\/api\/games\/[a-f0-9-]+\/download$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch {
        return await cache.match(request) || Response.error();
      }
    })());
    return;
  }

  if (request.mode === "navigate" || SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request) || await cache.match(url.pathname);
      if (cached) return cached;
      return fetch(request);
    })());
  }
});