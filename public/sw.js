/* Flowplan Web Push: no authenticated responses are cached. */
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
  event.waitUntil(self.clients.claim()),
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
