"use client";
// What the PDF viewer (pdf-viewer-dialog.tsx) and the PDF side panel
// (pdf-panel.tsx, #392) share: the pages drawn near the visible area, and
// the annotations ("Anmerken") – the ink of the PDF (lib/ink-store.ts,
// `<file>/ink`), loaded with the PDF, saved as versions, editable for who
// may edit the page the file belongs to (not in encrypted spaces or on
// locked pages: the server says `canEdit`). Both show the same annotations;
// there is no second store.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ClockCounterClockwise, FloppyDisk, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, downloadBlob } from "./ui";
import { InkLayer } from "./ink/ink-layer";
import { InkToolbar } from "./ink/ink-toolbar";
import { useMenuPlacement } from "./ink/menu-placement";
import { useInkEditor, type InkEditor } from "./ink/use-ink-editor";
import { convertSelection } from "./ink/convert";
import { renderPage, type PdfDocument } from "./pdf-viewer";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import type { PageSize } from "@/lib/ink/coords";
import { emptyInk, hasInk, parseInk, type InkDoc } from "@/lib/ink/model";
import { recognitionAvailable, recognitionId, recognitionRequest, recognizeInk } from "@/lib/ink/recognition";

// What the pages need to show ink and, while annotating, to take it.
export type PageInk = {
  editor: InkEditor;
  editing: boolean;
  show: boolean;
  // The size of a page once known (recognition needs it).
  onSize: (page: string, size: PageSize) => void;
  // "Convert to text" where the device recognises handwriting.
  convert?: (size: PageSize) => void;
};

// One page; drawn once it comes near the visible area. The ink lies over
// it in page units (PDF points), whatever the zoom. `overlay` lies above
// the ink (the panel's region lasso).
export function ViewerPage({
  doc,
  number,
  width,
  ink,
  overlay,
}: {
  doc: PdfDocument;
  number: number;
  width: number;
  ink: PageInk;
  overlay?: (size: PageSize) => ReactNode;
}) {
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
    if (!visible || !canvas.current) return;
    let alive = true;
    // Drawn aside and copied over when done: after a zoom the page shown
    // before stays (stretched) until the sharp one is there, no blank flash.
    const aside = document.createElement("canvas");
    renderPage(doc, number, aside, width)
      .then(() => {
        const el = canvas.current;
        if (!alive || !el || !aside.width) return;
        el.width = aside.width;
        el.height = aside.height;
        el.getContext("2d")?.drawImage(aside, 0, 0);
        aside.width = aside.height = 0;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          onConvert={ink.convert ? () => ink.convert!(size) : undefined}
        />
      )}
      {size && overlay?.(size)}
    </div>
  );
}

export type InkVersion = { version: number; by: string | null; at: number; items: number };
export type PdfNoticeText = { text: string; error?: boolean };

// The annotations of one PDF: loading, saving (with conflicts kept as a
// version), versions, handwriting recognition for search, the PDF with the
// ink drawn in.
export function usePdfAnnotations(src: string, title: string, annotating: boolean) {
  const t = useT();
  const editor = useInkEditor(emptyInk(), { active: annotating });
  const inkUrl = `${src}/ink`;
  const { reset } = editor;
  // Loaded with the PDF; null until then.
  const [ink, setInk] = useState<{ version: number; canEdit: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<PdfNoticeText | null>(null);
  const [versions, setVersions] = useState<InkVersion[] | null>(null);
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
  const inkRef = useRef(ink);
  inkRef.current = ink;

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
  // Saves the ink as a new version; true when saved.
  const busy = useRef(false);
  async function save(): Promise<boolean> {
    const current = inkRef.current;
    if (!current || busy.current) return false;
    const snapshot = editor.docRef.current;
    busy.current = true;
    setSaving(true);
    try {
      const result = await api<{ version: number; conflict: { by: string | null; at: number; version: number } | null }>(inkUrl, {
        base: current.version,
        doc: snapshot,
      });
      inkRef.current = { ...current, version: result.version };
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
      busy.current = false;
      setSaving(false);
    }
  }
  const [canRecognize, setCanRecognize] = useState(false);
  useEffect(() => setCanRecognize(recognitionAvailable()), []);
  async function convert(size: PageSize) {
    const result = await convertSelection(editor, size);
    if (result === "empty") setNotice({ text: t("In der Auswahl wurde kein Text erkannt.", "No text was recognised in the selection.") });
    if (result === "failed") setNotice({ text: t("Die Handschrift konnte nicht erkannt werden.", "The handwriting could not be recognised."), error: true });
  }
  async function showVersions() {
    if (versions) return setVersions(null);
    try {
      const data = await api<{ versions: InkVersion[] }>(`${inkUrl}?versions=1`);
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
  const onSize = useCallback((page: string, size: PageSize) => void sizes.current.set(page, size), []);
  const pageInk: PageInk = {
    editor,
    editing: annotating,
    show: !!ink,
    onSize,
    convert: annotating && canRecognize ? (size) => void convert(size) : undefined,
  };
  // Unsaved ink is not lost by closing the tab unnoticed.
  const dirty = annotating && editor.dirty;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return {
    editor,
    ink,
    saving,
    exporting,
    notice,
    setNotice,
    versions,
    showVersions,
    loadVersion,
    save,
    downloadAnnotated,
    annotated: hasInk(editor.doc),
    pageInk,
  };
}
export type PdfAnnotations = ReturnType<typeof usePdfAnnotations>;

// The annotating bar: the ink tools, the save state, versions, save and –
// in the viewer – "Fertig".
export function AnnotateBar({ ann, onDone }: { ann: PdfAnnotations; onDone?: () => void }) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const placeMenu = useMenuPlacement();
  const { editor, versions } = ann;
  return (
    <InkToolbar editor={editor}>
      <span className="ink-status" role="status">
        {ann.saving ? t("Wird gespeichert …", "Saving …") : editor.dirty ? t("Nicht gespeichert", "Not saved") : t("Gespeichert", "Saved")}
      </span>
      <div className="ink-menu-anchor">
        <button type="button" aria-label={t("Versionen", "Versions")} title={t("Versionen", "Versions")} aria-expanded={!!versions} onClick={() => void ann.showVersions()}>
          <ClockCounterClockwise size={19} />
        </button>
        {versions && (
          <div ref={placeMenu} className="ink-menu ink-versions" role="menu" aria-label={t("Versionen", "Versions")}>
            {!versions.length && <span className="ink-menu-hint">{t("Noch keine gespeicherte Version.", "No saved version yet.")}</span>}
            {versions.map((v) => (
              <button key={v.version} type="button" role="menuitem" onClick={() => void ann.loadVersion(v.version)}>
                <strong>{t(`Version ${v.version}`, `Version ${v.version}`)}</strong>
                <span>{[v.by, new Date(v.at).toLocaleString(), t(`${v.items} Elemente`, `${v.items} items`)].filter(Boolean).join(" · ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" aria-label={t("Speichern", "Save")} title={t("Speichern", "Save") + keyHints.suffix("Mod+S")} disabled={ann.saving || !editor.dirty} onClick={() => void ann.save()}>
        <FloppyDisk size={19} />
      </button>
      {onDone && (
        <button type="button" className="ink-done" onClick={onDone} disabled={ann.saving}>
          <Check size={17} />
          <span>{t("Fertig", "Done")}</span>
        </button>
      )}
    </InkToolbar>
  );
}

export function PdfNotice({ notice, onDismiss }: { notice: PdfNoticeText | null; onDismiss: () => void }) {
  const t = useT();
  if (!notice) return null;
  return (
    <p className={`pdf-viewer-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>
      {notice.text}
      <button type="button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={onDismiss}>
        <X size={14} />
      </button>
    </p>
  );
}

// The page of `scroller` a third down from its top.
export function currentPageOf(scroller: HTMLElement | null) {
  if (!scroller) return 1;
  const pages = [...scroller.querySelectorAll<HTMLElement>(".pdf-page-wrap")];
  const middle = scroller.scrollTop + scroller.clientHeight / 3;
  const page = pages.findLast((p) => p.offsetTop <= middle);
  return Number(page?.dataset.page || 1);
}
// Scrolls `scroller` to the top of page `number` once it is laid out.
export function scrollToPage(scroller: HTMLElement | null, number: number, behavior: ScrollBehavior = "auto") {
  const page = scroller?.querySelector<HTMLElement>(`.pdf-page-wrap[data-page="${number}"]`);
  if (!scroller || !page) return false;
  scroller.scrollTo({ top: Math.max(0, page.offsetTop - 12), behavior });
  return true;
}
