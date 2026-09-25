// Offline use on this device: the service worker keeps copies of the app,
// the workspace and pages once enabled. Copies are private data, so they are
// removed when offline use is switched off, on logout and for another user.
const STATIC_CACHE = "flowplan-static-v1",
  DATA_CACHE = "flowplan-data-v1",
  SETTINGS_CACHE = "flowplan-settings",
  OFFLINE_MARKER = "/__flowplan-offline";
export const offlineSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "caches" in window;

export async function registerServiceWorker() {
  if (!offlineSupported()) return null;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}
async function notifyWorker() {
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage({ type: "flowplan-offline" });
  navigator.serviceWorker.controller?.postMessage({ type: "flowplan-offline" });
}
export async function offlineOwner(): Promise<string | null> {
  if (!offlineSupported()) return null;
  const marker = await (
    await caches.open(SETTINGS_CACHE)
  ).match(OFFLINE_MARKER);
  if (!marker) return null;
  try {
    return String((await marker.json()).user || "") || null;
  } catch {
    return null;
  }
}
export async function disableOffline() {
  if (!offlineSupported()) return;
  await (await caches.open(SETTINGS_CACHE)).delete(OFFLINE_MARKER);
  await caches.delete(DATA_CACHE);
  await notifyWorker();
}
// Drops another person's copies, e.g. after a session expired without logout.
export async function checkOfflineOwner(userId: string) {
  const owner = await offlineOwner();
  if (owner && owner !== userId) await disableOffline();
}
export async function enableOffline(
  userId: string,
  workspaceId: string,
  pageIds: string[],
  onProgress: (done: number, total: number) => void,
) {
  await registerServiceWorker();
  await (
    await caches.open(SETTINGS_CACHE)
  ).put(
    OFFLINE_MARKER,
    new Response(JSON.stringify({ user: userId, since: Date.now() })),
  );
  await notifyWorker();
  // Scripts and styles already loaded by this page.
  const assets = [
    ...new Set(
      performance
        .getEntriesByType("resource")
        .map((e) => new URL(e.name))
        .filter(
          (u) =>
            u.origin === location.origin &&
            u.pathname.startsWith("/_next/static/"),
        )
        .map((u) => u.pathname + u.search),
    ),
  ];
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(
    assets.map((asset) => statics.add(asset).catch(() => undefined)),
  );
  const data = await caches.open(DATA_CACHE);
  const urls = [
    "/",
    `/api/bootstrap?workspace=${workspaceId}`,
    ...pageIds.map((id) => `/api/pages/${id}`),
  ];
  let done = 0;
  onProgress(done, urls.length);
  // A few requests at a time keep the server responsive.
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          const response = await fetch(url, {
            cache: "no-store",
            credentials: "same-origin",
          });
          if (response.ok) await data.put(url, response);
        } catch {}
        onProgress(++done, urls.length);
      }
    }),
  );
}
