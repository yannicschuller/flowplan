// The shipped draw.io offline (#454): on a device with offline use switched
// on, public/sw.js keeps the files of /drawio/<version>/ that the editor
// loads in a cache of that version (flowplan-drawio-<version>) and answers
// from it without a connection. The files of a version never change, so
// they come from the cache first; the page and its settings (index.html,
// js/PreConfig.js, the list below) from the network first. Once a file of
// a newer version is stored, the caches of older versions go – at most
// one version's files (those the editor loaded, at most the shipped copy,
// about 50 MB, typically 25 MB) stay on the device. Switching offline use
// off removes them (components/offline.ts disableOffline).
// A page with a draw.io block shown online warms the cache (warmDrawio):
// the files draw.io needs to start (OFFLINE_LIST, made by
// lib/drawio-bundle.ts) are loaded once, so the editor opens offline even
// if it was never opened before. Shape pictures and libraries opened for
// the first time offline may stay empty.
// Pure functions and the warm-up; public/sw.js repeats the functions
// (tests/drawio-offline.test.ts checks both agree).
import type { DrawioConfig } from "./drawio";

export const DRAWIO_CACHE_PREFIX = "flowplan-drawio-";
export const DRAWIO_OFFLINE_LIST = "flowplan-offline.json";
const DRAWIO_FILE = /^\/drawio\/(\d{1,4}\.\d{1,4}\.\d{1,4})\/(.*)$/;

export const drawioCacheName = (version: string) => `${DRAWIO_CACHE_PREFIX}${version}`;
export const isDrawioCache = (name: string) => name.startsWith(DRAWIO_CACHE_PREFIX);
// Caches of other versions: removed once one of this version is filled.
export const staleDrawioCaches = (names: string[], version: string) =>
  names.filter((name) => isDrawioCache(name) && name !== drawioCacheName(version));
// A request's place in the cache: version and key (path only – the frame's
// address carries draw.io's parameters, which do not change the file), and
// whether the file may change within the version (network first).
export function drawioRequest(pathname: string): { version: string; key: string; fresh: boolean } | null {
  const match = DRAWIO_FILE.exec(pathname);
  if (!match) return null;
  const file = match[2];
  return {
    version: match[1],
    key: pathname,
    fresh: file === "" || file === "index.html" || file === "js/PreConfig.js" || file === DRAWIO_OFFLINE_LIST,
  };
}

// draw.io's texts in the editor's language (resources/dia_<lang>.txt;
// English is dia.txt).
export const drawioLanguageFile = (lang: string | undefined) =>
  !lang || /^en\b/i.test(lang) ? "resources/dia.txt" : `resources/dia_${lang.toLowerCase().replace(/[^a-z-]/g, "")}.txt`;

let warmed = "";
// Loads draw.io's start files once per page while online, through the
// service worker, which keeps them – only on a device with offline use on
// (offline: whether it is) and only if they are not kept already.
export async function warmDrawio(config: DrawioConfig | null, lang: string | undefined, offline: () => Promise<boolean>) {
  if (!config?.bundled || warmed === config.bundled) return;
  if (typeof navigator === "undefined" || !navigator.onLine || !navigator.serviceWorker?.controller || typeof caches === "undefined") return;
  warmed = config.bundled;
  try {
    if (!(await offline())) return;
    const base = new URL(config.url, location.origin).pathname;
    const cacheName = drawioCacheName(config.bundled);
    const list = await fetch(`${base}${DRAWIO_OFFLINE_LIST}`, { credentials: "same-origin" });
    if (!list.ok) return;
    const files = ((await list.json()) as { files?: unknown }).files;
    if (!Array.isArray(files)) return;
    for (const file of [...files.filter((f): f is string => typeof f === "string"), drawioLanguageFile(lang)]) {
      if (await caches.match(`${base}${file}`, { cacheName })) continue;
      // Answered and kept by public/sw.js.
      await fetch(`${base}${file}`, { credentials: "same-origin" }).catch(() => undefined);
    }
  } catch {}
}

// Whether the editor can open without a connection on this device.
export async function drawioKeptOffline(config: DrawioConfig | null): Promise<boolean> {
  if (!config?.bundled || typeof caches === "undefined") return false;
  try {
    const base = new URL(config.url, location.origin).pathname;
    const cacheName = drawioCacheName(config.bundled);
    return !!(await caches.match(base, { cacheName })) && !!(await caches.match(`${base}js/app.min.js`, { cacheName }));
  } catch {
    return false;
  }
}
