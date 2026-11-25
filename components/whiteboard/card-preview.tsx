"use client";
// Live content on page cards of the board: the first lines of the
// document (the hover-card summary, /api/pages/<id>/preview) on cards tall
// enough, and – on large cards in view (#549) – the whole document as
// read-only HTML (?full=1, components/whiteboard/page-card-doc.tsx draws
// it). Kept per page and device; asked again after a minute, when the page
// was saved in this window (an editor beside the board, PAGE_SAVED_EVENT),
// and – for whole documents on screen – every 30 s and when the window
// comes back (others' edits), cheaply: the server answers 304 while the
// document is unchanged.
import { useEffect, useState } from "react";
import { PAGE_SAVED_EVENT } from "@/lib/page-saved";

type Preview = { excerpt: string; at: number };
const cache = new Map<string, Preview>();
const pending = new Map<string, Promise<Preview | null>>();
function load(pageId: string) {
  const known = cache.get(pageId);
  if (known && Date.now() - known.at < 60_000) return Promise.resolve(known);
  let request = pending.get(pageId);
  if (!request) {
    request = fetch(`/api/pages/${pageId}/preview`, { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { excerpt?: unknown };
        const preview = { excerpt: typeof data.excerpt === "string" ? data.excerpt : "", at: Date.now() };
        cache.set(pageId, preview);
        return preview;
      })
      .catch(() => null)
      .finally(() => pending.delete(pageId));
    pending.set(pageId, request);
  }
  return request;
}
// A page saved in this window: what is kept of it is old.
const listeners = new Set<(pageId: string) => void>();
let listening = false;
function onSaved(listener: (pageId: string) => void) {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener(PAGE_SAVED_EVENT, (event) => {
      const pageId = (event as CustomEvent<string>).detail;
      if (typeof pageId !== "string") return;
      cache.delete(pageId);
      docs.forEach((_, key) => key === pageId && docs.set(key, { ...docs.get(key)!, at: 0 }));
      listeners.forEach((listener) => listener(pageId));
    });
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function CardExcerpt({ pageId }: { pageId: string }) {
  const [text, setText] = useState(() => cache.get(pageId)?.excerpt || "");
  useEffect(() => {
    let alive = true;
    const fetchIt = () => void load(pageId).then((preview) => alive && preview && setText(preview.excerpt));
    fetchIt();
    const stop = onSaved((saved) => saved === pageId && fetchIt());
    return () => {
      alive = false;
      stop();
    };
  }, [pageId]);
  return text ? <span className="wb-card-excerpt">{text}</span> : null;
}

// ---- the whole document (#549) ----
export type CardDocument =
  | { state: "loading" }
  | { state: "ready"; html: string }
  | { state: "encrypted" }
  | { state: "locked" }
  | { state: "denied" };
type KeptDocument = { doc: CardDocument; tag: string | null; at: number };
const docs = new Map<string, KeptDocument>();
const docRequests = new Map<string, Promise<KeptDocument>>();
// At most this many documents are kept (the oldest go first).
const KEPT_DOCUMENTS = 40;
function loadDocument(pageId: string, force = false): Promise<KeptDocument> {
  const known = docs.get(pageId);
  if (known && !force && Date.now() - known.at < 60_000) return Promise.resolve(known);
  let request = docRequests.get(pageId);
  if (!request) {
    request = fetch(`/api/pages/${pageId}/preview?full=1`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: known?.tag ? { "If-None-Match": known.tag } : {},
    })
      .then(async (response): Promise<KeptDocument> => {
        if (response.status === 304 && known) return { ...known, at: Date.now() };
        if (!response.ok) return { doc: { state: "denied" }, tag: null, at: Date.now() };
        const data = (await response.json()) as { html?: unknown; encrypted?: unknown; locked?: unknown };
        const doc: CardDocument = data.encrypted
          ? { state: "encrypted" }
          : data.locked
            ? { state: "locked" }
            : { state: "ready", html: typeof data.html === "string" ? data.html : "" };
        return { doc, tag: response.headers.get("ETag"), at: Date.now() };
      })
      // Offline or the server away: what was shown stays.
      .catch(() => known ?? { doc: { state: "denied" } as CardDocument, tag: null, at: Date.now() })
      .then((kept) => {
        docs.delete(pageId);
        docs.set(pageId, kept);
        for (const key of docs.keys()) if (docs.size > KEPT_DOCUMENTS) docs.delete(key);
        return kept;
      })
      .finally(() => docRequests.delete(pageId));
    docRequests.set(pageId, request);
  }
  return request;
}
// The document of a page card while it is shown large; refreshed as above.
export function useCardDocument(pageId: string): CardDocument {
  const [doc, setDoc] = useState<CardDocument>(() => docs.get(pageId)?.doc ?? { state: "loading" });
  useEffect(() => {
    let alive = true;
    const fetchIt = (force = false) =>
      void loadDocument(pageId, force).then((kept) => {
        if (alive) setDoc((before) => (sameDocument(before, kept.doc) ? before : kept.doc));
      });
    fetchIt();
    const stop = onSaved((saved) => saved === pageId && fetchIt(true));
    const timer = setInterval(() => document.visibilityState === "visible" && fetchIt(true), 30_000);
    const back = () => document.visibilityState === "visible" && fetchIt(true);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      alive = false;
      stop();
      clearInterval(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [pageId]);
  return doc;
}
const sameDocument = (a: CardDocument, b: CardDocument) =>
  a.state === b.state && (a.state !== "ready" || a.html === (b as { html: string }).html);
