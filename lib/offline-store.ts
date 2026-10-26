// Where the offline copy lives (components/offline.ts): the browser's Cache
// Storage, which the service worker (public/sw.js) serves from, or – in the
// iPhone and iPad app, whose web view runs no service worker for an
// instance's address – the app's own storage on the device, reached through
// the bridge (window.FlowplanApp.offline, src/bridge-script.ts in
// flowplan-app). Both hold the same caches under the same names and keys
// (path and query), so the offline logic is the same for both; the app
// loads the stored page from its storage when there is no connection.

// The caches (public/sw.js uses the same names).
export const DATA_CACHE = "flowplan-data-v1",
  SETTINGS_CACHE = "flowplan-settings",
  OFFLINE_MARKER = "/__flowplan-offline";
// Fired on window after the marker changed (components/offline.ts).
export const OFFLINE_CHANGED = "flowplan:offline-changed";

export type StoredEntry = {
  status: number;
  statusText?: string;
  headers: [string, string][];
  // The body, base64.
  body: string;
};
// What the app offers (flowplan-app src/bridge-script.ts, protocol 1). The
// app checks every key and answer again (src/offline/policy.ts there).
export type AppOfflineBridge = {
  version: number;
  // This document is the app's stored copy (no connection when it opened).
  readonly copy: boolean;
  // The copy is showing and the app has not reached the instance since.
  readonly unreachable: boolean;
  names(): Promise<string[]>;
  keys(cache: string): Promise<string[]>;
  // cache null: in any cache (the app's files of every stored build).
  match(cache: string | null, key: string): Promise<StoredEntry | null>;
  put(cache: string, key: string, entry: StoredEntry): Promise<boolean>;
  delete(cache: string, key: string): Promise<boolean>;
  remove(cache: string): Promise<boolean>;
  estimate(): Promise<{ quota?: number; usage?: number }>;
};

export interface OfflineCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  // Path and query of every entry.
  keys(): Promise<string[]>;
}
export interface OfflineStore {
  kind: "browser" | "app";
  open(name: string): Promise<OfflineCache>;
  names(): Promise<string[]>;
  remove(name: string): Promise<boolean>;
  // In any cache.
  match(key: string): Promise<Response | undefined>;
  estimate(): Promise<{ quota?: number; usage?: number } | null>;
}

export const keyOf = (request: Request | string) => {
  const url = new URL(typeof request === "string" ? request : request.url, "http://flowplan.invalid");
  return url.pathname + url.search;
};

export function browserStore(storage: CacheStorage): OfflineStore {
  const wrap = (cache: Cache): OfflineCache => ({
    match: (key) => cache.match(key),
    put: (key, response) => cache.put(key, response),
    delete: (key) => cache.delete(key),
    keys: async () => (await cache.keys()).map(keyOf),
  });
  return {
    kind: "browser",
    open: async (name) => wrap(await storage.open(name)),
    names: () => storage.keys(),
    remove: (name) => storage.delete(name),
    match: (key) => storage.match(key),
    estimate: async () => (await navigator.storage?.estimate?.().catch(() => null)) ?? null,
  };
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function entryResponse(entry: StoredEntry) {
  const status = entry.status >= 200 && entry.status <= 599 ? entry.status : 200;
  const body = [101, 204, 205, 304].includes(status) ? null : fromBase64(entry.body || "");
  return new Response(body, { status, statusText: entry.statusText || "", headers: entry.headers });
}
export async function responseEntry(response: Response): Promise<StoredEntry> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: toBase64(new Uint8Array(await response.arrayBuffer())),
  };
}

export function appStore(bridge: AppOfflineBridge): OfflineStore {
  const cache = (name: string): OfflineCache => ({
    match: async (key) => {
      const entry = await bridge.match(name, key);
      return entry ? entryResponse(entry) : undefined;
    },
    put: async (key, response) => {
      // The app refuses what it does not keep (keys, sizes, no-store); a
      // refusal counts like a failed request.
      if (!(await bridge.put(name, key, await responseEntry(response)))) throw new Error("refused");
    },
    delete: (key) => bridge.delete(name, key),
    keys: () => bridge.keys(name),
  });
  return {
    kind: "app",
    open: async (name) => cache(name),
    names: () => bridge.names(),
    remove: (name) => bridge.remove(name),
    match: async (key) => {
      const entry = await bridge.match(null, key);
      return entry ? entryResponse(entry) : undefined;
    },
    estimate: () => bridge.estimate().catch(() => null),
  };
}

// The app's storage, when this page runs in an app that offers it.
export function appOfflineBridge(): AppOfflineBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { FlowplanApp?: { offline?: AppOfflineBridge } }).FlowplanApp?.offline;
  return bridge && bridge.version >= 1 && typeof bridge.put === "function" ? bridge : null;
}
// The app's stored copy is showing and the instance has not been reached
// since: offline, whatever navigator.onLine says (a server that is down).
export const appCopyUnreachable = () => !!appOfflineBridge()?.unreachable;

export function offlineStore(): OfflineStore | null {
  const bridge = appOfflineBridge();
  if (bridge) return appStore(bridge);
  if (typeof caches === "undefined") return null;
  return browserStore(caches);
}
