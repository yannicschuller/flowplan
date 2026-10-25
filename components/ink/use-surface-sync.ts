"use client";
// Saving the ink of a page's surfaces – notebook sheets, drawing blocks –
// as it is drawn (lib/page-ink-store.ts): each changed surface is saved a
// moment after the last stroke, merged with what others saved in between,
// changes of others are followed every few seconds, and – in the iPhone and
// iPad app – the handwriting is recognised on the device and its text saved
// for search (lib/ink/recognition.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ui";
import type { PageSize } from "@/lib/ink/coords";
import { mergePage } from "@/lib/ink/merge";
import { emptyInk, parseInk, type InkDoc, type InkItem } from "@/lib/ink/model";
import { recognitionAvailable, recognitionId, recognitionRequest, recognizeInk } from "@/lib/ink/recognition";
import type { InkEditor } from "./use-ink-editor";

export type SurfaceStatus = "saved" | "dirty" | "saving" | "error";
type Saved = { version: number; items: InkItem[] };
type SaveAnswer = { version: number; conflict: { by: string | null } | null; doc?: InkDoc };
const NONE: InkItem[] = [];
const same = (a: InkItem[] | undefined, b: InkItem[] | undefined) => (a || NONE) === (b || NONE) || (!a?.length && !b?.length);

export const surfaceUrl = (pageId: string, surface: string) => `/api/pages/${pageId}/ink?surface=${encodeURIComponent(surface)}`;

// One request for the versions of a page's surfaces, shared by all blocks
// of the page that ask at about the same time.
const versionRequests = new Map<string, { at: number; promise: Promise<Record<string, number>> }>();
function pageVersions(pageId: string) {
  const cached = versionRequests.get(pageId);
  if (cached && Date.now() - cached.at < 3000) return cached.promise;
  const promise = api<{ versions: Record<string, number> }>(`/api/pages/${pageId}/ink`).then((r) => r.versions || {});
  versionRequests.set(pageId, { at: Date.now(), promise });
  promise.catch(() => versionRequests.delete(pageId));
  return promise;
}

export function useSurfaceSync({
  pageId,
  editor,
  canEdit,
  sizeOf,
  delay = 1200,
  poll = 10000,
  surfaces,
  onConflict,
}: {
  pageId: string;
  editor: InkEditor;
  canEdit: boolean;
  // The size of a surface in points (for recognition).
  sizeOf: (surface: string) => PageSize | null;
  delay?: number;
  poll?: number;
  // Which surfaces to follow (default: those known).
  surfaces?: string[];
  onConflict?: (by: string | null) => void;
}) {
  const saved = useRef(new Map<string, Saved>());
  const inflight = useRef(new Set<string>());
  const [status, setStatus] = useState<SurfaceStatus>("saved");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognition = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const live = useRef({ editor, canEdit, sizeOf, onConflict, surfaces, pageId });
  live.current = { editor, canEdit, sizeOf, onConflict, surfaces, pageId };

  // The state as loaded (or created): the base of the next save.
  const prime = useCallback((surface: string, version: number, items: InkItem[] = NONE) => {
    saved.current.set(surface, { version, items });
  }, []);
  const forget = useCallback((surface: string) => {
    saved.current.delete(surface);
  }, []);
  const known = (surface: string) => saved.current.get(surface)?.version ?? 0;

  const dirtySurfaces = useCallback(() => {
    const doc = live.current.editor.docRef.current;
    const keys = new Set([...Object.keys(doc.pages), ...saved.current.keys()]);
    return [...keys].filter((key) => saved.current.has(key) && !same(doc.pages[key], saved.current.get(key)?.items));
  }, []);

  // In the app: the text of the handwriting, for search.
  const recognize = useCallback((surface: string, version: number) => {
    if (!recognitionAvailable()) return;
    clearTimeout(recognition.current.get(surface));
    recognition.current.set(
      surface,
      setTimeout(async () => {
        const { sizeOf: size, pageId: page } = live.current;
        const state = saved.current.get(surface);
        const area = size(surface);
        if (!state || state.version !== version || !area) return;
        const request = recognitionRequest(recognitionId("search"), area, state.items);
        const result = request ? await recognizeInk(request) : { text: "" };
        if (!result || saved.current.get(surface)?.version !== version) return;
        try {
          await api(surfaceUrl(page, surface), { version, recognized: result.text });
        } catch {}
      }, 2500),
    );
  }, []);

  const saveSurface = useCallback(
    async (surface: string) => {
      const { editor: ed, pageId: page } = live.current;
      if (inflight.current.has(surface)) return;
      const snapshot = ed.docRef.current.pages[surface] || NONE;
      const base = saved.current.get(surface);
      if (!base) return;
      inflight.current.add(surface);
      try {
        const doc = emptyInk();
        if (snapshot.length) doc.pages[surface] = snapshot;
        const result = await api<SaveAnswer>(surfaceUrl(page, surface), { base: base.version, doc });
        let items = snapshot;
        if (result.doc) {
          // Someone saved in between: theirs merged with ours (server), and
          // with what was drawn here while saving.
          const merged = parseInk(result.doc).pages[surface] || NONE;
          const now = ed.docRef.current.pages[surface] || NONE;
          ed.applyRemote(surface, now === snapshot ? merged : mergePage(snapshot, now, merged));
          items = merged;
        }
        saved.current.set(surface, { version: result.version, items });
        if (result.conflict) live.current.onConflict?.(result.conflict.by);
        recognize(surface, result.version);
      } finally {
        inflight.current.delete(surface);
      }
    },
    [recognize],
  );

  // Saves every changed surface now; true when all are saved.
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!live.current.canEdit) return true;
    const dirty = dirtySurfaces();
    if (!dirty.length) {
      if (!inflight.current.size) setStatus("saved");
      return true;
    }
    setStatus("saving");
    try {
      await Promise.all(dirty.map(saveSurface));
      setError("");
      const rest = dirtySurfaces();
      setStatus(rest.length ? "dirty" : "saved");
      if (rest.length) timer.current = setTimeout(() => void flush(), delay);
      return !rest.length;
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
      // Tried again a little later.
      timer.current = setTimeout(() => void flush(), 5000);
      return false;
    }
  }, [delay, dirtySurfaces, saveSurface]);

  // A moment after the last change.
  const doc = editor.doc;
  useEffect(() => {
    if (!canEdit || !dirtySurfaces().length) return;
    setStatus((s) => (s === "saving" ? s : "dirty"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
  }, [doc, canEdit, delay, dirtySurfaces, flush]);

  // Changes of others.
  useEffect(() => {
    if (!poll) return;
    const follow = async () => {
      if (document.visibilityState !== "visible") return;
      const { editor: ed, pageId: page, surfaces: wanted } = live.current;
      let versions: Record<string, number>;
      try {
        versions = await pageVersions(page);
      } catch {
        return;
      }
      for (const [surface, version] of Object.entries(versions)) {
        if (wanted && !wanted.includes(surface)) continue;
        const state = saved.current.get(surface);
        if (!state || version <= state.version || inflight.current.has(surface)) continue;
        try {
          const remote = await api<{ doc: InkDoc; version: number }>(surfaceUrl(page, surface));
          const current = saved.current.get(surface);
          if (!current || remote.version <= current.version || inflight.current.has(surface)) continue;
          const theirs = parseInk(remote.doc).pages[surface] || NONE;
          const now = ed.docRef.current.pages[surface] || NONE;
          ed.applyRemote(surface, now === current.items ? theirs : mergePage(current.items, now, theirs));
          saved.current.set(surface, { version: remote.version, items: theirs });
        } catch {}
      }
    };
    const id = setInterval(() => void follow(), poll);
    return () => clearInterval(id);
  }, [poll]);

  // Unsaved strokes are not lost by leaving: saved when the tab hides,
  // a warning before closing.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtySurfaces().length || inflight.current.size) event.preventDefault();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("beforeunload", warn);
    };
  }, [flush, dirtySurfaces]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      for (const t of recognition.current.values()) clearTimeout(t);
      // Leaving the page or block: what is not saved yet goes now.
      void flushRef.current();
    },
    [],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;

  return { status, error, flush, prime, forget, known };
}
