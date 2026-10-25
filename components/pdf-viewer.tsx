"use client";
// PDF preview and viewer, rendered with pdf.js in the browser (the file is
// fetched like a download and drawn onto canvases – the browser's own PDF
// plug-in never runs). openPdf() opens the viewer from anywhere; the host is
// mounted once in the root layout and loads the viewer (pdf-viewer-dialog.tsx)
// when a PDF is opened. PdfThumbnail draws the first page.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { loadView } from "@/components/view-fallback";
import { FilePdf } from "@phosphor-icons/react";
import { canvasSize } from "@/lib/ink/coords";

export type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
// The viewer itself (pages, zoom, annotating) loads on first use.
const PdfViewerDialog = lazy(() => loadView(() => import("./pdf-viewer-dialog")));
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

export function PdfViewerHost() {
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
  const [open, setOpen] = useState<{ src: string; title: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const show = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; title: string }>).detail;
      if (!fileLink.test(detail?.src || "")) return;
      // A new viewer each time (fresh zoom, page and ink).
      setOpen({ src: detail.src, title: detail.title, n: ++n });
    };
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <PdfViewerDialog key={open.n} src={open.src} title={open.title} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
