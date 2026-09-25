/* Flowplan service worker: Web Push and, only after opting in on this
   device, offline copies of the app shell, workspace and page data. */
const STATIC_CACHE = "flowplan-static-v1",
  DATA_CACHE = "flowplan-data-v1",
  SETTINGS_CACHE = "flowplan-settings",
  OFFLINE_MARKER = "/__flowplan-offline";
let offlineEnabled;
async function offlineReady() {
  if (offlineEnabled === undefined)
    offlineEnabled = !!(await (await caches.open(SETTINGS_CACHE)).match(
      OFFLINE_MARKER,
    ));
  return offlineEnabled;
}
// Pages post this after switching offline use on or off.
self.addEventListener("message", (event) => {
  if (event.data?.type === "flowplan-offline") offlineEnabled = undefined;
});
function offlineKind(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin)
    return null;
  if (request.mode === "navigate") return url.pathname === "/" ? "data" : null;
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/fonts.css" ||
    url.pathname === "/manifest.webmanifest"
  )
    return "static";
  if (
    url.pathname === "/api/bootstrap" ||
    url.pathname.startsWith("/api/pages/") ||
    url.pathname.startsWith("/api/files/")
  )
    return "data";
  return null;
}
// Network first; the stored copy is used only when the network fails.
async function networkFirst(request, cacheName, key) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(cacheName);
      await cache.put(key, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await (await caches.open(cacheName)).match(key);
    if (cached) return cached;
    throw error;
  }
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const kind = offlineKind(event.request, url);
  if (!kind || offlineEnabled === false) return;
  event.respondWith(
    (async () => {
      if (!(await offlineReady())) return fetch(event.request);
      return networkFirst(
        event.request,
        kind === "static" ? STATIC_CACHE : DATA_CACHE,
        event.request.mode === "navigate" ? "/" : url.pathname + url.search,
      );
    })(),
  );
});
function notificationTarget(value) {
  if (typeof value !== "string" || !value.startsWith("/#")) return "/#inbox";
  if (value === "/#inbox") return value;
  const params = new URLSearchParams(value.slice(2));
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    ![...params.keys()].every((key) =>
      ["page", "row", "thread"].includes(key),
    ) ||
    !uuid.test(params.get("page") || "") ||
    ["page", "row", "thread"].some(
      (key) =>
        params.getAll(key).length > 1 ||
        (params.has(key) && !uuid.test(params.get(key))),
    )
  )
    return "/#inbox";
  return `/#${params}`;
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await offlineReady();
    })(),
  ),
);
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification("Flowplan", {
      body:
        typeof payload.body === "string"
          ? payload.body.slice(0, 300)
          : "Eine neue Benachrichtigung wartet im Posteingang.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: typeof payload.tag === "string" ? payload.tag : "flowplan-inbox",
      data: { url: notificationTarget(payload.url) },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL(
        notificationTarget(event.notification.data?.url),
        self.location.origin,
      ).href;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.navigate(url);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
