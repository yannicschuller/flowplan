"use client";
// A PDF page on the whiteboard (#455), sharp at any zoom, with the PDF's
// annotations.
//
// The page used to be drawn once for its size on the board (at most 1200 px)
// and then scaled with the board: zoomed in, the pixels grew – blurry, while
// the viewer (a double click) drew it for the screen. Now it is drawn for
// the size it has on the screen (lib/whiteboard-pdf-pages.ts
// pdfRenderWidth: size × zoom × device pixel ratio, in steps, capped), once
// the zoom has settled and only while the element is near the visible part
// of the board; elsewhere it keeps what it has (or a first drawing at 100 %,
// which the exports need too). Drawings are kept per page, step and
// annotations in a small cache with a pixel budget, so zooming back and
// forth or paging through draws nothing twice.
//
// The annotations (the PDF's ink, `<file>/ink`, made in the PDF viewer) are
// drawn into the same picture – so the exports, which copy the page's
// pixels (board-export.ts), have them too – unless the element hides them
// (`hideInk`, the button in its bar). Saving ink in the viewer shows the
// new ink here at once (PDF_INK_EVENT).
import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, FilePdf, Highlighter } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { loadPdf, PDF_INK_EVENT, renderPage, type PdfDocument } from "../pdf-viewer";
import { useBoard } from "./board-context";
import { currentPage, pdfRenderWidth, shownPages } from "@/lib/whiteboard-pdf-pages";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import type { InkDoc, InkItem } from "@/lib/ink/model";

const BAR = 28;
// Pages of the PDFs shown on the board (for the page buttons).
const pageCounts = new Map<string, number>();
export const pdfPageCount = (src: string) => pageCounts.get(src) || 0;

// ---- annotations ----

type Ink = { doc: InkDoc; version: number };
const inks = new Map<string, Promise<Ink | null>>();
const inkListeners = new Set<(src: string) => void>();
if (typeof window !== "undefined")
  window.addEventListener(PDF_INK_EVENT, (e) => {
    const src = (e as CustomEvent<{ src?: string }>).detail?.src;
    if (!src) return;
    inks.delete(src);
    inkListeners.forEach((l) => l(src));
  });
function loadInk(src: string): Promise<Ink | null> {
  let ink = inks.get(src);
  if (!ink) {
    ink = (async () => {
      try {
        const response = await fetch(`${src}/ink`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return null;
        const data = (await response.json()) as { doc?: unknown; version?: number };
        const { parseInk } = await import("@/lib/ink/model");
        return { doc: parseInk(data.doc), version: Number(data.version) || 0 };
      } catch {
        // Without ink (no access, an older server) the page still shows.
        return null;
      }
    })();
    inks.set(src, ink);
  }
  return ink;
}
// Whether the PDF has annotations on any page.
const hasAnyInk = (ink: Ink | null) => !!ink && Object.values(ink.doc.pages).some((list) => list.length > 0);

// Pictures in the ink as data: an SVG drawn as an image loads nothing.
const pictureData = new Map<string, Promise<string | null>>();
function fileData(url: string) {
  let data = pictureData.get(url);
  if (!data) {
    data = (async () => {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) return null;
        const blob = await response.blob();
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })();
    pictureData.set(url, data);
  }
  return data;
}
async function svgImage(svg: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  return image;
}
// The ink of one page over the drawn page (in page units, scaled to the
// canvas). Highlighter under everything multiplies with the page, as in
// the viewer's ink layer.
async function drawInk(canvas: HTMLCanvasElement, src: string, items: InkItem[], size: { width: number; height: number }) {
  const { inkSvg, splitHighlights } = await import("@/lib/ink/svg");
  const files = [...new Set(items.flatMap((i) => (i.type === "image" && i.file ? [i.file] : [])))];
  // Files of the PDF's page: next to the PDF's own address.
  const base = src.replace(/[^/]+$/, "");
  const data = new Map(await Promise.all(files.map(async (f) => [f, await fileData(base + f)] as const)));
  const imageHref = (file: string) => data.get(file) ?? null;
  const under = splitHighlights(items);
  const highlights = items.slice(0, under).filter((i) => i.type === "highlighter");
  const rest = items.filter((i, index) => !(index < under && i.type === "highlighter"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (highlights.length) {
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(await svgImage(inkSvg(highlights, size)), 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
  }
  if (rest.length) ctx.drawImage(await svgImage(inkSvg(rest, size, { imageHref })), 0, 0, canvas.width, canvas.height);
}

// ---- drawings, kept per page, step and annotations ----

const BUDGET = 40_000_000; // pixels kept, about 160 MB at most
const kept = new Map<string, ImageBitmap | HTMLCanvasElement>();
let keptPixels = 0;
const pixels = (p: { width: number; height: number }) => p.width * p.height;
function keep(key: string, picture: ImageBitmap | HTMLCanvasElement) {
  const old = kept.get(key);
  if (old) {
    keptPixels -= pixels(old);
    kept.delete(key);
  }
  kept.set(key, picture);
  keptPixels += pixels(picture);
  // The least recently used go first.
  for (const [k, p] of kept) {
    if (keptPixels <= BUDGET || kept.size <= 1) break;
    kept.delete(k);
    keptPixels -= pixels(p);
    if ("close" in p) p.close();
  }
}
function keptPicture(key: string) {
  const picture = kept.get(key);
  if (picture) {
    // Used again: to the end of the queue.
    kept.delete(key);
    kept.set(key, picture);
  }
  return picture;
}
async function drawn(doc: PdfDocument, src: string, number: number, width: number, ink: InkItem[] | null, inkKey: string) {
  const key = `${src}|${number}|${width}|${inkKey}`;
  const found = keptPicture(key);
  if (found) return found;
  const aside = document.createElement("canvas");
  await renderPage(doc, number, aside, width, 1);
  if (!aside.width) throw new Error("render");
  if (ink?.length) {
    const page = await doc.getPage(number);
    const { width: w, height: h } = page.getViewport({ scale: 1 });
    try {
      await drawInk(aside, src, ink, { width: w, height: h });
    } catch {
      // The page without its ink rather than nothing.
    }
  }
  let picture: ImageBitmap | HTMLCanvasElement = aside;
  try {
    picture = await createImageBitmap(aside);
    aside.width = aside.height = 0;
  } catch {}
  keep(key, picture);
  return picture;
}

// The zoom, once it has stayed for a moment (no drawing during a pinch).
function useSettled(value: number, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, settled, delay]);
  return settled;
}
// Near the visible part of the screen (the board's transform included).
// Not near until the observer says so: a board opened zoomed in draws only
// the pages on screen sharp.
function useNearScreen(el: React.RefObject<Element | null>) {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = el.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: "200px" });
    io.observe(node);
    return () => io.disconnect();
  }, [el]);
  return near;
}

export function PdfBoardPage({ item, src, interactive }: { item: WhiteboardItem; src: string; interactive: boolean }) {
  const t = useT();
  const board = useBoard();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [count, setCount] = useState(pageCounts.get(src) || 0);
  const [failed, setFailed] = useState(false);
  const [aspect, setAspect] = useState(0);
  const [ink, setInk] = useState<Ink | null>(null);
  const [inkVersion, bumpInk] = useState(0);
  const page = currentPage(item, count);
  const pages = shownPages(item, count);
  const at = pages.indexOf(page);
  const zoom = useSettled(board?.zoom ?? 1);
  const near = useNearScreen(canvas);
  const showInk = !item.hideInk;
  // What is drawn now (to know whether a sharper drawing is needed).
  const shown = useRef<{ key: string; width: number } | null>(null);

  useEffect(() => {
    const listener = (changed: string) => changed === src && bumpInk((n) => n + 1);
    inkListeners.add(listener);
    return () => {
      inkListeners.delete(listener);
    };
  }, [src]);
  useEffect(() => {
    let alive = true;
    void loadInk(src).then((loaded) => alive && setInk(loaded));
    return () => {
      alive = false;
    };
  }, [src, inkVersion]);

  const box = { w: Math.max(1, item.w), h: Math.max(1, item.h - BAR) };
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  // Off screen: no sharper drawing than at 100 % (the exports need one).
  const width = pdfRenderWidth({ box, pageAspect: aspect, zoom: near ? zoom : Math.min(zoom, 1), dpr });
  const items = showInk && ink ? ink.doc.pages[String(page)] || [] : null;
  const inkKey = items?.length ? `ink${ink!.version}` : "plain";
  const key = `${page}|${inkKey}`;
  useEffect(() => {
    // Off screen with a drawing of this page already: kept as it is.
    if (!near && shown.current?.key === key) return;
    let alive = true;
    const timer = setTimeout(() => {
      loadPdf(src)
        .then(async (doc) => {
          if (!alive) return;
          pageCounts.set(src, doc.numPages);
          setCount(doc.numPages);
          const number = Math.min(page, doc.numPages);
          const viewport = (await doc.getPage(number)).getViewport({ scale: 1 });
          const pageAspect = viewport.width / Math.max(1, viewport.height);
          if (alive) setAspect(pageAspect);
          // The width for this page's own proportions.
          const exact = pdfRenderWidth({ box, pageAspect, zoom: near ? zoom : Math.min(zoom, 1), dpr });
          if (shown.current?.key === key && shown.current.width === exact) return;
          const picture = await drawn(doc, src, number, exact, items, `${inkKey}`);
          const el = canvas.current;
          if (!alive || !el) return;
          el.width = picture.width;
          el.height = picture.height;
          el.getContext("2d")?.drawImage(picture, 0, 0);
          el.dataset.drawn = String(exact);
          shown.current = { key, width: exact };
        })
        .catch(() => alive && setFailed(true));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `box` and `items` follow from the keys below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, key, width, near]);

  const label = count > 0 && pages.length < count ? `${page} · ${at + 1}/${pages.length}` : `${page}/${count}`;
  const editable = !!board?.editable && interactive;
  return (
    <div className="wb-pdf">
      <div className="wb-embed-bar">
        <FilePdf size={14} />
        <span title={item.text || "PDF"}>{item.text || "PDF"}</span>
        {editable && hasAnyInk(ink) && (
          <button
            type="button"
            className="wb-pdf-ink"
            data-wb-pdf="ink"
            aria-pressed={showInk}
            aria-label={showInk ? t("Anmerkungen ausblenden", "Hide annotations") : t("Anmerkungen einblenden", "Show annotations")}
            title={showInk ? t("Anmerkungen ausblenden", "Hide annotations") : t("Anmerkungen einblenden", "Show annotations")}
          >
            <Highlighter size={12} weight={showInk ? "fill" : "regular"} />
          </button>
        )}
        {interactive && pages.length > 1 && (
          <span className="wb-pdf-nav">
            <button type="button" data-wb-pdf="prev" disabled={at <= 0} aria-label={t("Vorherige Seite", "Previous page")}>
              <CaretLeft size={12} />
            </button>
            <span title={t(`Seite ${page} von ${count}`, `Page ${page} of ${count}`)}>{label}</span>
            <button type="button" data-wb-pdf="next" disabled={at >= pages.length - 1} aria-label={t("Nächste Seite", "Next page")}>
              <CaretRight size={12} />
            </button>
          </span>
        )}
      </div>
      {failed ? (
        <p className="wb-pdf-failed">{t("PDF nicht verfügbar", "PDF not available")}</p>
      ) : (
        <canvas
          ref={canvas}
          className="wb-pdf-page"
          aria-label={t(`Seite ${page} von ${item.text || "PDF"}`, `Page ${page} of ${item.text || "PDF"}`)}
        />
      )}
    </div>
  );
}
