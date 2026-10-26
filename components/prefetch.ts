// Loading ahead: when someone is about to open a page or a record – the
// pointer rests on it (80 ms), a finger touches it, the keyboard focus lands
// on it – its data is loaded into the cache (lib/swr-cache.ts), so the click
// shows it at once. One listener for the whole app (installPrefetch) finds
// what is about to be opened:
//   [data-prefetch-page]                 page tree, search results, lists
//   a[href*="#page="]                    links to pages in documents
//   [data-database-page] [data-row-id]   records in database views
// At most two requests at a time, none with the data saver on or on a 2G
// connection, none for notebooks (their PDFs are large) and nothing larger
// than 1.5 MB is kept. Prefetch requests say so (X-Flowplan-Prefetch): the
// server does not count them as a visit or as presence on the page.
import { appCache, pageKey, recordCachePolicy, rowKey, type CachePolicy } from "@/lib/swr-cache";
import { parsePageLocation } from "@/lib/page-location";

export const PREFETCH_HEADER = "X-Flowplan-Prefetch";
export const INTENT_DELAY = 80;
// A copy younger than this is not loaded again.
const FRESH_MS = 30_000;
const MAX_BYTES = 1_500_000;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 8;

type Job = { key: string; url: string; policy: (value: unknown) => CachePolicy; version?: string };
type Context = {
  // How a page's data may be kept (pageCachePolicy with the workspace's pages).
  policy: (value: unknown) => CachePolicy;
  // The page's version as the page list knows it (updated_at), and its kind.
  page: (pageId: string) => { version: string; kind: string } | null;
  // Warms the code of a view (whiteboard, notebook …) before it is opened.
  preload?: (kind: string) => void;
};
let context: Context | null = null;
const queue: Job[] = [];
const inflight = new Map<string, Promise<unknown>>();
let active = 0;

export function configurePrefetch(next: Context | null) {
  context = next;
  if (!next) queue.length = 0;
}

type Connection = { saveData?: boolean; effectiveType?: string };
// Data saver or a very slow connection: nothing is loaded ahead.
export function prefetchAllowed(connection: Connection | undefined = typeof navigator === "undefined" ? undefined : (navigator as { connection?: Connection }).connection) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (!connection) return true;
  return !connection.saveData && !/(^|-)2g$/.test(connection.effectiveType || "");
}

async function load(job: Job) {
  const response = await fetch(job.url, { cache: "no-store", headers: { [PREFETCH_HEADER]: "1" } });
  if (!response.ok) return;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    return;
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) return;
  const value = JSON.parse(text);
  appCache().set(job.key, value, { version: job.version, policy: job.policy(value) });
  return value;
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift()!;
    active++;
    const run = load(job)
      .catch(() => undefined)
      .finally(() => {
        active--;
        inflight.delete(job.key);
        pump();
      });
    inflight.set(job.key, run);
  }
}

function enqueue(job: Job) {
  if (!prefetchAllowed() || !appCache().owner()) return;
  if (inflight.has(job.key) || queue.some((j) => j.key === job.key)) return;
  if (appCache().fresh(job.key, job.version, FRESH_MS)) return;
  // The newest intent first; old ones fall off.
  queue.unshift(job);
  queue.length = Math.min(queue.length, MAX_QUEUED);
  pump();
}

// A request already running for this key (e.g. the page being opened was
// prefetched a moment ago): opening waits for it instead of asking twice.
export const pendingPrefetch = (key: string) => inflight.get(key);

export function prefetchPage(pageId: string) {
  const info = context?.page(pageId);
  if (!context || !info || info.kind === "notebook") return;
  context.preload?.(info.kind);
  enqueue({ key: pageKey(pageId), url: `/api/pages/${pageId}`, policy: context.policy, version: info.version });
}

export function prefetchRecord(pageId: string, rowId: string) {
  if (!context || !context.page(pageId)) return;
  // Kept like its database (lib/swr-cache.ts); nothing without a copy of it.
  if (recordCachePolicy(appCache(), pageId) === "none") return;
  enqueue({ key: rowKey(pageId, rowId), url: `/api/pages/${pageId}/rows/${rowId}`, policy: () => recordCachePolicy(appCache(), pageId) });
}

// What an element leads to, if anything.
export function prefetchTarget(el: Element | null): { pageId: string; rowId?: string } | null {
  if (!el) return null;
  const marked = el.closest<HTMLElement>("[data-prefetch-page]");
  if (marked?.dataset.prefetchPage)
    return { pageId: marked.dataset.prefetchPage, rowId: marked.dataset.prefetchRow || undefined };
  const record = el.closest<HTMLElement>("[data-row-id]");
  const database = record?.closest<HTMLElement>("[data-database-page]");
  if (record?.dataset.rowId && database?.dataset.databasePage)
    return { pageId: database.dataset.databasePage, rowId: record.dataset.rowId };
  const link = el.closest<HTMLAnchorElement>('a[href*="#page="]');
  if (link) {
    const target = parsePageLocation(new URL(link.href, location.href).hash);
    if (target) return { pageId: target.pageId, rowId: target.rowId };
  }
  return null;
}

function prefetchElement(el: Element | null) {
  const target = prefetchTarget(el);
  if (!target) return;
  if (target.rowId) prefetchRecord(target.pageId, target.rowId);
  else prefetchPage(target.pageId);
}

// The app-wide listener; returns its removal.
export function installPrefetch(root: Document | HTMLElement = document) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hovered: Element | null = null;
  const over = (e: Event) => {
    const event = e as PointerEvent;
    if (event.pointerType && event.pointerType !== "mouse") return;
    const el = event.target as Element | null;
    if (!el?.closest) return;
    const target = el.closest('[data-prefetch-page], [data-row-id], a[href*="#page="]');
    if (target === hovered) return;
    hovered = target;
    clearTimeout(timer);
    if (target) timer = setTimeout(() => prefetchElement(target), INTENT_DELAY);
  };
  const out = (e: Event) => {
    const related = (e as PointerEvent).relatedTarget as Element | null;
    if (hovered && related && hovered.contains(related)) return;
    hovered = null;
    clearTimeout(timer);
  };
  const touch = (e: Event) => prefetchElement(e.target as Element | null);
  const focus = (e: Event) => {
    clearTimeout(timer);
    const el = e.target as Element | null;
    timer = setTimeout(() => prefetchElement(el), INTENT_DELAY);
  };
  root.addEventListener("pointerover", over, { passive: true });
  root.addEventListener("pointerout", out, { passive: true });
  root.addEventListener("touchstart", touch, { passive: true, capture: true });
  root.addEventListener("focusin", focus);
  return () => {
    clearTimeout(timer);
    root.removeEventListener("pointerover", over);
    root.removeEventListener("pointerout", out);
    root.removeEventListener("touchstart", touch, { capture: true });
    root.removeEventListener("focusin", focus);
  };
}
