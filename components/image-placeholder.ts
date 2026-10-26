"use client";
// Blurred placeholders while uploaded images load: the server's size and
// ThumbHash of an image (lib/image-placeholders.ts) become a tiny picture
// behind the image, in its final proportions, so nothing moves when it
// arrives; the image then fades in over it. Placeholders are asked for in
// batches (GET /api/files/placeholders), kept for the tab and dropped on
// sign-out. Images that are not uploads of this instance (links, encrypted
// files shown from blob: URLs) stay as they were.
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type SyntheticEvent } from "react";
import { thumbHashFromBase64, thumbHashToDataURL } from "@/lib/thumbhash";
import { prefersReducedMotion } from "@/lib/motion";

export type PlaceholderInfo = { w: number; h: number; hash?: string };
type Entry = PlaceholderInfo & { url?: string };

const known = new Map<string, Entry | null>();
const listeners = new Map<string, Set<() => void>>();
const wanted = new Set<string>();
const inFlight = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** How long the fade-in takes (app/globals.css .fp-fade). */
const FADE_MS = 280;

/** The key of an image URL: "<file id>" for uploads, "avatar:<user id>"
 *  for profile pictures; null for anything else. */
export function placeholderKey(src: string | null | undefined): string | null {
  if (!src) return null;
  const file = /^\/api\/files\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(src);
  if (file) return file[1].toLowerCase();
  const avatar = /^\/api\/avatars\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(src);
  return avatar ? `avatar:${avatar[1].toLowerCase()}` : null;
}

function notify(key: string) {
  for (const listener of listeners.get(key) || []) listener();
}
function entryOf(info: PlaceholderInfo): Entry {
  const hash = info.hash ? thumbHashFromBase64(info.hash) : null;
  let url: string | undefined;
  try {
    url = hash ? thumbHashToDataURL(hash) : undefined;
  } catch {
    url = undefined;
  }
  return { w: info.w, h: info.h, url };
}

/** Takes a placeholder the server sent along (an upload's answer). */
export function primePlaceholder(src: string | null | undefined, info: PlaceholderInfo | null | undefined) {
  const key = placeholderKey(src);
  if (!key || !info || !(info.w > 0 && info.h > 0)) return;
  known.set(key, entryOf(info));
  notify(key);
}

async function flush() {
  flushTimer = null;
  const keys = [...wanted].filter((k) => !known.has(k) && !inFlight.has(k));
  wanted.clear();
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    batch.forEach((k) => inFlight.add(k));
    try {
      const response = await fetch(`/api/files/placeholders?ids=${batch.map(encodeURIComponent).join(",")}`, {
        credentials: "same-origin",
      });
      if (!response.ok) continue;
      const { placeholders } = (await response.json()) as { placeholders: Record<string, PlaceholderInfo> };
      for (const key of batch) {
        const info = placeholders?.[key];
        known.set(key, info && info.w > 0 && info.h > 0 ? entryOf(info) : null);
        notify(key);
      }
    } catch {
      // Offline or signed out: the images simply load without one.
    } finally {
      batch.forEach((k) => inFlight.delete(k));
    }
  }
}

/** Asks for placeholders (collected for a moment, then one request). */
export function requestPlaceholders(keys: Iterable<string>) {
  for (const key of keys) if (!known.has(key) && !inFlight.has(key)) wanted.add(key);
  if (wanted.size && !flushTimer) flushTimer = setTimeout(() => void flush(), 0);
}

/** Forgets all placeholders (sign-out, another person in this tab). */
export function clearPlaceholders() {
  known.clear();
  wanted.clear();
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

/** The placeholder of an image URL, once known (undefined while asking). */
export function usePlaceholder(src: string | null | undefined) {
  const key = placeholderKey(src);
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => {}), [key]),
    () => (key ? known.get(key) : null),
    () => null,
  );
  useEffect(() => {
    if (key && !known.has(key)) requestPlaceholders([key]);
  }, [key]);
  return entry;
}

type Phase = "loading" | "loaded" | "settled";

/** For an <img> inside a box: the box shows the blurred picture until the
 *  image has faded in over it. `fit` and `position` follow the image's
 *  object-fit and object-position. */
export function useImagePlaceholder(
  src: string | null | undefined,
  { fit = "cover", position }: { fit?: "cover" | "contain" | "fill"; position?: string } = {},
) {
  const entry = usePlaceholder(src);
  const key = placeholderKey(src);
  const [state, setState] = useState<{ src: string | null | undefined; phase: Phase }>({ src, phase: "loading" });
  const phase = state.src === src ? state.phase : "loading";
  const set = useCallback((next: Phase) => setState((s) => (s.src === src && s.phase === next ? s : { src, phase: next })), [src]);
  // Already in the browser's cache: shown at once, without a fade.
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth) set("settled");
    },
    [set],
  );
  useEffect(() => {
    if (phase !== "loaded") return;
    const timer = setTimeout(() => set("settled"), prefersReducedMotion() ? 0 : FADE_MS + 60);
    return () => clearTimeout(timer);
  }, [phase, set]);
  const showPlaceholder = !!entry?.url && phase !== "settled";
  const frameStyle: CSSProperties | undefined = showPlaceholder
    ? {
        backgroundImage: `url("${entry!.url}")`,
        backgroundSize: fit === "fill" ? "100% 100%" : fit,
        backgroundPosition: position || "center",
        backgroundRepeat: "no-repeat",
      }
    : undefined;
  return {
    entry,
    /** For the box around the image. */
    frameStyle,
    /** Width / height, for reserving the room before the image is there. */
    aspectRatio: entry ? `${entry.w} / ${entry.h}` : undefined,
    imgProps: key
      ? {
          ref,
          className: phase === "loading" ? "fp-fade" : "fp-fade is-loaded",
          onLoad: (_event: SyntheticEvent<HTMLImageElement>) => set("loaded"),
        }
      : {},
  };
}

/** The same for images the editor renders itself (no React): the frame
 *  shows the picture, the image keeps its final size while it loads.
 *  Returns the cleanup. */
export function attachPlaceholder(img: HTMLImageElement, frame: HTMLElement): () => void {
  const key = placeholderKey(img.getAttribute("src"));
  if (!key) return () => {};
  let loaded = img.complete && img.naturalWidth > 0,
    settled = loaded,
    sizedWidth = false;
  img.classList.add("fp-fade");
  if (loaded) img.classList.add("is-loaded");
  const clear = () => {
    frame.style.removeProperty("background-image");
    frame.style.removeProperty("background-size");
    frame.style.removeProperty("background-repeat");
    if (sizedWidth) img.style.removeProperty("width");
    img.style.removeProperty("aspect-ratio");
    sizedWidth = false;
  };
  const apply = () => {
    const entry = known.get(key);
    if (!entry || settled) return;
    // The room the image will take, before it is there.
    img.style.aspectRatio = `${entry.w} / ${entry.h}`;
    if (!img.getAttribute("width") && !img.style.width) {
      img.style.width = `${entry.w}px`;
      sizedWidth = true;
    }
    if (entry.url) {
      frame.style.backgroundImage = `url("${entry.url}")`;
      frame.style.backgroundSize = "100% 100%";
      frame.style.backgroundRepeat = "no-repeat";
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onLoad = () => {
    if (loaded) return;
    loaded = true;
    img.classList.add("is-loaded");
    timer = setTimeout(
      () => {
        settled = true;
        clear();
      },
      prefersReducedMotion() ? 0 : FADE_MS + 60,
    );
  };
  img.addEventListener("load", onLoad);
  const unsubscribe = subscribe(key, apply);
  if (!loaded) {
    if (known.has(key)) apply();
    else requestPlaceholders([key]);
  }
  return () => {
    clearTimeout(timer);
    img.removeEventListener("load", onLoad);
    unsubscribe();
    clear();
  };
}
