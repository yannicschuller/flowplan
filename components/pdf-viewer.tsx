"use client";
// PDF preview and viewer, rendered with pdf.js in the browser (the file is
// fetched like a download and drawn onto canvases – the browser's own PDF
// plug-in never runs). openPdf() opens the viewer from anywhere; the host is
// mounted once in the root layout and loads the viewer (pdf-viewer-dialog.tsx)
// when a PDF is opened. PdfThumbnail draws the first page.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { ArrowsOut, FilePdf, SidebarSimple } from "@phosphor-icons/react";
import { ContextMenu } from "./context-menu";
import { useT } from "./i18n";
import { canvasSize } from "@/lib/ink/coords";

export type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
// The viewer itself (pages, zoom, annotating) loads on first use, as does
// the side panel (pdf-panel.tsx, #392).
const PdfViewerDialog = lazy(() => loadView(() => import("./pdf-viewer-dialog")));
const PdfPanel = lazy(() => loadView(() => import("./pdf-panel")));
const EVENT = "flowplan:pdf";
const PANEL_EVENT = "flowplan:pdf-panel";

export function openPdf(src: string, title: string, page?: number) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title, page } }));
}
// "Im Seitenfenster öffnen": the PDF beside the page (in the app's shell;
// elsewhere the viewer opens), at `page` when given.
export function openPdfPanel(src: string, title: string, page?: number) {
  window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: { src, title, page } }));
}
// Whether the side panel can open here (the app's shell has its place).
export const pdfPanelAvailable = () => typeof document !== "undefined" && !!document.getElementById("side-dock-root");
// A link or file name that points at a PDF in Flowplan.
export const isPdfName = (name: string) => /\.pdf$/i.test(name.trim());

let library: Promise<typeof import("pdfjs-dist")> | null = null;
function pdfjs() {
  // Only in the browser. The server's build drops this branch
  // (`typeof window` is known there): it would otherwise resolve pdf.js and
  // its worker against the server's external pdfjs-dist ("can't be
  // external"), for a render that never loads them.
  if (typeof window !== "undefined")
    library ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerPort = new Worker(
        new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
        { type: "module" },
      );
      return lib as unknown as typeof import("pdfjs-dist");
    });
  return library ?? Promise.reject(new Error("pdf.js runs in the browser only."));
}
// One loaded document per file, shared by previews and the viewer.
const documents = new Map<string, Promise<PdfDocument>>();
export function loadPdf(src: string) {
  let doc = documents.get(src);
  if (!doc) {
    doc = (async () => {
      const response = await fetch(src, { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const data = new Uint8Array(await response.arrayBuffer());
      const lib = await pdfjs();
      return lib.getDocument({
        data,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
      }).promise;
    })();
    doc.catch(() => documents.delete(src));
    documents.set(src, doc);
  }
  return doc;
}
// The text layer of pages `from`–`to` (within the document), a paragraph
// break between pages – for flashcards from a page range
// (components/study/ai-cards.tsx). Scans without a text layer give "".
export async function pdfPagesText(src: string, from: number, to: number) {
  const doc = await loadPdf(src);
  const first = Math.max(1, Math.min(from, to, doc.numPages)),
    last = Math.min(doc.numPages, Math.max(from, to));
  const pages: string[] = [];
  for (let n = first; n <= last; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push(text.replace(/[ \t]+\n/g, "\n").trim());
  }
  return { text: pages.filter(Boolean).join("\n\n"), from: first, to: last, total: doc.numPages };
}
export const pdfPageCount = async (src: string) => (await loadPdf(src)).numPages;
// A canvas draws one page at a time: a new size (zoom) cancels the
// drawing still in progress.
const drawing = new WeakMap<HTMLCanvasElement, { cancel: () => void }>();
export async function renderPage(doc: PdfDocument, number: number, canvas: HTMLCanvasElement, width: number) {
  drawing.get(canvas)?.cancel();
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const size = canvasSize(base, width, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: size.scale });
  drawing.get(canvas)?.cancel();
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.aspectRatio = `${base.width} / ${base.height}`;
  const task = page.render({ canvas, viewport });
  drawing.set(canvas, task);
  try {
    await task.promise;
  } catch (error) {
    if ((error as Error)?.name !== "RenderingCancelledException") throw error;
  } finally {
    if (drawing.get(canvas) === task) drawing.delete(canvas);
  }
}

// The first page as a small preview.
export function PdfThumbnail({ src, width = 220 }: { src: string; width?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadPdf(src)
      .then((doc) => {
        if (alive && canvas.current) return renderPage(doc, 1, canvas.current, width);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [src, width]);
  return failed ? <FilePdf size={40} className="pdf-thumb-fallback" /> : <canvas ref={canvas} className="pdf-thumb" />;
}

export const fileLink = /^\/api\/(files\/[\w-]+|share\/[\w-]+\/files\/[\w-]+)$/;
// Static PDF blocks (read-only pages, published pages) get their preview.
function decorate(root: ParentNode) {
  for (const block of root.querySelectorAll<HTMLElement>(".pdf-block[data-pdf]:not([data-ready])")) {
    if (block.closest(".ProseMirror")) continue;
    block.dataset.ready = "true";
    const src = block.dataset.pdf || "";
    if (!fileLink.test(src)) continue;
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-thumb";
    block.prepend(canvas);
    loadPdf(src)
      .then((doc) => renderPage(doc, 1, canvas, 260))
      .catch(() => canvas.remove());
  }
}

// The PDF a right-click or a long press is on: a PDF card (editor, read-only
// page), a link to a PDF in Flowplan, a file of the media library or a hit
// of the search ([data-pdf-src]).
function pdfAt(target: EventTarget | null): { src: string; title: string; element: HTMLElement } | null {
  const el = (target as Element | null)?.closest?.<HTMLElement>(".pdf-block[data-pdf], [data-pdf-src], a[href]");
  if (!el) return null;
  if (el.matches(".pdf-block")) return fileLink.test(el.dataset.pdf || "") ? { src: el.dataset.pdf!, title: el.dataset.title || "PDF", element: el } : null;
  if (el.dataset.pdfSrc) return fileLink.test(el.dataset.pdfSrc) ? { src: el.dataset.pdfSrc, title: el.dataset.pdf || "PDF", element: el } : null;
  const href = el.getAttribute("href") || "";
  const title = el.dataset.pdf || el.textContent?.trim() || "";
  return fileLink.test(href) && (el.dataset.pdf || isPdfName(title)) ? { src: href, title: title || "PDF", element: el } : null;
}

export function PdfViewerHost() {
  const t = useT();
  // "Im Seitenfenster öffnen" (#392): right-click, the context menu key or
  // a long press on a PDF – where the side panel can open (the app).
  const [menu, setMenu] = useState<{ x: number; y: number; src: string; title: string } | null>(null);
  useEffect(() => {
    const show = (found: ReturnType<typeof pdfAt>, x: number, y: number) => {
      if (!found) return false;
      // From the keyboard there is no pointer: next to the element.
      if (!x && !y) {
        const rect = found.element.getBoundingClientRect();
        x = rect.left + 12;
        y = rect.top + Math.min(rect.height, 40);
      }
      setMenu({ x, y, src: found.src, title: found.title });
      return true;
    };
    const context = (event: MouseEvent) => {
      if (event.defaultPrevented || !pdfPanelAvailable()) return;
      if (show(pdfAt(event.target), event.clientX, event.clientY)) event.preventDefault();
    };
    // Touch: held still for half a second; the click after it is dropped.
    let press: { id: number; x: number; y: number; timer: number } | null = null,
      swallow: { at: number; element: HTMLElement } | null = null;
    const cancel = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    const down = (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== "touch" || !pdfPanelAvailable()) return;
      const found = pdfAt(event.target);
      if (!found) return;
      const { clientX: x, clientY: y } = event;
      press = { id: event.pointerId, x, y, timer: window.setTimeout(() => {
        press = null;
        if (show(found, x, y)) swallow = { at: Date.now(), element: found.element };
      }, 550) };
    };
    const move = (event: PointerEvent) => {
      if (press && press.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancel();
    };
    // Only the click the held finger lets go on – not a tap in the menu.
    const click = (event: MouseEvent) => {
      const held = swallow;
      swallow = null;
      if (!held || Date.now() - held.at > 1500 || !held.element.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("contextmenu", context);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", cancel, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("click", click, true);
    return () => {
      cancel();
      document.removeEventListener("contextmenu", context);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", cancel, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("click", click, true);
    };
  }, []);
  // Links to PDFs in Flowplan open the viewer instead of downloading.
  // In text being edited only with ⌘/Ctrl, so clicking still places the caret.
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      const block = link.closest<HTMLElement>(".pdf-block");
      // A link to a page of a PDF (the caption of a region taken from the
      // side panel, #392): the panel at that page.
      const [file, hash = ""] = href.split("#");
      const page = /^pdf-page=(\d{1,6})$/.exec(hash)?.[1];
      if (page && fileLink.test(file)) {
        // Also in text being edited (like other links there).
        event.preventDefault();
        openPdfPanel(file, link.dataset.pdf || pdfTitleOf(link.textContent || ""), Number(page));
        return;
      }
      const title = link.dataset.pdf || block?.dataset.title || link.textContent?.trim() || "PDF";
      if (!fileLink.test(href) || !(link.dataset.pdf || block || isPdfName(title))) return;
      if (link.closest("[contenteditable=true]") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      openPdf(href, title);
    };
    document.addEventListener("click", click, true);
    decorate(document);
    // Only added content that brings a PDF block along (not every edit).
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && (node.matches(".pdf-block") || node.querySelector(".pdf-block"))) {
            decorate(document);
            return;
          }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("click", click, true);
      observer.disconnect();
    };
  }, []);
  const [open, setOpen] = useState<{ src: string; title: string; page?: number; n: number } | null>(null);
  // The side panel: kept while it is open, with the PDF it shows (another
  // one replaces it, the same one goes to the page asked for).
  const [panel, setPanel] = useState<{ src: string; title: string; page?: number; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    type Detail = { src: string; title: string; page?: number };
    const show = (event: Event) => {
      const detail = (event as CustomEvent<Detail>).detail;
      if (!fileLink.test(detail?.src || "")) return;
      // A new viewer each time (fresh zoom, page and ink).
      setOpen({ src: detail.src, title: detail.title, page: detail.page, n: ++n });
    };
    const side = (event: Event) => {
      const detail = (event as CustomEvent<Detail>).detail;
      if (!fileLink.test(detail?.src || "")) return;
      if (!pdfPanelAvailable()) return setOpen({ src: detail.src, title: detail.title, page: detail.page, n: ++n });
      setPanel({ src: detail.src, title: detail.title || "PDF", page: detail.page, n: ++n });
    };
    window.addEventListener(EVENT, show);
    window.addEventListener(PANEL_EVENT, side);
    return () => {
      window.removeEventListener(EVENT, show);
      window.removeEventListener(PANEL_EVENT, side);
    };
  }, []);
  return (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.title}
          onClose={() => setMenu(null)}
          items={[
            { icon: <SidebarSimple />, label: t("Im Seitenfenster öffnen", "Open in side panel"), run: () => openPdfPanel(menu.src, menu.title) },
            { icon: <ArrowsOut />, label: t("Im PDF-Viewer öffnen", "Open in the PDF viewer"), run: () => openPdf(menu.src, menu.title) },
          ]}
        />
      )}
      {panel && (
        <Suspense fallback={null}>
          <PdfPanel src={panel.src} title={panel.title} page={panel.page} request={panel.n} onClose={() => setPanel(null)} />
        </Suspense>
      )}
      {open && (
        <Suspense fallback={null}>
          <PdfViewerDialog key={open.n} src={open.src} title={open.title} page={open.page} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </>
  );
}
// The PDF's name from a caption "Name.pdf, S. 3" / "Name.pdf, p. 3".
const pdfTitleOf = (caption: string) => caption.trim().replace(/,\s*\S+\s*\d+\s*$/, "") || "PDF";
