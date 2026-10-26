// What public/sw.js does in a browser, for the iPhone and iPad app: its web
// view runs no service worker for an instance's address, so the page itself
// answers from the app's copy (lib/offline-store.ts) once offline use is on.
// - Requests the copy holds (lib/offline-kind.ts) go to the network first;
//   pages, records and files that arrive are kept, as the service worker
//   keeps them, and the copy answers when the network fails. While the app
//   shows its stored copy and has not reached the instance since (a server
//   that is down rather than no network), the copy answers first.
// - Pictures of the copy (<img src="/api/files/…">) that fail to load are
//   shown from it.
// The app's own files of a stored page load through the app's bridge
// (src/offline/loader.ts in flowplan-app), before any of this runs.
import { offlineKind } from "./offline-kind";
import {
  DATA_CACHE,
  OFFLINE_CHANGED,
  OFFLINE_MARKER,
  SETTINGS_CACHE,
  appOfflineBridge,
  appStore,
  type AppOfflineBridge,
  type OfflineStore,
} from "./offline-store";

const OFFLINE_HEADER = "x-flowplan-offline";

export type AppOfflineFetch = {
  fetch: typeof fetch;
  // Pictures that failed (the error listener).
  image: (img: HTMLImageElement) => Promise<boolean>;
};

// The fetch that answers from the copy; `original` is the browser's.
export function appOfflineFetch(
  bridge: AppOfflineBridge,
  original: typeof fetch,
  origin: string,
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): AppOfflineFetch & { reset: () => void } {
  const store: OfflineStore = appStore(bridge);
  // Whether offline use is on, asked once and again after every change.
  let enabled: Promise<boolean> | null = null;
  const on = () =>
    (enabled ??= store
      .open(SETTINGS_CACHE)
      .then((cache) => cache.match(OFFLINE_MARKER))
      .then((marker) => !!marker)
      .catch(() => false));
  const lookup = async (kind: "static" | "data", key: string) =>
    kind === "static" ? store.match(key) : (await store.open(DATA_CACHE)).match(key);
  const keep = async (key: string, response: Response) => {
    try {
      await (await store.open(DATA_CACHE)).put(key, response);
    } catch {}
  };

  const answer: typeof fetch = async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      return original(input, init);
    }
    const kind = offlineKind({ method: request.method, url: request.url, offlineHeader: request.headers.get(OFFLINE_HEADER) }, origin);
    if (!kind || !(await on())) return original(input, init);
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    if (bridge.unreachable) {
      const stored = await lookup(kind, key).catch(() => undefined);
      if (stored) return stored;
    }
    try {
      const response = await original(input, init);
      if (kind === "data" && response.ok && response.status === 200) void keep(key, response.clone());
      return response;
    } catch (error) {
      // Only a failed network, not a cancelled request.
      if (!(error instanceof TypeError)) throw error;
      const stored = await lookup(kind, key).catch(() => undefined);
      if (stored) return stored;
      throw error;
    }
  };

  const tried = new WeakSet<HTMLImageElement>();
  const image = async (img: HTMLImageElement) => {
    if (tried.has(img)) return false;
    const src = img.currentSrc || img.src;
    const kind = offlineKind({ method: "GET", url: src }, origin);
    if (!kind || !(await on())) return false;
    tried.add(img);
    const url = new URL(src, origin);
    const stored = await lookup(kind, url.pathname + url.search).catch(() => undefined);
    if (!stored?.ok) return false;
    img.removeAttribute("srcset");
    img.src = createUrl(await stored.blob());
    return true;
  };
  return { fetch: answer, image, reset: () => (enabled = null) };
}

let installed = false;
// Once per page, when the app offers its storage. Imported by
// components/offline.ts, so it is in place before the workspace loads.
export function installAppOffline() {
  if (installed || typeof window === "undefined") return;
  const bridge = appOfflineBridge();
  if (!bridge) return;
  installed = true;
  const shim = appOfflineFetch(bridge, window.fetch.bind(window), location.origin);
  window.fetch = shim.fetch;
  window.addEventListener(OFFLINE_CHANGED, shim.reset);
  document.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLImageElement) void shim.image(event.target);
    },
    true,
  );
}
