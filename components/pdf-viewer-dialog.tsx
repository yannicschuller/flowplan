"use client";
// The PDF viewer (opened by openPdf() through PdfViewerHost in
// pdf-viewer.tsx): all pages, zoom, download, and – for who may edit the page
// the file belongs to – writing on the PDF with the ink engine
// (components/ink, lib/ink/README.md). Loaded on first use.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOut,
  Cards,
  DownloadSimple,
  FileArrowDown,
  FilePdf,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimpleLine,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { useInkShortcuts } from "./ink/use-ink-editor";
import { loadPdf, type PdfDocument } from "./pdf-viewer";
import { AnnotateBar, currentPageOf, PdfNotice, scrollToPage, usePdfAnnotations, ViewerPage } from "./pdf-annotations";
import { stepZoom } from "@/lib/pinch-zoom";
import { usePinchZoom } from "./notebook/use-pinch-zoom";
import { shortcutLetter } from "@/lib/keymap";

// "Lernkarten erstellen" (#342): the AI flashcards dialog of the workspace
// (components/study/ai-cards.tsx, opened by its event) with this PDF and
// the page shown as the source – the range can be changed there. Offered
// when the workspace says the feature is usable (it answers the probe
// event synchronously) and the PDF is a file of the workspace (not a
// shared link's).
function flashcardsAvailable() {
  const probe = { available: false };
  window.dispatchEvent(new CustomEvent("flowplan:flashcards-ai-probe", { detail: probe }));
  return probe.available;
}
const fileIdOf = (src: string) => /^\/api\/files\/([\w-]+)$/.exec(src)?.[1] || null;

// Zoom of the pages, relative to the window width: buttons and keys step,
// two fingers and trackpads zoom freely (as in notebooks).
const ZOOMS = { min: 0.5, max: 3, step: 0.25 };

export default function PdfViewerDialog({ src, title, page: startPage, onClose }: { src: string; title: string; page?: number; onClose: () => void }) {
  const t = useT();
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(800);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  // Ink on the PDF (pdf-annotations.tsx): loaded with the viewer, editable
  // for who may edit the page the file belongs to.
  const [annotating, setAnnotating] = useState(false);
  const ann = usePdfAnnotations(src, title, annotating);
  const { editor, ink, save, notice, setNotice } = ann;
  const [cards, setCards] = useState(false);
  useEffect(() => setCards(!!fileIdOf(src) && flashcardsAvailable()), [src]);
  useInkShortcuts(editor, annotating);
  async function finish() {
    if (editor.dirty && !(await save())) return;
    editor.setSelection(null);
    setAnnotating(false);
  }
  async function close() {
    if (annotating && editor.dirty && !(await save())) return;
    setAnnotating(false);
    onClose();
  }
  // The viewer closes (ink saved first) and the dialog opens over the page.
  async function createCards() {
    const fileId = fileIdOf(src);
    if (!fileId) return;
    if (annotating && editor.dirty && !(await save())) return;
    const pages = { from: current, to: current };
    onClose();
    window.dispatchEvent(new CustomEvent("flowplan:flashcards-ai", { detail: { file: { id: fileId, name: title || "PDF", pages } } }));
  }
  const closeRef = useRef(close);
  closeRef.current = close;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let alive = true;
    loadPdf(src)
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setError(true));
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") void closeRef.current();
      if ((event.metaKey || event.ctrlKey) && shortcutLetter(event) === "s") {
        event.preventDefault();
        void saveRef.current();
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setZoom((z) => stepZoom(z, 1, ZOOMS.step, ZOOMS));
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        setZoom((z) => stepZoom(z, -1, ZOOMS.step, ZOOMS));
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
  }, [src]);
  // Pages fit the window width (at most 900 px), times the zoom.
  useEffect(() => {
    const measure = () => setFitWidth(Math.min(900, (scroller.current?.clientWidth || window.innerWidth) - 32));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const onScroll = useCallback(() => setCurrent(currentPageOf(scroller.current)), []);
  // Opened at a page (a link to it, #392): there once the pages are laid out.
  useEffect(() => {
    if (!doc || !startPage || startPage < 2) return;
    const frame = requestAnimationFrame(() => scrollToPage(scroller.current, Math.min(startPage, doc.numPages)));
    return () => cancelAnimationFrame(frame);
  }, [doc, startPage]);
  // Two fingers (also while the pen draws, pen-only or not) and trackpads
  // zoom anchored where they pinch, and two fingers pan (use-pinch-zoom.ts).
  const pagesBox = useRef<HTMLDivElement>(null);
  usePinchZoom({ scroller, content: pagesBox, sheetSelector: ".pdf-page-wrap", zoom, setZoom, limits: ZOOMS });
  const width = Math.round(fitWidth * zoom);
  const { annotated, exporting, pageInk } = ann;
  return (
    <div className={`pdf-viewer${annotating ? " is-annotating" : ""}`} role="dialog" aria-modal="true" aria-label={title || "PDF"}>
      <header className="pdf-viewer-bar">
        <FilePdf size={20} />
        <strong title={title}>{title || "PDF"}</strong>
        {doc && (
          <span className="pdf-viewer-pages">
            {t(`Seite ${current} von ${doc.numPages}`, `Page ${current} of ${doc.numPages}`)}
          </span>
        )}
        <span className="pdf-viewer-actions">
          {ink?.canEdit && doc && !annotating && (
            <button type="button" className="pdf-viewer-annotate" onClick={() => setAnnotating(true)} title={t("Mit Stift, Textmarker und Text anmerken", "Mark up with pen, highlighter and text")}>
              <PencilSimpleLine size={18} />
              <span>{t("Anmerken", "Annotate")}</span>
            </button>
          )}
          {cards && doc && !annotating && (
            <button
              type="button"
              className="pdf-viewer-annotate pdf-viewer-cards"
              onClick={() => void createCards()}
              aria-label={t("Lernkarten erstellen", "Create flashcards")}
              title={t(`Lernkarten mit KI aus Seite ${current} oder weiteren Seiten erstellen`, `Create flashcards with AI from page ${current} or more pages`)}
            >
              <Cards size={18} />
              <span>{t("Lernkarten erstellen", "Create flashcards")}</span>
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out")} onClick={() => setZoom((z) => stepZoom(z, -1, ZOOMS.step, ZOOMS))}>
            <MagnifyingGlassMinus size={18} />
          </button>
          <span className="pdf-viewer-zoom">{Math.round(zoom * 100)} %</span>
          <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in")} onClick={() => setZoom((z) => stepZoom(z, 1, ZOOMS.step, ZOOMS))}>
            <MagnifyingGlassPlus size={18} />
          </button>
          <button type="button" className="icon-button pdf-viewer-fit" aria-label={t("An Breite anpassen", "Fit to width")} title={t("An Breite anpassen", "Fit to width")} onClick={() => setZoom(1)}>
            <ArrowsOut size={18} />
          </button>
          <a className="icon-button" href={src} download={title || "document.pdf"} aria-label={t("Herunterladen", "Download")} title={t("Original herunterladen", "Download the original")}>
            <DownloadSimple size={18} />
          </a>
          {annotated && (
            <button
              type="button"
              className="icon-button"
              aria-label={t("Mit Anmerkungen herunterladen", "Download with annotations")}
              title={t("Mit Anmerkungen herunterladen", "Download with annotations")}
              disabled={exporting}
              onClick={() => void ann.downloadAnnotated()}
            >
              <FileArrowDown size={18} />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={() => void close()}>
            <X size={18} />
          </button>
        </span>
      </header>
      {annotating && <AnnotateBar ann={ann} onDone={() => void finish()} />}
      <PdfNotice notice={notice} onDismiss={() => setNotice(null)} />
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
          <div className="pdf-viewer-sheets" ref={pagesBox}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <ViewerPage key={i} doc={doc} number={i + 1} width={width} ink={pageInk} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
