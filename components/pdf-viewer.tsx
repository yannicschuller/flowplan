"use client";
// PDF preview and viewer, rendered with pdf.js in the browser (the file is
// fetched like a download and drawn onto canvases – the browser's own PDF
// plug-in never runs). openPdf() opens the viewer from anywhere; the host is
// mounted once in the root layout. PdfThumbnail draws the first page.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsOut, DownloadSimple, FilePdf, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "@phosphor-icons/react";
import { useT } from "./i18n";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
const EVENT = "flowplan:pdf";

export function openPdf(src: string, title: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { src, title } }));
}
// A link or file name that points at a PDF in Flowplan.
export const isPdfName = (name: string) => /\.pdf$/i.test(name.trim());

let library: Promise<typeof import("pdfjs-dist")> | null = null;
function pdfjs() {
  library ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerPort = new Worker(
      new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
      { type: "module" },
    );
    return lib as unknown as typeof import("pdfjs-dist");
  });
  return library;
}
// One loaded document per file, shared by previews and the viewer.
const documents = new Map<string, Promise<PdfDocument>>();
function loadPdf(src: string) {
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
// A canvas draws one page at a time: a new size (zoom) cancels the
// drawing still in progress.
const drawing = new WeakMap<HTMLCanvasElement, { cancel: () => void }>();
async function renderPage(doc: PdfDocument, number: number, canvas: HTMLCanvasElement, width: number) {
  drawing.get(canvas)?.cancel();
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  drawing.get(canvas)?.cancel();
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
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

// One page of the viewer; drawn once it comes near the visible area.
function ViewerPage({ doc, number, width }: { doc: PdfDocument; number: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  useEffect(() => {
    const el = canvas.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  useEffect(() => {
    if (visible && canvas.current) renderPage(doc, number, canvas.current, width).catch(() => {});
  }, [doc, number, width, visible]);
  return <canvas ref={canvas} className="pdf-page" data-page={number} style={{ width }} />;
}

const fileLink = /^\/api\/(files\/[\w-]+|share\/[\w-]+\/files\/[\w-]+)$/;
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

export function PdfViewerHost() {
  const t = useT();
  // Links to PDFs in Flowplan open the viewer instead of downloading.
  // In text being edited only with ⌘/Ctrl, so clicking still places the caret.
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href") || "";
      const block = link.closest<HTMLElement>(".pdf-block");
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
  const [open, setOpen] = useState<{ src: string; title: string } | null>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(800);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      if (!fileLink.test(detail?.src || "")) return;
      setOpen(detail);
      setDoc(null);
      setError(false);
      setZoom(1);
      setCurrent(1);
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadPdf(open.src)
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setError(true));
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setZoom((z) => Math.min(3, z + 0.25));
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        setZoom((z) => Math.max(0.5, z - 0.25));
      }
    };
    document.addEventListener("keydown", key);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      alive = false;
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previous;
    };
  }, [open]);
  // Pages fit the window width (at most 900 px), times the zoom.
  useEffect(() => {
    if (!open) return;
    const measure = () => setFitWidth(Math.min(900, (scroller.current?.clientWidth || window.innerWidth) - 32));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const pages = [...el.querySelectorAll<HTMLElement>(".pdf-page")];
    const middle = el.scrollTop + el.clientHeight / 3;
    const page = pages.findLast((p) => p.offsetTop <= middle);
    setCurrent(Number(page?.dataset.page || 1));
  }, []);
  if (!open) return null;
  const width = Math.round(fitWidth * zoom);
  return (
    <div className="pdf-viewer" role="dialog" aria-modal="true" aria-label={open.title || "PDF"}>
      <header className="pdf-viewer-bar">
        <FilePdf size={20} />
        <strong title={open.title}>{open.title || "PDF"}</strong>
        {doc && (
          <span className="pdf-viewer-pages">
            {t(`Seite ${current} von ${doc.numPages}`, `Page ${current} of ${doc.numPages}`)}
          </span>
        )}
        <span className="pdf-viewer-actions">
          <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
            <MagnifyingGlassMinus size={18} />
          </button>
          <span className="pdf-viewer-zoom">{Math.round(zoom * 100)} %</span>
          <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in")} onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
            <MagnifyingGlassPlus size={18} />
          </button>
          <button type="button" className="icon-button" aria-label={t("An Breite anpassen", "Fit to width")} title={t("An Breite anpassen", "Fit to width")} onClick={() => setZoom(1)}>
            <ArrowsOut size={18} />
          </button>
          <a className="icon-button" href={open.src} download={open.title || "document.pdf"} aria-label={t("Herunterladen", "Download")} title={t("Herunterladen", "Download")}>
            <DownloadSimple size={18} />
          </a>
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={() => setOpen(null)}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pdf-viewer-pages-area" ref={scroller} onScroll={onScroll}>
        {error ? (
          <p className="pdf-viewer-message" role="alert">
            {t("Das PDF ließ sich nicht anzeigen. Du kannst es herunterladen.", "The PDF could not be shown. You can download it.")}
          </p>
        ) : !doc ? (
          <p className="pdf-viewer-message" role="status">
            {t("PDF wird geladen …", "Loading PDF …")}
          </p>
        ) : (
          Array.from({ length: doc.numPages }, (_, i) => <ViewerPage key={i} doc={doc} number={i + 1} width={width} />)
        )}
      </div>
    </div>
  );
}
