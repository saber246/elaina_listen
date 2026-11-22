const scope = new URL("./", self.location.href);
const cachePrefix = "elaina-mobile:" + scope.pathname + ":";
const cacheName = cachePrefix + "1";
const shell = new URL("./index.html", scope).href;
const resources = new Set([
  "./index.html", "./app.js", "./library.js", "./style.css", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "../extension/speech.js", "../extension/timeline.js",
].map((path) => new URL(path, scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) =>
    cache.addAll([...resources].map((url) => new Request(url, { cache: "reload" }))),
  ));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  const url = new URL(event.request.url);
  const isStartPage = event.request.mode === "navigate" && url.origin === scope.origin
    && (url.pathname === scope.pathname || url.pathname === new URL(shell).pathname);
  const key = isStartPage ? shell : url.href;
  if (resources.has(key)) {
    event.respondWith(caches.open(cacheName).then(async (cache) =>
      await cache.match(key) ?? fetch(event.request),
    ));
  }
});