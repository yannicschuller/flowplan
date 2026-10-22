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
  // Refreshes of the copy (components/offline.ts) store answers themselves.
  if (request.headers.get("x-flowplan-offline") === "1") return null;
  if (request.mode === "navigate") return url.pathname === "/" ? "data" : null;
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/fonts.css" ||
    url.pathname.startsWith("/fonts/")
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
// The sign-in page (session expired) must not replace the stored app.
const SIGNED_OUT = "data-signed-out=\"\"";
async function signedOut(request, response) {
  if (request.mode !== "navigate") return false;
  return (await response.clone().text()).includes(SIGNED_OUT);
}
// Network first; the stored copy is used only when the network fails.
async function networkFirst(request, cacheName, key) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic" && !(await signedOut(request, response))) {
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

/* Periodic Background Sync (installed apps in Chromium browsers): the same
   refresh as components/offline.ts while no window is open, through the
   same endpoints. Only changed pages and records are fetched again; pages
   gone or no longer readable are dropped with their records and files.
   Records never opened are added only while the app is open. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_KEY = new RegExp(`^/api/pages/(${UUID})(?:[/?]|$)`, "i");
const PAGE_EXACT = new RegExp(`^/api/pages/(${UUID})$`, "i");
const ROW_KEY = new RegExp(`^/api/pages/(${UUID})/rows/(${UUID})(?:[/?]|$)`, "i");
const ROW_EXACT = new RegExp(`^/api/pages/(${UUID})/rows/(${UUID})$`, "i");
const FILE_KEY = new RegExp(`^/api/files/(${UUID})(?:[/?]|$)`, "i");
const FILE_REF = new RegExp(`/api/files/(${UUID})`, "gi");
// Mirrors lib/offline-plan.ts (tests/offline-plan.test.ts compares them).
const offlinePlan = {
  fileRefs(text) {
    return [...new Set([...text.matchAll(FILE_REF)].map((m) => m[1].toLowerCase()))];
  },
  planPages({ keys, readable, changed, full }) {
    const allowed = new Set(readable.map((id) => id.toLowerCase()));
    const touched = new Set(changed.map((id) => id.toLowerCase()));
    const stored = new Set();
    const drop = [];
    for (const key of keys) {
      const page = PAGE_KEY.exec(key)?.[1]?.toLowerCase();
      if (!page) continue;
      if (!allowed.has(page)) drop.push(key);
      else if (PAGE_EXACT.test(key)) stored.add(page);
    }
    const fetch = readable
      .filter((id) => full || !stored.has(id.toLowerCase()) || touched.has(id.toLowerCase()))
      .map((id) => `/api/pages/${id}`);
    return { fetch, drop };
  },
  planRecords({ keys, rows, changedRows, full, includeRecords }) {
    const drop = [];
    const stored = new Set();
    for (const key of keys) {
      const match = ROW_KEY.exec(key);
      if (!match) continue;
      const [page, row] = [match[1].toLowerCase(), match[2].toLowerCase()];
      const visible = rows[page];
      if (!visible) continue;
      if (!visible.some((id) => id.toLowerCase() === row)) drop.push(key);
      else if (ROW_EXACT.test(key)) stored.add(`${page}/${row}`);
    }
    const refresh = [];
    const add = [];
    for (const [page, list] of Object.entries(rows)) {
      const changed = new Set((changedRows[page] || []).map((id) => id.toLowerCase()));
      for (const row of list) {
        const has = stored.has(`${page.toLowerCase()}/${row.toLowerCase()}`);
        if (has && (full || changed.has(row.toLowerCase()))) refresh.push(`/api/pages/${page}/rows/${row}`);
        else if (!has && includeRecords) add.push(`/api/pages/${page}/rows/${row}`);
      }
    }
    return { refresh, add, drop };
  },
  planFiles({ keys, referenced, includeRecords }) {
    const wanted = new Set(referenced.map((id) => id.toLowerCase()));
    const stored = new Set();
    const drop = [];
    for (const key of keys) {
      const file = FILE_KEY.exec(key)?.[1]?.toLowerCase();
      if (!file) continue;
      if (!wanted.has(file)) drop.push(key);
      else stored.add(file);
    }
    const add = includeRecords ? [...wanted].filter((id) => !stored.has(id)).map((id) => `/api/files/${id}`) : [];
    return { add, drop };
  },
};
async function offlineMarker() {
  const marker = await (await caches.open(SETTINGS_CACHE)).match(OFFLINE_MARKER);
  try {
    return marker ? await marker.json() : null;
  } catch {
    return null;
  }
}
const cacheKey = (request) => {
  const url = new URL(request.url);
  return url.pathname + url.search;
};
// JSON from a valid session only: a 401 or a sign-in page ends the run.
async function offlineJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { "x-flowplan-offline": "1" } });
  if (response.status === 401) throw new Error("signed-out");
  if (!response.ok) return { response, text: null };
  if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error("signed-out");
  return { response, text: await response.text() };
}
async function backgroundRefresh() {
  const marker = await offlineMarker();
  if (!marker?.user || !marker.workspace) return;
  const owner = async () => (await offlineMarker())?.user === marker.user;
  const boot = await offlineJson(`/api/bootstrap?workspace=${marker.workspace}`);
  if (!boot.text || JSON.parse(boot.text).user?.id !== marker.user) return;
  const since = marker.cursor ? `&since=${encodeURIComponent(marker.cursor)}` : "";
  const answer = await offlineJson(`/api/offline/changes?workspace=${marker.workspace}${since}`);
  if (!answer.text) return;
  const changes = JSON.parse(answer.text);
  const data = await caches.open(DATA_CACHE);
  if (!(await owner())) return;
  await data.put(`/api/bootstrap?workspace=${marker.workspace}`, new Response(boot.text, { headers: boot.response.headers }));
  let incomplete = false;
  const fetchInto = async (url) => {
    try {
      const result = await offlineJson(url);
      if (result.text !== null) {
        if (await owner()) await data.put(url, new Response(result.text, { headers: result.response.headers }));
      } else if ([403, 404, 410, 423].includes(result.response.status)) await data.delete(url);
      else incomplete = true;
    } catch (error) {
      if (error.message === "signed-out") throw error;
      incomplete = true;
    }
  };
  const queue = async (urls) => {
    const list = [...urls];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let url = list.shift(); url; url = list.shift()) await fetchInto(url);
    }));
  };
  let keys = (await data.keys()).map(cacheKey);
  const pages = offlinePlan.planPages({ keys, readable: changes.pages, changed: changes.changed, full: changes.full });
  for (const key of pages.drop) await data.delete(key);
  await queue(pages.fetch);
  // The app itself carries the page tree.
  if (pages.fetch.length || pages.drop.length) {
    const response = await fetch("/", { cache: "no-store", credentials: "same-origin", headers: { "x-flowplan-offline": "1" } }).catch(() => null);
    const html = response?.ok ? await response.text() : "";
    if (html.includes(SIGNED_OUT)) throw new Error("signed-out");
    if (html && (await owner())) {
      // With the scripts and styles it needs (a new version of the app).
      const statics = await caches.open(STATIC_CACHE);
      const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
      for (const asset of assets) if (!(await statics.match(asset))) await statics.add(asset).catch(() => undefined);
      await data.put("/", new Response(html, { headers: response.headers }));
    }
  }
  keys = (await data.keys()).map(cacheKey);
  const rows = {};
  for (const key of keys.filter((k) => PAGE_EXACT.test(k))) {
    try {
      const value = await (await data.match(key)).json();
      rows[key.slice("/api/pages/".length)] = Array.isArray(value?.rows) ? value.rows.map((r) => String(r?.id || "")).filter(Boolean) : [];
    } catch {}
  }
  const records = offlinePlan.planRecords({ keys, rows, changedRows: changes.rows, full: changes.full, includeRecords: false });
  for (const key of records.drop) await data.delete(key);
  await queue(records.refresh);
  keys = (await data.keys()).map(cacheKey);
  const referenced = new Set();
  for (const key of keys) {
    if (!key.startsWith("/api/pages/") && !key.startsWith("/api/bootstrap")) continue;
    for (const ref of offlinePlan.fileRefs((await (await data.match(key))?.text()) || "")) referenced.add(ref);
  }
  for (const key of offlinePlan.planFiles({ keys, referenced: [...referenced], includeRecords: false }).drop) await data.delete(key);
  const current = await offlineMarker();
  if (current?.user !== marker.user) {
    await caches.delete(DATA_CACHE);
    return;
  }
  let bytes = 0;
  for (const request of await data.keys()) {
    const response = await data.match(request);
    bytes += Number(response.headers.get("content-length")) || (await response.blob()).size;
  }
  const next = {
    ...current,
    pages: (await data.keys()).map(cacheKey).filter((k) => PAGE_EXACT.test(k)).length,
    bytes,
    ...(incomplete ? {} : { lastRefresh: Date.now(), cursor: changes.now }),
  };
  await (await caches.open(SETTINGS_CACHE)).put(OFFLINE_MARKER, new Response(JSON.stringify(next)));
}
self.addEventListener("periodicsync", (event) => {
  if (event.tag !== "flowplan-offline") return;
  event.waitUntil(
    (async () => {
      // An open window refreshes itself (records and files included).
      const windows = await self.clients.matchAll({ type: "window" });
      const visible = windows.filter((client) => client.visibilityState === "visible");
      if (visible.length) {
        visible[0].postMessage({ type: "flowplan-offline-refresh" });
        return;
      }
      const run = () => backgroundRefresh().catch(() => undefined);
      if (self.navigator.locks)
        await self.navigator.locks.request("flowplan-offline-refresh", { ifAvailable: true }, (lock) => (lock ? run() : undefined));
      else await run();
    })(),
  );
});
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
