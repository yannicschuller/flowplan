// Offline use on this device: copies of the app, the workspace and pages
// once enabled – in the browser's Cache Storage, served by the service
// worker, or in the iPhone and iPad app's own storage (lib/offline-store.ts),
// served by the app and lib/offline-app.ts. Copies are private data, so they are
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
  planStudy,
  isStudyKey,
} from "@/lib/offline-plan";
import type { OfflineChanges } from "@/lib/offline-changes";
import {
  LEGACY_STATIC_CACHE,
  fitsQuota,
  isStaticCache,
  missingAssets,
  staleStaticCaches,
  staticCacheName,
  withoutDeployment,
  type OfflineAssets,
} from "@/lib/offline-assets";
import { installAppOffline } from "@/lib/offline-app";
import { DATA_CACHE, OFFLINE_CHANGED, OFFLINE_MARKER, SETTINGS_CACHE, appOfflineBridge, isStorageRefusal, offlineStore, type OfflineCache, type OfflineStore } from "@/lib/offline-store";
import {
  keptPageIds,
  offlineBudget,
  planRelease,
  planRoom,
  planTrim,
  rowPage,
  toggleKeep,
  usageBySpace,
  type BudgetEntry,
  type KeepItem,
  type OfflinePlatform,
  type SpaceUsage,
  type TreePage,
} from "@/lib/offline-keep";
import { desktopApp, inDesktopApp } from "@/lib/native-app";
import { isPendingFile, isPendingPage } from "@/lib/offline-pending";
import { queueKey } from "@/lib/offline-queue";
import { isDrawioCache } from "@/lib/drawio-offline";

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
  // The app's own files (#47): build and version of the stored copy, how
  // many of its files are stored, and whether "/" (the app's page) belongs
  // to that build. "space": the device has no room for them.
  app?: OfflineApp;
  // #417 (lib/offline-keep.ts): the budget chosen on this device for
  // record contents and files (bytes; the platform's default otherwise),
  // the items kept offline and those switched off since the last refresh,
  // the bytes counted against the budget and the storage per space.
  budget?: number;
  keep?: KeepItem[];
  released?: KeepItem[];
  budgetUsed?: number;
  spaces?: Record<string, SpaceUsage>;
  // The budget was lowered: the next refresh frees what is over it.
  trim?: boolean;
};
export type OfflineApp = {
  build: string;
  version: string;
  stored: number;
  total: number;
  bytes: number;
  complete: boolean;
  shell?: boolean;
  space?: boolean;
};

// In the iPhone and iPad app the page answers from the app's copy itself.
installAppOffline();

const browserSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "caches" in window;
export const offlineSupported = () => !!appOfflineBridge() || browserSupported();
// Which default budget applies (lib/offline-keep.ts): the iPhone and iPad
// app, the desktop app, or a browser (the installed web app included).
export function offlinePlatform(): OfflinePlatform {
  if (appOfflineBridge()) return "app";
  return inDesktopApp() || !!desktopApp() ? "desktop" : "browser";
}
export const budgetOf = (marker: Pick<OfflineMarker, "budget"> | null | undefined) => offlineBudget(marker?.budget, offlinePlatform());

// Persistent storage (#417): asked for when offline use is switched on and
// on every start while it is on, so the browser does not clear the copy
// when the disk runs low. The iPhone and iPad app keeps the copy in its own
// storage, which iOS does not clear. "unknown": the browser cannot say.
export type OfflinePersistence = "persisted" | "best-effort" | "unknown";
export async function persistOffline({ ask = true }: { ask?: boolean } = {}): Promise<OfflinePersistence> {
  if (appOfflineBridge()) return "persisted";
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persisted) return "unknown";
  try {
    if (await storage.persisted()) return "persisted";
    if (!ask || !storage.persist) return "best-effort";
    return (await storage.persist()) ? "persisted" : "best-effort";
  } catch {
    return "unknown";
  }
}
// The copy's storage; supported() first.
const store = () => offlineStore() as OfflineStore;

export async function registerServiceWorker() {
  // The app serves its copy itself (and its web view has no service worker).
  if (appOfflineBridge() || !browserSupported()) return null;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}
async function notifyWorker() {
  if (!browserSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.active?.postMessage({ type: "flowplan-offline" });
  navigator.serviceWorker.controller?.postMessage({ type: "flowplan-offline" });
}
export async function offlineMarker(): Promise<OfflineMarker | null> {
  if (!offlineSupported()) return null;
  const marker = await (await store().open(SETTINGS_CACHE)).match(OFFLINE_MARKER);
  if (!marker) return null;
  try {
    const value = (await marker.json()) as OfflineMarker;
    return value && value.user ? { ...value, user: String(value.user) } : null;
  } catch {
    return null;
  }
}
async function writeMarker(marker: OfflineMarker) {
  await (await store().open(SETTINGS_CACHE)).put(
    OFFLINE_MARKER,
    new Response(JSON.stringify(marker), { headers: { "Content-Type": "application/json" } }),
  );
  window.dispatchEvent(new Event(OFFLINE_CHANGED));
}
// Fired on window after the marker changed (state line in the settings).
export { OFFLINE_CHANGED };
export async function offlineOwner(): Promise<string | null> {
  return (await offlineMarker())?.user || null;
}

// Cancels running refreshes: nothing they fetch is stored any more.
let generation = 0;
export async function disableOffline() {
  if (!offlineSupported()) return;
  generation++;
  const copies = store();
  await (await copies.open(SETTINGS_CACHE)).delete(OFFLINE_MARKER);
  await copies.remove(DATA_CACHE);
  // The app's files are of no use without the copy: their room is freed.
  // So are the shipped draw.io's (#454, lib/drawio-offline.ts).
  for (const name of await copies.names()) if (isStaticCache(name) || isDrawioCache(name)) await copies.remove(name);
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
  await persistOffline();
  // The app's files follow with the refresh: all of them, not only the
  // ones this page loaded (#47).
  const result = await refreshOffline({ full: true, onProgress });
  if (result.status !== "signed-out") void registerPeriodicSync();
  return result;
}

// Record contents and files never opened: on or off for this device. Off
// removes them (opened ones come back the next time they are opened) –
// except those of kept items and those with changes not sent yet.
export async function setOfflineRecords(on: boolean) {
  const marker = await offlineMarker();
  if (!marker) return;
  await writeMarker({ ...marker, includeRecords: on });
  if (!on) {
    const data = await store().open(DATA_CACHE);
    const keys = await data.keys();
    const tree = await storedTree(data, marker.workspace);
    const kept = keptPageIds(marker.keep, tree.pages, tree.encrypted);
    const refs = await scanRefs(data, keys);
    const locked = lockedKeys(marker.user);
    for (const key of keys)
      if ((isRowKey(key) || isFileKey(key)) && !locked(key) && !keptKey(key, kept, refs.referrers)) await data.delete(key);
    await writeMarker({ ...((await offlineMarker()) || marker), includeRecords: false, bytes: await cacheBytes(data) });
  }
}
// The budget for record contents and files on this device (bytes, one of
// budgetChoices()). A smaller one frees the rest with the next refresh.
export async function setOfflineBudget(budget: number) {
  const marker = await offlineMarker();
  if (marker) await writeMarker({ ...marker, budget, trim: marker.trim || budget < budgetOf(marker) });
}
// "Keep offline" for a space or a page (with every page below it) on this
// device. Off: what only it kept is freed with the next refresh.
export async function setOfflineKeep(item: KeepItem, on: boolean) {
  const marker = await offlineMarker();
  if (marker) await writeMarker({ ...marker, ...toggleKeep(marker, item, on) });
}

// The page tree of the stored workspace (its bootstrap answer): which
// space each page belongs to, and the encrypted spaces.
type Tree = { pages: TreePage[]; encrypted: Set<string>; spaces: { id: string }[] };
function treeOf(boot: unknown): Tree {
  const data = (boot || {}) as { pages?: TreePage[]; spaces?: { id: string; encrypted?: number }[] };
  const pages = Array.isArray(data.pages) ? data.pages.filter((p) => p && typeof p.id === "string" && typeof p.space_id === "string") : [];
  const spaces = Array.isArray(data.spaces) ? data.spaces.filter((sp) => sp && typeof sp.id === "string") : [];
  return { pages, spaces, encrypted: new Set(spaces.filter((sp) => sp.encrypted).map((sp) => sp.id)) };
}
async function storedTree(data: OfflineCache, workspace?: string): Promise<Tree> {
  try {
    const answer = (workspace && (await data.match(`/api/bootstrap?workspace=${workspace}`))) || (await data.match("/api/bootstrap"));
    return treeOf(answer ? await answer.json() : null);
  } catch {
    return treeOf(null);
  }
}
// Which stored page and record answers refer to which files (file id →
// page ids; "cards" for a flashcard deck's pictures).
async function scanRefs(data: OfflineCache, keys: string[]) {
  const referrers = new Map<string, Set<string>>();
  const referenced = new Set<string>(),
    cards = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith("/api/pages/") && !key.startsWith("/api/bootstrap")) continue;
    try {
      const page = isStudyKey(key) ? "cards" : (/^\/api\/pages\/([0-9a-f-]{36})/i.exec(key)?.[1]?.toLowerCase() ?? "");
      for (const ref of fileRefs((await (await data.match(key))?.text()) || "")) {
        (isStudyKey(key) ? cards : referenced).add(ref);
        if (!page) continue;
        const set = referrers.get(ref) || new Set<string>();
        set.add(page);
        referrers.set(ref, set);
      }
    } catch {}
  }
  return { referrers, referenced, cards };
}
// A record of a kept database, or a file a kept page or record refers to.
function keptKey(key: string, kept: ReadonlySet<string>, referrers: ReadonlyMap<string, ReadonlySet<string>>) {
  const page = rowPage(key);
  if (page) return kept.has(page);
  const file = /^\/api\/files\/([0-9a-f-]{36})/i.exec(key)?.[1]?.toLowerCase();
  return !!file && [...(referrers.get(file) || [])].some((p) => kept.has(p));
}
// Entries the cleanup never drops: records and files with changes on this
// device that are not sent yet (the offline queue, its failed changes and
// conflicts) and anything of a page made offline. Their content waits in
// the queue and IndexedDB (components/offline-uploads.ts), not in the copy –
// this only keeps the copy they are shown with.
function lockedKeys(userId: string): (key: string) => boolean {
  const rows = new Set<string>(),
    pages = new Set<string>(),
    files = new Set<string>();
  try {
    const key = queueKey(userId);
    for (const name of [key, `${key}:failed`, `${key}:conflicts`]) {
      const list = JSON.parse(localStorage.getItem(name) || "[]");
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const change = (item && typeof item === "object" && "change" in item ? item.change : item) as { pageId?: unknown; rowId?: unknown; fileId?: unknown } | null;
        if (typeof change?.pageId === "string" && typeof change.rowId === "string") rows.add(`${change.pageId}/${change.rowId}`.toLowerCase());
        if (typeof change?.pageId === "string" && !change.rowId) pages.add(change.pageId.toLowerCase());
        if (typeof change?.fileId === "string") files.add(change.fileId.toLowerCase());
      }
    }
  } catch {}
  return (key) => {
    const row = /^\/api\/pages\/([0-9a-f-]{36})\/rows\/([0-9a-f-]{36})/i.exec(key);
    if (row) return rows.has(`${row[1]}/${row[2]}`.toLowerCase()) || pages.has(row[1].toLowerCase()) || isPendingPage(row[1]);
    const file = /^\/api\/files\/([0-9a-f-]{36})/i.exec(key)?.[1]?.toLowerCase();
    return !!file && (files.has(file) || isPendingFile(file));
  };
}

async function entryBytes(response: Response | undefined) {
  if (!response) return 0;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) return length;
  return (await response.blob()).size;
}
async function cacheBytes(cache: OfflineCache) {
  let total = 0;
  for (const key of await cache.keys()) total += await entryBytes(await cache.match(key));
  return total;
}

class SignedOut extends Error {}

// Stores every file of the build in its own cache (flowplan-static-<build>).
// Files an older build shares (unchanged chunks keep their names) are
// copied from its cache; the others are fetched, four at a time. Once all
// are there and the stored app's page belongs to this build, the caches of
// older builds go.
export async function storeApp(
  assets: OfflineAssets,
  {
    shell,
    live,
    onStart,
    onFile,
  }: {
    shell: boolean;
    live: () => Promise<boolean>;
    onStart?: (missing: number) => void;
    onFile?: () => void;
  },
): Promise<OfflineApp> {
  const copies = store();
  const cache = await copies.open(staticCacheName(assets.build));
  const missing = missingAssets(assets.files, await cache.keys());
  const app: OfflineApp = {
    build: assets.build,
    version: assets.version,
    stored: assets.files.length - missing.length,
    total: assets.files.length,
    bytes: assets.bytes,
    complete: false,
    shell,
  };
  onStart?.(missing.length);
  const others = (await copies.names()).filter((name) => isStaticCache(name) && name !== staticCacheName(assets.build));
  // Unchanged files keep their names across builds, but not the deployment
  // id after them (?dpl=…, next.config.ts): an older build's copy is found
  // by the name alone.
  let index: Map<string, { name: string; key: string }> | null = null;
  const reused = async (path: string) => {
    if (!index) {
      index = new Map();
      for (const name of others)
        for (const key of await (await copies.open(name)).keys().catch(() => [] as string[])) if (!index.has(withoutDeployment(key))) index.set(withoutDeployment(key), { name, key });
    }
    const hit = index.get(withoutDeployment(path));
    return hit ? ((await (await copies.open(hit.name)).match(hit.key)) ?? null) : null;
  };
  // Only what is neither stored nor available from an older build counts
  // against the device's room.
  let needed = 0;
  for (const file of missing) if (!(await reused(file.path))) needed += file.size;
  const estimate = await copies.estimate();
  if (!fitsQuota(needed, estimate)) return { ...app, space: true };
  await inQueue(
    missing.map((file) => file.path),
    async (path) => {
      try {
        if (!(await live())) return;
        const old = await reused(path);
        if (old) await cache.put(path, old);
        else {
          // Past the service worker (it would store the file a second time);
          // the browser's HTTP cache may still answer.
          const response = await fetch(path, { credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } });
          if (!response.ok) throw new Error(String(response.status));
          await cache.put(path, response);
        }
        app.stored++;
      } catch {
        // Counted as missing; the next refresh tries again.
      } finally {
        onFile?.();
      }
    },
  );
  app.complete = app.stored >= app.total;
  if (app.complete && shell)
    for (const name of staleStaticCaches(await copies.names(), assets.build)) await copies.remove(name);
  return app;
}
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

// "storage": the device took nothing – not even the workspace or the
// marker (lib/offline-store.ts OfflineRefused): too little room for the copy.
export type RefreshResult = {
  status: "done" | "incomplete" | "signed-out" | "disabled" | "busy" | "storage";
  fetched: number;
  dropped: number;
};
let running: Promise<RefreshResult> | null = null;
// A refresh of this tab started or ended (#644): Settings → Offline &
// devices shows a run it did not start itself, e.g. the one on opening.
export const OFFLINE_SYNC = "flowplan-offline-sync";
export const offlineRefreshing = () => !!running;
const syncChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OFFLINE_SYNC));
};
// Brings the device copy up to date. Without full only what changed since
// the last refresh is fetched (GET /api/offline/changes); full fetches every
// readable page again (first copy, "Update now").
// `again`: a refresh already running read the settings before a change
// (budget, kept items, #417) – one more follows it.
export function refreshOffline(
  options: { full?: boolean; again?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<RefreshResult> {
  if (!offlineSupported()) return Promise.resolve({ status: "disabled", fetched: 0, dropped: 0 });
  if (running && options.again) return running.catch(() => undefined).then(() => refreshOffline({ ...options, again: false }));
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
    syncChanged();
  });
  syncChanged();
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
  let incomplete = false;
  const marker = await offlineMarker();
  if (!marker) return { ...result, status: "disabled" };
  const started = generation;
  const live = async () => started === generation && (await offlineOwner()) === marker.user;
  let done = 0,
    total = 3;
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
    // The app's files of the running build (one small list).
    const assetsAnswer = await fetchJson("/api/offline/assets").catch((error) => {
      if (error instanceof SignedOut) throw error;
      return null;
    });
    done++;
    const assets = assetsAnswer?.text ? (JSON.parse(assetsAnswer.text) as OfflineAssets) : null;
    // No list (an older server, a failed request): the copy is not complete.
    // An empty one (a development server without a build) has nothing to store.
    if (!assets) incomplete = true;
    // A new release: the app's page is stored again with its new files.
    const newBuild = !!assets?.files?.length && (marker.app?.build !== assets.build || !marker.app?.shell);
    if (!(await live())) return { ...result, status: "disabled" };
    const copies = store();
    const data = await copies.open(DATA_CACHE);
    await data.put(`/api/bootstrap?workspace=${workspaceId}`, stored(boot.response, boot.text));
    if (!workspace) await data.put("/api/bootstrap", stored(boot.response, boot.text));
    const drop = async (key: string) => {
      if (await data.delete(key)) result.dropped++;
    };
    // 1. Pages: new and changed ones, drop the ones gone.
    let keys = await data.keys();
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
    let shell = false;
    if (everything || newBuild || pages.fetch.length || pages.drop.length) {
      total++;
      try {
        const response = await fetch("/", { cache: "no-store", credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } });
        const html = response.ok ? await response.text() : "";
        if (html.includes('data-signed-out=""')) throw new SignedOut();
        if (html && (await live())) {
          const statics = await copies.open(assets ? staticCacheName(assets.build) : LEGACY_STATIC_CACHE);
          const found = [...new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
          for (const asset of found)
            if (!(await statics.match(asset)))
              await fetch(asset, { credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } })
                .then((answer) => (answer.ok ? statics.put(asset, answer) : undefined))
                .catch(() => undefined);
          await data.put("/", stored(response, html));
          shell = true;
        } else if (!html) incomplete = true;
      } catch (error) {
        if (error instanceof SignedOut) throw error;
        incomplete = true;
      }
      done++;
      progress();
    }

    // The app's own files: every file of the build, once per release.
    let app = marker.app;
    if (assets?.files?.length) {
      app = await storeApp(assets, {
        shell: shell || (marker.app?.build === assets.build && !!marker.app?.shell),
        live,
        onStart: (missing) => {
          total += missing;
          progress();
        },
        onFile: () => {
          done++;
          progress();
        },
      });
      // Too little room is no reason to ask for the pages again and again.
      if (!app.complete && !app.space) incomplete = true;
      if (!(await live())) return { ...result, status: "disabled" };
    }

    // 2. Record documents of the stored databases. Kept items (#417) come
    // first: their records and files are stored even when never opened,
    // ahead of "Also store record contents and files", within the budget.
    keys = await data.keys();
    const rows: Record<string, string[]> = {};
    for (const key of keys.filter(isPageKey)) {
      const id = key.slice("/api/pages/".length);
      try {
        rows[id] = pageRows(await (await data.match(key))?.json());
      } catch {}
    }
    const includeRecords = !!marker.includeRecords;
    const tree = treeOf(bootData);
    const kept = keptPageIds(marker.keep, tree.pages, tree.encrypted);
    const budget = budgetOf(marker);
    const locked = lockedKeys(marker.user);
    const records = planRecords({ keys, rows, changedRows: changes.rows, full: everything, includeRecords, kept: [...kept] });
    for (const key of records.drop) await drop(key);
    total += records.refresh.length;
    progress();
    await inQueue(records.refresh, fetchInto);
    // What counts against the budget: the records and files of kept items,
    // and with "Also store record contents and files" all of them.
    keys = await data.keys();
    let refs = await scanRefs(data, keys);
    // Switched off since the last refresh: what only those items kept goes.
    const released = marker.released || [];
    if (released.length && !includeRecords) {
      const freed = keptPageIds(released, tree.pages, tree.encrypted);
      for (const key of planRelease({ keys, released: freed, kept, referrers: refs.referrers, locked })) await drop(key);
      keys = await data.keys();
      refs = await scanRefs(data, keys);
    }
    const budgeted = new Map<string, BudgetEntry>();
    let used = 0;
    const count = (key: string, size: number) => {
      const isKept = keptKey(key, kept, refs.referrers);
      if (!isKept && !includeRecords) return;
      budgeted.set(key, { key, size, kept: isKept, locked: locked(key) });
      used += size;
    };
    if (includeRecords || kept.size)
      for (const key of keys.filter((k) => isRowKey(k) || isFileKey(k))) count(key, await entryBytes(await data.match(key)));
    const forget = async (key: string) => {
      const entry = budgeted.get(key);
      if (entry) {
        budgeted.delete(key);
        used -= entry.size;
      }
      await drop(key);
    };
    // A smaller budget chosen since the last refresh: the rest goes,
    // outside kept items first (otherwise nothing stored is taken away).
    if (marker.trim) for (const key of planTrim(budgeted.values(), budget)) await forget(key);
    // Room for one more entry: within the budget – a kept one by dropping
    // entries outside kept items – and within the browser's room.
    const room = async (size: number, isKept: boolean, counted: boolean) => {
      if (counted) {
        const plan = planRoom({ entries: budgeted.values(), used, budget, size, kept: isKept });
        if (!plan.fits) return false;
        for (const key of plan.drop) await forget(key);
      }
      return fitsQuota(size, await copies.estimate());
    };
    if (records.add.length) {
      total += records.add.length;
      progress();
      await inQueue(records.add, async (url) => {
        const isKept = kept.has(rowPage(url) || "");
        // Full: nothing more unless a kept record can make room.
        if (used < budget || (isKept && [...budgeted.values()].some((e) => !e.kept && !e.locked))) {
          const before = result.fetched;
          await fetchInto(url);
          if (result.fetched > before) {
            const size = await entryBytes(await data.match(url));
            if (await room(size, isKept, true)) {
              budgeted.set(url, { key: url, size, kept: isKept });
              used += size;
            } else await drop(url);
          }
        } else {
          done++;
          progress();
        }
      });
    }

    // 2b. Flashcards: the decks studied in the last 14 days, whole (an
    // older server sends no list: nothing changes).
    if (Array.isArray(changes.study)) {
      keys = await data.keys();
      const study = planStudy({ keys, decks: changes.study });
      for (const key of study.drop) await drop(key);
      total += study.fetch.length;
      progress();
      await inQueue(study.fetch, fetchInto);
    }

    // 3. Files: drop the ones no stored page refers to, add the others –
    // those of kept items first.
    keys = await data.keys();
    refs = await scanRefs(data, keys);
    const keptFiles = [...refs.referrers].filter(([, pages]) => [...pages].some((p) => kept.has(p))).map(([file]) => file);
    const keptFileSet = new Set(keptFiles);
    for (const entry of budgeted.values()) if (isFileKey(entry.key) && keptKey(entry.key, kept, refs.referrers)) entry.kept = true;
    const files = planFiles({ keys, referenced: [...refs.referenced], includeRecords, cards: [...refs.cards], kept: keptFiles });
    for (const key of files.drop) await forget(key);
    if (files.add.length) {
      total += files.add.length;
      progress();
      await inQueue(files.add, async (url) => {
        try {
          const id = url.slice("/api/files/".length).toLowerCase();
          const isKept = keptFileSet.has(id);
          // A flashcard deck's pictures without "Also store …": outside the budget.
          const counted = isKept || includeRecords;
          if (!counted || used < budget || (isKept && [...budgeted.values()].some((e) => !e.kept && !e.locked))) {
            const response = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { [OFFLINE_HEADER]: "1" } });
            if (response.status === 401) throw new SignedOut();
            const length = Number(response.headers.get("content-length")) || 0;
            if (!response.ok || (length && !(await room(length, isKept, counted)))) await response.body?.cancel();
            else {
              const blob = await response.blob();
              if ((length || (await room(blob.size, isKept, counted))) && (await live())) {
                await data.put(url, new Response(blob, { status: response.status, headers: response.headers }));
                if (counted) {
                  budgeted.set(url, { key: url, size: blob.size, kept: isKept });
                  used += blob.size;
                }
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
    // Storage per space, for Settings → Offline & devices.
    const sizes: [string, number][] = [];
    for (const key of await data.keys()) sizes.push([key, await entryBytes(await data.match(key))]);
    const spaceOf = new Map(tree.pages.map((p) => [p.id.toLowerCase(), p.space_id]));
    const fileOwner = new Map([...refs.referrers].map(([file, pages]) => [file, [...pages].find((p) => kept.has(p)) || [...pages][0]]));
    const pageCount = sizes.filter(([key]) => isPageKey(key)).length;
    const current = (await offlineMarker()) || marker;
    // Released items are handled now (with "Also store …" on there is
    // nothing to free); ones switched off meanwhile stay for the next run.
    const handled = released;
    await writeMarker({
      ...current,
      workspace: workspaceId,
      pages: pageCount,
      bytes: sizes.reduce((sum, [, size]) => sum + size, 0),
      budgetUsed: used,
      spaces: usageBySpace({ sizes, spaceOf, fileOwner }),
      released: (current.released || []).filter((item) => !handled.some((h) => h.kind === item.kind && h.id === item.id)),
      // The budget chosen meanwhile may be smaller again.
      trim: current.budget === marker.budget ? undefined : current.trim,
      ...(app ? { app } : {}),
      // An incomplete run keeps the old position, so nothing is skipped.
      ...(incomplete ? {} : { lastRefresh: Date.now(), cursor: changes.now }),
    });
    return { ...result, status: incomplete ? "incomplete" : "done" };
  } catch (error) {
    if (error instanceof SignedOut) return { ...result, status: "signed-out" };
    if (error instanceof TypeError) return { ...result, status: "incomplete" };
    // The workspace's answer or the marker was refused (#417): in the
    // iPhone and iPad app, which refuses those only for room, the copy stood
    // still without a word – settings unsaved, the app's files of the new
    // build never stored.
    if (isStorageRefusal(error)) return { ...result, status: "storage" };
    throw error;
  } finally {
    // Switched off meanwhile: nothing fetched may stay behind.
    if (started !== generation || !(await offlineMarker().catch(() => null))) {
      const copies = store();
      await copies.remove(DATA_CACHE).catch(() => undefined);
      for (const name of await copies.names().catch(() => [])) if (isStaticCache(name)) await copies.remove(name).catch(() => undefined);
    }
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
  if (!browserSupported() || appOfflineBridge()) return false;
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
  if (!browserSupported()) return;
  const registration = (await navigator.serviceWorker.getRegistration()) as PeriodicSyncRegistration | undefined;
  await registration?.periodicSync?.unregister(PERIODIC_SYNC_TAG);
}
