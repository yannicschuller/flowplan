// Offline use on this device: the service worker keeps copies of the app,
// the workspace and pages once enabled. Copies are private data, so they are
// removed when offline use is switched off, on logout and for another user.
// While the app is open the copy follows the workspace (refreshOffline):
// only pages and records that changed are fetched again, pages that are
// gone or no longer readable are dropped together with their files.
import {
  fileRefs,
  isFileKey,
  isPageKey,
  isRowKey,
  pageRows,
  planFiles,
  planPages,
  planRecords,
} from "@/lib/offline-plan";
import type { OfflineChanges } from "@/lib/offline-changes";

const STATIC_CACHE = "flowplan-static-v1",
  DATA_CACHE = "flowplan-data-v1",
  SETTINGS_CACHE = "flowplan-settings",
  OFFLINE_MARKER = "/__flowplan-offline";
// Record documents and files never opened here: at most this much.
export const RECORD_LIMIT = 200 * 1024 * 1024;
export const PERIODIC_SYNC_TAG = "flowplan-offline";
// Requests of a refresh carry this header: the service worker passes them
// to the network (no stored copy as answer) and pages skip presence.
const OFFLINE_HEADER = "X-Flowplan-Offline";

export type OfflineMarker = {
  user: string;
  // When offline use was switched on.
  since: number;
  workspace?: string;
  // Last complete refresh (device time) and the server time to ask from.
  lastRefresh?: number;
  cursor?: string;
  pages?: number;
  bytes?: number;
  includeRecords?: boolean;
};

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
export async function offlineMarker(): Promise<OfflineMarker | null> {
  if (!offlineSupported()) return null;
  const marker = await (await caches.open(SETTINGS_CACHE)).match(OFFLINE_MARKER);
  if (!marker) return null;
  try {
    const value = (await marker.json()) as OfflineMarker;
    return value && value.user ? { ...value, user: String(value.user) } : null;
  } catch {
    return null;
  }
}
async function writeMarker(marker: OfflineMarker) {
  await (await caches.open(SETTINGS_CACHE)).put(OFFLINE_MARKER, new Response(JSON.stringify(marker)));
  window.dispatchEvent(new Event(OFFLINE_CHANGED));
}
// Fired on window after the marker changed (state line in the settings).
export const OFFLINE_CHANGED = "flowplan:offline-changed";
export async function offlineOwner(): Promise<string | null> {
  return (await offlineMarker())?.user || null;
}

// Cancels running refreshes: nothing they fetch is stored any more.
let generation = 0;
export async function disableOffline() {
  if (!offlineSupported()) return;
  generation++;
  await (await caches.open(SETTINGS_CACHE)).delete(OFFLINE_MARKER);
  await caches.delete(DATA_CACHE);
  await unregisterPeriodicSync().catch(() => undefined);
  await notifyWorker();
  window.dispatchEvent(new Event(OFFLINE_CHANGED));
}
// Drops another person's copies, e.g. after a session expired without logout.
export async function checkOfflineOwner(userId: string) {
  const owner = await offlineOwner();
  if (owner && owner !== userId) await disableOffline();
}

export async function enableOffline(
  userId: string,
  workspaceId: string,
  onProgress: (done: number, total: number) => void,
  includeRecords = false,
) {
  await registerServiceWorker();
  const previous = await offlineMarker();
  await writeMarker({
    user: userId,
    since: previous?.user === userId ? previous.since : Date.now(),
    workspace: workspaceId,
    includeRecords: previous?.user === userId ? (previous.includeRecords ?? includeRecords) : includeRecords,
  });
  await notifyWorker();
  // Scripts and styles already loaded by this page.
  const assets = [
    ...new Set(
      performance
        .getEntriesByType("resource")
        .map((e) => new URL(e.name))
        .filter((u) => u.origin === location.origin && u.pathname.startsWith("/_next/static/"))
        .map((u) => u.pathname + u.search),
    ),
  ];
  const statics = await caches.open(STATIC_CACHE);
  await Promise.all(assets.map((asset) => statics.add(asset).catch(() => undefined)));
  const result = await refreshOffline({ full: true, onProgress });
  if (result.status !== "signed-out") void registerPeriodicSync();
  return result;
}

// Record contents and files never opened: on or off for this device. Off
// removes them (opened ones come back the next time they are opened).
export async function setOfflineRecords(on: boolean) {
  const marker = await offlineMarker();
  if (!marker) return;
  await writeMarker({ ...marker, includeRecords: on });
  if (!on) {
    const data = await caches.open(DATA_CACHE);
    for (const request of await data.keys()) {
      const key = keyOf(request);
      if (isRowKey(key) || isFileKey(key)) await data.delete(request);
    }
    await writeMarker({ ...marker, includeRecords: false, bytes: await cacheBytes(data) });
  }
}

const keyOf = (request: Request) => {
  const url = new URL(request.url);
  return url.pathname + url.search;
};
async function entryBytes(response: Response | undefined) {
  if (!response) return 0;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) return length;
  return (await response.blob()).size;
}
async function cacheBytes(cache: Cache) {
  let total = 0;
  for (const request of await cache.keys()) total += await entryBytes(await cache.match(request));
  return total;
}

class SignedOut extends Error {}
// The answer only counts as JSON from a valid session: a 401 or a sign-in
// page (an expired session) must never replace the stored copy.
async function fetchJson(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { [OFFLINE_HEADER]: "1" },
  });
  if (response.status === 401) throw new SignedOut();
  if (!response.ok) return { response, text: null as string | null };
  if (!(response.headers.get("content-type") || "").includes("application/json")) throw new SignedOut();
  return { response, text: await response.text() };
}
const stored = (response: Response, text: string) =>
  new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });

// A few requests at a time keep the server responsive.
async function inQueue(urls: string[], work: (url: string) => Promise<void>) {
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) await work(url);
    }),
  );
}

export type RefreshResult = {
  status: "done" | "incomplete" | "signed-out" | "disabled" | "busy";
  fetched: number;
  dropped: number;
};
let running: Promise<RefreshResult> | null = null;
// Brings the device copy up to date. Without full only what changed since
// the last refresh is fetched (GET /api/offline/changes); full fetches every
// readable page again (first copy, "Update now").
export function refreshOffline(
  options: { full?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<RefreshResult> {
  if (!offlineSupported()) return Promise.resolve({ status: "disabled", fetched: 0, dropped: 0 });
  if (running) return running;
  const run = async () => {
    // One refresh at a time across tabs and the service worker.
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return refreshNow(options);
    return (await locks.request("flowplan-offline-refresh", { ifAvailable: true }, (lock) =>
      lock ? refreshNow(options) : ({ status: "busy", fetched: 0, dropped: 0 } as RefreshResult),
    )) as RefreshResult;
  };
  running = run().finally(() => {
    running = null;
  });
  return running;
}

async function refreshNow({
  full = false,
  onProgress,
}: {
  full?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<RefreshResult> {
  const result: RefreshResult = { status: "done", fetched: 0, dropped: 0 };
  const marker = await offlineMarker();
  if (!marker) return { ...result, status: "disabled" };
  const started = generation;
  const live = async () => started === generation && (await offlineOwner()) === marker.user;
  let done = 0,
    total = 2;
  const progress = () => onProgress?.(done, total);
  progress();
  try {
    // A valid session for the same person first.
    const workspace = marker.workspace || "";
    const boot = await fetchJson(`/api/bootstrap${workspace ? `?workspace=${workspace}` : ""}`);
    done++;
    if (!boot.text) return { ...result, status: "incomplete" };
    const bootData = JSON.parse(boot.text) as { user?: { id?: string }; workspace?: { id?: string } };
    if (bootData.user?.id !== marker.user) {
      await disableOffline();
      return { ...result, status: "disabled" };
    }
    const workspaceId = workspace || String(bootData.workspace?.id || "");
    const since = full || !marker.cursor ? "" : `&since=${encodeURIComponent(marker.cursor)}`;
    const changesAnswer = await fetchJson(`/api/offline/changes?workspace=${workspaceId}${since}`);
    done++;
    if (!changesAnswer.text) return { ...result, status: "incomplete" };
    const changes = JSON.parse(changesAnswer.text) as OfflineChanges;
    const everything = full || changes.full;
    if (!(await live())) return { ...result, status: "disabled" };
    const data = await caches.open(DATA_CACHE);
    await data.put(`/api/bootstrap?workspace=${workspaceId}`, stored(boot.response, boot.text));
    if (!workspace) await data.put("/api/bootstrap", stored(boot.response, boot.text));
    let incomplete = false;
    const drop = async (key: string) => {
      if (await data.delete(key)) result.dropped++;
    };
    // 1. Pages: new and changed ones, drop the ones gone.
    let keys = (await data.keys()).map(keyOf);
    const pages = planPages({ keys, readable: changes.pages, changed: changes.changed, full: everything });
    for (const key of pages.drop) await drop(key);
    total += pages.fetch.length;
    progress();
    const fetchInto = async (url: string) => {
      try {
        const answer = await fetchJson(url);
        if (answer.text !== null) {
          if (await live()) await data.put(url, stored(answer.response, answer.text));
          result.fetched++;
        } else if ([403, 404, 410, 423].includes(answer.response.status)) await drop(url);
        else incomplete = true;
      } catch (error) {
        if (error instanceof SignedOut) throw error;
        incomplete = true;
      }
      done++;
      progress();
    };
    await inQueue(pages.fetch, fetchInto);
    if (!(await live())) return { ...result, status: "disabled" };
    // The app itself carries the page tree: stored again when pages changed,
    // with the scripts it needs. The sign-in page is never stored.
    if (everything || pages.fetch.length || pages.drop.length) {
      total++;
      try {
        const response = await fetch("/", { cache: "no-store", credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } });
        const html = response.ok ? await response.text() : "";
        if (html.includes('data-signed-out=""')) throw new SignedOut();
        if (html && (await live())) {
          const statics = await caches.open(STATIC_CACHE);
          const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
          for (const asset of assets) if (!(await statics.match(asset))) await statics.add(asset).catch(() => undefined);
          await data.put("/", stored(response, html));
        } else if (!html) incomplete = true;
      } catch (error) {
        if (error instanceof SignedOut) throw error;
        incomplete = true;
      }
      done++;
      progress();
    }

    // 2. Record documents of the stored databases.
    keys = (await data.keys()).map(keyOf);
    const rows: Record<string, string[]> = {};
    for (const key of keys.filter(isPageKey)) {
      const id = key.slice("/api/pages/".length);
      try {
        rows[id] = pageRows(await (await data.match(key))?.json());
      } catch {}
    }
    const includeRecords = !!marker.includeRecords;
    const records = planRecords({ keys, rows, changedRows: changes.rows, full: everything, includeRecords });
    for (const key of records.drop) await drop(key);
    const sizes = new Map<string, number>();
    let extraBytes = 0;
    if (includeRecords)
      for (const key of keys.filter((k) => isRowKey(k) || isFileKey(k))) {
        const size = await entryBytes(await data.match(key));
        sizes.set(key, size);
        extraBytes += size;
      }
    total += records.refresh.length;
    progress();
    await inQueue(records.refresh, fetchInto);
    // Records never opened, within the limit.
    const fits = async (size: number) => {
      if (extraBytes + size > RECORD_LIMIT) return false;
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      return !estimate?.quota || estimate.quota - (estimate.usage || 0) > size + 20 * 1024 * 1024;
    };
    if (includeRecords && records.add.length) {
      total += records.add.length;
      progress();
      await inQueue(records.add, async (url) => {
        if (extraBytes < RECORD_LIMIT) {
          const before = result.fetched;
          await fetchInto(url);
          if (result.fetched > before) extraBytes += await entryBytes(await data.match(url));
        } else {
          done++;
          progress();
        }
      });
    }

    // 3. Files: drop the ones no stored page refers to, add the others.
    keys = (await data.keys()).map(keyOf);
    const referenced = new Set<string>();
    for (const key of keys) {
      if (!key.startsWith("/api/pages/") && !key.startsWith("/api/bootstrap")) continue;
      try {
        for (const ref of fileRefs((await (await data.match(key))?.text()) || "")) referenced.add(ref);
      } catch {}
    }
    const files = planFiles({ keys, referenced: [...referenced], includeRecords });
    for (const key of files.drop) {
      extraBytes -= sizes.get(key) || 0;
      await drop(key);
    }
    if (files.add.length) {
      total += files.add.length;
      progress();
      await inQueue(files.add, async (url) => {
        try {
          if (extraBytes < RECORD_LIMIT) {
            const response = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } });
            if (response.status === 401) throw new SignedOut();
            const length = Number(response.headers.get("content-length")) || 0;
            if (!response.ok || !(await fits(length))) await response.body?.cancel();
            else {
              const blob = await response.blob();
              if ((await fits(blob.size)) && (await live())) {
                await data.put(url, new Response(blob, { status: response.status, headers: response.headers }));
                extraBytes += blob.size;
                result.fetched++;
              }
            }
          }
        } catch (error) {
          if (error instanceof SignedOut) throw error;
          incomplete = true;
        }
        done++;
        progress();
      });
    }
    if (!(await live())) return { ...result, status: "disabled" };
    const pageCount = (await data.keys()).map(keyOf).filter(isPageKey).length;
    const current = (await offlineMarker()) || marker;
    await writeMarker({
      ...current,
      workspace: workspaceId,
      pages: pageCount,
      bytes: await cacheBytes(data),
      // An incomplete run keeps the old position, so nothing is skipped.
      ...(incomplete ? {} : { lastRefresh: Date.now(), cursor: changes.now }),
    });
    return { ...result, status: incomplete ? "incomplete" : "done" };
  } catch (error) {
    if (error instanceof SignedOut) return { ...result, status: "signed-out" };
    if (error instanceof TypeError) return { ...result, status: "incomplete" };
    throw error;
  } finally {
    // Switched off meanwhile: nothing fetched may stay behind.
    if (started !== generation || !(await offlineMarker())) await caches.delete(DATA_CACHE).catch(() => undefined);
  }
}

// Periodic Background Sync (installed apps in Chromium browsers): the
// service worker refreshes the copy now and then while the app is closed.
type PeriodicSyncRegistration = ServiceWorkerRegistration & {
  periodicSync?: {
    register(tag: string, options: { minInterval: number }): Promise<void>;
    unregister(tag: string): Promise<void>;
  };
};
export async function registerPeriodicSync() {
  try {
    const registration = (await navigator.serviceWorker.ready) as PeriodicSyncRegistration;
    if (!registration.periodicSync) return false;
    const status = await navigator.permissions.query({ name: "periodic-background-sync" as PermissionName });
    if (status.state !== "granted") return false;
    await registration.periodicSync.register(PERIODIC_SYNC_TAG, { minInterval: 6 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}
async function unregisterPeriodicSync() {
  const registration = (await navigator.serviceWorker.getRegistration()) as PeriodicSyncRegistration | undefined;
  await registration?.periodicSync?.unregister(PERIODIC_SYNC_TAG);
}
