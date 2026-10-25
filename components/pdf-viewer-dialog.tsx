"use client";
// The PDF viewer (opened by openPdf() through PdfViewerHost in
// pdf-viewer.tsx): all pages, zoom, download, and – for who may edit the page
// the file belongs to – writing on the PDF with the ink engine
// (components/ink, lib/ink/README.md). Loaded on first use.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsOut,
  Check,
  ClockCounterClockwise,
  DownloadSimple,
  FileArrowDown,
  FilePdf,
  FloppyDisk,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimpleLine,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, downloadBlob } from "./ui";
import { InkLayer } from "./ink/ink-layer";
import { InkToolbar } from "./ink/ink-toolbar";
import { useInkEditor, useInkShortcuts, type InkEditor } from "./ink/use-ink-editor";
import type { PageSize } from "@/lib/ink/coords";
import { emptyInk, hasInk, parseInk, type InkDoc } from "@/lib/ink/model";
import { loadPdf, renderPage, type PdfDocument } from "./pdf-viewer";
import { convertSelection } from "./ink/convert";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { recognitionAvailable, recognitionId, recognitionRequest, recognizeInk } from "@/lib/ink/recognition";

// What the pages need to show ink and, while annotating, to take it.
type PageInk = {
  editor: InkEditor;
  editing: boolean;
  show: boolean;
  onPan: (dx: number, dy: number) => void;
  onZoom: (factor: number) => void;
  // The size of a page once known (recognition needs it).
  onSize: (page: string, size: PageSize) => void;
  // "Convert to text" where the device recognises handwriting.
  convert?: (size: PageSize) => void;
};
// One page of the viewer; drawn once it comes near the visible area. The
// ink lies over it in page units (PDF points), whatever the zoom.
function ViewerPage({ doc, number, width, ink }: { doc: PdfDocument; number: number; width: number; ink: PageInk }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [size, setSize] = useState<PageSize | null>(null);
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
  // The page size (for the ink) once the page comes near: large PDFs do
  // not load every page up front.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    doc
      .getPage(number)
      .then((page) => {
        const { width: w, height: h } = page.getViewport({ scale: 1 });
        if (alive) {
          setSize({ width: w, height: h });
          ink.onSize(String(number), { width: w, height: h });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [doc, number, visible]);
  return (
    <div className="pdf-page-wrap" data-page={number} style={{ width }}>
      <canvas ref={canvas} className="pdf-page" data-page={number} style={{ width, aspectRatio: size ? `${size.width} / ${size.height}` : undefined }} />
      {size && ink.show && (
        <InkLayer
          page={String(number)}
          size={size}
          editor={ink.editor}
          editing={ink.editing}
          onPan={ink.onPan}
          onZoom={ink.onZoom}
          onConvert={ink.convert ? () => ink.convert!(size) : undefined}
        />
      )}
    </div>
  );
}

export default function PdfViewerDialog({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(800);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  // Ink on the PDF (lib/ink-store.ts): loaded with the viewer, editable for
  // who may edit the page the file belongs to.
  const [ink, setInk] = useState<{ version: number; canEdit: boolean } | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [versions, setVersions] = useState<{ version: number; by: string | null; at: number; items: number }[] | null>(null);
  const editor = useInkEditor(emptyInk(), { active: annotating });
  useInkShortcuts(editor, annotating);
  const inkUrl = `${src}/ink`;
  const { reset } = editor;
  useEffect(() => {
    let alive = true;
    api<{ doc: InkDoc; version: number; canEdit: boolean }>(inkUrl)
      .then((data) => {
        if (!alive) return;
        reset(parseInk(data.doc));
        setInk({ version: data.version, canEdit: data.canEdit });
      })
      // Without ink (older server, no access to it) the PDF still shows.
      .catch(() => alive && setInk({ version: 0, canEdit: false }));
    return () => {
      alive = false;
    };
  }, [inkUrl, reset]);

  // Saves the ink as a new version; true when saved.
  async function save(): Promise<boolean> {
    if (!ink) return false;
    const snapshot = editor.docRef.current;
    setSaving(true);
    try {
      const result = await api<{ version: number; conflict: { by: string | null; at: number; version: number } | null }>(inkUrl, {
        base: ink.version,
        doc: snapshot,
      });
      setInk((now) => (now ? { ...now, version: result.version } : now));
      editor.markSaved(snapshot);
      void recognizeSaved(snapshot, result.version);
      setVersions(null);
      if (result.conflict) {
        const by = result.conflict.by || t("Jemand", "Someone");
        setNotice({
          text: t(
            `${by} hat die Anmerkungen inzwischen ebenfalls geändert. Deine Fassung ist gespeichert; die andere findest du unter „Versionen“.`,
            `${by} changed the annotations in the meantime as well. Your version is saved; the other one is under “Versions”.`,
          ),
        });
      } else setNotice(null);
      return true;
    } catch (e) {
      setNotice({ text: (e as Error).message || t("Die Anmerkungen konnten nicht gespeichert werden.", "The annotations could not be saved."), error: true });
      return false;
    } finally {
      setSaving(false);
    }
  }
  // In the app: the handwriting of changed pages recognised on the device,
  // its text saved with the ink for search (lib/ink/recognition.ts).
  const sizes = useRef(new Map<string, PageSize>());
  const recognised = useRef(new Map<string, unknown>());
  async function recognizeSaved(snapshot: InkDoc, version: number) {
    if (!recognitionAvailable()) return;
    const texts: Record<string, string> = {};
    for (const [page, items] of Object.entries(snapshot.pages)) {
      const size = sizes.current.get(page);
      if (!size || recognised.current.get(page) === items) continue;
      const request = recognitionRequest(recognitionId("search"), size, items);
      if (!request) continue;
      const result = await recognizeInk(request);
      if (!result) continue;
      recognised.current.set(page, items);
      texts[page] = result.text;
    }
    if (!Object.keys(texts).length) return;
    try {
      await api(inkUrl, { version, recognized: texts });
    } catch {}
  }
  const [canRecognize, setCanRecognize] = useState(false);
  useEffect(() => setCanRecognize(recognitionAvailable()), []);
  async function convert(size: PageSize) {
    const result = await convertSelection(editor, size);
    if (result === "empty") setNotice({ text: t("In der Auswahl wurde kein Text erkannt.", "No text was recognised in the selection.") });
    if (result === "failed") setNotice({ text: t("Die Handschrift konnte nicht erkannt werden.", "The handwriting could not be recognised."), error: true });
  }
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
  const closeRef = useRef(close);
  closeRef.current = close;
  const saveRef = useRef(save);
  saveRef.current = save;
  async function showVersions() {
    if (versions) return setVersions(null);
    try {
      const data = await api<{ versions: { version: number; by: string | null; at: number; items: number }[] }>(`${inkUrl}?versions=1`);
      setVersions(data.versions);
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  }
  async function loadVersion(version: number) {
    setVersions(null);
    try {
      const data = await api<{ doc: InkDoc }>(`${inkUrl}?version=${version}`);
      editor.commit(parseInk(data.doc));
      setNotice({ text: t(`Version ${version} geladen. Speichern stellt sie wieder her.`, `Version ${version} loaded. Saving restores it.`) });
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  }
  // The PDF with the ink drawn into it (vectors, original pages).
  async function downloadAnnotated() {
    setExporting(true);
    try {
      const response = await fetch(src, { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const { flattenInk } = await import("@/lib/ink/pdf-export");
      const bytes = await flattenInk(new Uint8Array(await response.arrayBuffer()), editor.docRef.current);
      const base = (title || "document.pdf").replace(/\.pdf$/i, "");
      downloadBlob(`${base} (${t("mit Anmerkungen", "annotated")}).pdf`, new Blob([bytes as BlobPart], { type: "application/pdf" }));
    } catch (e) {
      setNotice({
        text:
          (e as Error).message === "encrypted"
            ? t("Dieses PDF ist geschützt; es lässt sich nur ohne Anmerkungen herunterladen.", "This PDF is protected; it can only be downloaded without annotations.")
            : t("Das PDF mit Anmerkungen konnte nicht erstellt werden.", "The PDF with annotations could not be created."),
        error: true,
      });
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    let alive = true;
    loadPdf(src)
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setError(true));
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") void closeRef.current();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
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
  }, [src]);
  // Unsaved ink is not lost by closing the tab unnoticed.
  const dirty = annotating && editor.dirty;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // Pages fit the window width (at most 900 px), times the zoom.
  useEffect(() => {
    const measure = () => setFitWidth(Math.min(900, (scroller.current?.clientWidth || window.innerWidth) - 32));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const pages = [...el.querySelectorAll<HTMLElement>(".pdf-page-wrap")];
    const middle = el.scrollTop + el.clientHeight / 3;
    const page = pages.findLast((p) => p.offsetTop <= middle);
    setCurrent(Number(page?.dataset.page || 1));
  }, []);
  const onPan = useCallback((dx: number, dy: number) => scroller.current?.scrollBy(dx, dy), []);
  const onZoom = useCallback((factor: number) => setZoom((z) => Math.min(3, Math.max(0.5, Math.round(z * factor * 4) / 4))), []);
  const width = Math.round(fitWidth * zoom);
  const annotated = hasInk(editor.doc);
  const onSize = useCallback((page: string, size: PageSize) => void sizes.current.set(page, size), []);
  const pageInk: PageInk = { editor, editing: annotating, show: !!ink, onPan, onZoom, onSize, convert: annotating && canRecognize ? (size) => void convert(size) : undefined };
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
          <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
            <MagnifyingGlassMinus size={18} />
          </button>
          <span className="pdf-viewer-zoom">{Math.round(zoom * 100)} %</span>
          <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in")} onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
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
              onClick={() => void downloadAnnotated()}
            >
              <FileArrowDown size={18} />
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")} onClick={() => void close()}>
            <X size={18} />
          </button>
        </span>
      </header>
      {annotating && (
        <InkToolbar editor={editor}>
          <span className="ink-status" role="status">
            {saving ? t("Wird gespeichert …", "Saving …") : editor.dirty ? t("Nicht gespeichert", "Not saved") : t("Gespeichert", "Saved")}
          </span>
          <div className="ink-menu-anchor">
            <button type="button" aria-label={t("Versionen", "Versions")} title={t("Versionen", "Versions")} aria-expanded={!!versions} onClick={() => void showVersions()}>
              <ClockCounterClockwise size={19} />
            </button>
            {versions && (
              <div className="ink-menu ink-versions" role="menu" aria-label={t("Versionen", "Versions")}>
                {!versions.length && <span className="ink-menu-hint">{t("Noch keine gespeicherte Version.", "No saved version yet.")}</span>}
                {versions.map((v) => (
                  <button key={v.version} type="button" role="menuitem" onClick={() => void loadVersion(v.version)}>
                    <strong>{t(`Version ${v.version}`, `Version ${v.version}`)}</strong>
                    <span>
                      {[v.by, new Date(v.at).toLocaleString(), t(`${v.items} Elemente`, `${v.items} items`)].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" aria-label={t("Speichern", "Save")} title={t("Speichern", "Save") + keyHints.suffix("Mod+S")} disabled={saving || !editor.dirty} onClick={() => void save()}>
            <FloppyDisk size={19} />
          </button>
          <button type="button" className="ink-done" onClick={() => void finish()} disabled={saving}>
            <Check size={17} />
            <span>{t("Fertig", "Done")}</span>
          </button>
        </InkToolbar>
      )}
      {notice && (
        <p className={`pdf-viewer-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {notice.text}
          <button type="button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </p>
      )}
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
          Array.from({ length: doc.numPages }, (_, i) => <ViewerPage key={i} doc={doc} number={i + 1} width={width} ink={pageInk} />)
        )}
      </div>
    </div>
  );
}
