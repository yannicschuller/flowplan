"use client";
// A notebook page (lib/notebook.ts): sheets of paper – or pages of an
// imported PDF – one below the other, written on with the ink engine
// (components/ink, lib/ink/README.md). Thumbnails to jump, add, duplicate,
// delete, reorder (drag or keys) and change the paper; zoom; export as PDF.
// Ink is saved as it is drawn (components/ink/use-surface-sync.ts). Loaded
// on first use (workspace-app.tsx), with the ink code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowsOut,
  CopySimple,
  DotsThree,
  DotsThreeVertical,
  FileArrowDown,
  FilePdf,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Plus,
  Rows,
  SidebarSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api, downloadBlob, Modal } from "../ui";
import { InkLayer } from "../ink/ink-layer";
import { InkToolbar } from "../ink/ink-toolbar";
import { useInkEditor, useInkShortcuts } from "../ink/use-ink-editor";
import { useSurfaceSync } from "../ink/use-surface-sync";
import { convertSelection } from "../ink/convert";
import { PaperSvg, PdfBackground } from "./paper";
import { takeNotebookImport } from "./pending-import";
import { loadPdf } from "../pdf-viewer";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { emptyInk, parseInk, type InkDoc } from "@/lib/ink/model";
import { recognitionAvailable } from "@/lib/ink/recognition";
import type { PageSize } from "@/lib/ink/coords";
import {
  effectivePaper,
  moveTo,
  PAPER_COLORS,
  PAPER_ORIENTATIONS,
  PAPER_SIZES,
  PAPER_TEMPLATES,
  paperLayout,
  paperSize,
  type Paper,
  type PaperOverride,
} from "@/lib/notebook-paper";
import type { NotebookPayload, NotebookSheet } from "@/lib/notebook";
import { idempotencyHeaders } from "@/lib/idempotency-key";

export type { NotebookPayload };
type CommandAnswer = { paper: Paper; sheets: NotebookSheet[]; created?: string[]; ink?: Record<string, { doc: InkDoc; version: number }> };


const sizeOf = (paper: Paper, sheet: Pick<NotebookSheet, "paper" | "background">): PageSize =>
  sheet.background ? { width: sheet.background.width, height: sheet.background.height } : paperSize(effectivePaper(paper, sheet.paper));
const ZOOMS = { min: 0.5, max: 3, step: 0.25 };
const THUMBS_KEY = "flowplan-notebook-thumbs";
const fileName = (title: string) => (title || "Notebook").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120) || "Notebook";

export default function NotebookView({
  pageId,
  title,
  notebook,
  editable,
  onError,
}: {
  pageId: string;
  title: string;
  notebook: NotebookPayload;
  editable: boolean;
  onError: (message: string) => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const canEdit = editable && notebook.canEdit;
  const [paper, setPaper] = useState<Paper>(notebook.paper);
  const [sheets, setSheets] = useState<NotebookSheet[]>(() =>
    notebook.sheets.map(({ id, position, paper: own, background }) => ({ id, position, paper: own, background })),
  );
  const initial = useMemo(() => {
    const doc = emptyInk();
    for (const sheet of notebook.sheets) {
      const items = parseInk(sheet.ink).pages[sheet.id];
      if (items?.length) doc.pages[sheet.id] = items;
    }
    return doc;
    // The ink as the page was opened; later changes come through the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const editor = useInkEditor(initial, { active: canEdit });
  useInkShortcuts(editor, canEdit, { tools: true });
  const sizes = useMemo(() => new Map(sheets.map((s) => [s.id, sizeOf(paper, s)])), [sheets, paper]);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const sync = useSurfaceSync({
    pageId,
    editor,
    canEdit,
    sizeOf: (surface) => sizesRef.current.get(surface) || null,
    onConflict: (by) =>
      setNotice({
        text: t(
          `${by || "Jemand"} hat auf diesem Blatt gleichzeitig geschrieben; beides ist erhalten.`,
          `${by || "Someone"} wrote on this sheet at the same time; both are kept.`,
        ),
      }),
  });
  const primed = useRef(false);
  if (!primed.current) {
    primed.current = true;
    for (const sheet of notebook.sheets) sync.prime(sheet.id, sheet.version, initial.pages[sheet.id]);
  }
  const [canRecognize, setCanRecognize] = useState(false);
  useEffect(() => setCanRecognize(recognitionAvailable()), []);

  // ---- Layout, zoom, current sheet ----
  const scroller = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(760);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setFit(Math.max(220, Math.min(980, el.clientWidth - 40)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.round(fit * zoom);
  const [current, setCurrent] = useState(sheets[0]?.id || "");
  const currentRef = useRef(current);
  currentRef.current = current;
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const list = [...el.querySelectorAll<HTMLElement>(".notebook-sheet")];
    const middle = el.scrollTop + el.clientHeight / 3;
    const found = list.findLast((s) => s.offsetTop <= middle) || list[0];
    if (found?.dataset.sheet) setCurrent(found.dataset.sheet);
  }, []);
  const show = useCallback((sheetId: string, focus = false) => {
    const el = scroller.current?.querySelector<HTMLElement>(`.notebook-sheet[data-sheet="${sheetId}"]`);
    if (!el || !scroller.current) return;
    scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: "auto" });
    setCurrent(sheetId);
    if (focus) el.focus({ preventScroll: true });
  }, []);
  const changeZoom = useCallback((next: number) => setZoom(Math.min(ZOOMS.max, Math.max(ZOOMS.min, Math.round(next * 4) / 4))), []);
  const onPan = useCallback((dx: number, dy: number) => scroller.current?.scrollBy(dx, dy), []);
  const onZoom = useCallback((factor: number) => setZoom((z) => Math.min(ZOOMS.max, Math.max(ZOOMS.min, Math.round(z * factor * 4) / 4))), []);

  // ---- Thumbnails ----
  const [thumbs, setThumbs] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THUMBS_KEY);
      setThumbs(stored ? stored === "1" : window.innerWidth >= 1100);
    } catch {
      setThumbs(window.innerWidth >= 1100);
    }
  }, []);
  const toggleThumbs = () =>
    setThumbs((on) => {
      try {
        localStorage.setItem(THUMBS_KEY, on ? "0" : "1");
      } catch {}
      return !on;
    });

  // ---- Commands ----
  const [busy, setBusy] = useState("");
  const apply = useCallback(
    (answer: CommandAnswer) => {
      setPaper(answer.paper);
      setSheets(answer.sheets);
      for (const sid of answer.created || []) {
        const ink = answer.ink?.[sid];
        const items = ink ? parseInk(ink.doc).pages[sid] || [] : [];
        if (items.length) editor.applyRemote(sid, items);
        sync.prime(sid, ink?.version ?? 0, items);
      }
    },
    [editor, sync],
  );
  const run = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const answer = await api<CommandAnswer>("/api/command", { pageId, ...body });
        apply(answer);
        return answer;
      } catch (e) {
        onError((e as Error).message);
        return null;
      }
    },
    [apply, onError, pageId],
  );
  const addSheet = useCallback(
    async (after: string | null) => {
      const answer = await run({ action: "notebook.sheet.add", after });
      const created = answer?.created?.[0];
      if (created) requestAnimationFrame(() => show(created));
    },
    [run, show],
  );
  const duplicate = async (sheetId: string) => {
    // The copy is made from what is saved.
    await sync.flush();
    const answer = await run({ action: "notebook.sheet.duplicate", sheetId });
    const created = answer?.created?.[0];
    if (created) requestAnimationFrame(() => show(created));
  };
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (sheetId: string) => {
    setDeleting(null);
    const index = sheets.findIndex((s) => s.id === sheetId);
    sync.forget(sheetId);
    const answer = await run({ action: "notebook.sheet.delete", sheetId });
    if (answer) editor.applyRemote(sheetId, []);
    const next = answer?.sheets[Math.min(index, (answer?.sheets.length || 1) - 1)];
    if (next) setCurrent(next.id);
  };
  const move = async (sheetId: string, to: number) => {
    const order = moveTo(
      sheets.map((s) => s.id),
      sheetId,
      to,
    );
    if (order.join() === sheets.map((s) => s.id).join()) return;
    // At once on the screen; the server confirms.
    setSheets(order.map((sid) => sheets.find((s) => s.id === sid)!));
    await run({ action: "notebook.sheet.move", order });
  };

  // ---- Paper dialog ----
  const [paperFor, setPaperFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Paper>(paper);
  const [scope, setScope] = useState<"sheet" | "all" | "new">("sheet");
  const openPaper = (sheetId: string) => {
    const sheet = sheets.find((s) => s.id === sheetId);
    setDraft(effectivePaper(paper, sheet?.paper));
    setScope("sheet");
    setPaperFor(sheetId);
  };
  const savePaper = async () => {
    const sheetId = paperFor;
    setPaperFor(null);
    if (!sheetId) return;
    if (scope === "sheet") {
      // Only what differs from the notebook is the sheet's own.
      const own: PaperOverride = {};
      for (const key of ["template", "size", "orientation", "color"] as const) if (draft[key] !== paper[key]) Object.assign(own, { [key]: draft[key] });
      await run({ action: "notebook.sheet.paper", sheetIds: [sheetId], paper: own });
    } else await run({ action: "notebook.paper", paper: draft, all: scope === "all" });
  };

  // ---- PDF import and export ----
  const fileInput = useRef<HTMLInputElement>(null);
  const importPdf = useCallback(
    async (file: File) => {
      setBusy(t("PDF wird importiert …", "Importing PDF …"));
      try {
        await sync.flush();
        const form = new FormData();
        form.append("pageId", pageId);
        form.append("file", file);
        const response = await fetch("/api/upload", { method: "POST", body: form, headers: idempotencyHeaders() });
        const uploaded = await response.json();
        if (!response.ok) throw new Error(uploaded.error || t("Das PDF konnte nicht hochgeladen werden.", "The PDF could not be uploaded."));
        if (uploaded.mime !== "application/pdf") throw new Error(t("Bitte ein PDF wählen.", "Please choose a PDF."));
        const doc = await loadPdf(uploaded.url);
        const count = Math.min(doc.numPages, 500);
        const pages: PageSize[] = [];
        for (let i = 1; i <= count; i++) {
          const viewport = (await doc.getPage(i)).getViewport({ scale: 1 });
          pages.push({ width: viewport.width, height: viewport.height });
        }
        const answer = await run({ action: "notebook.import", fileId: uploaded.id, pages, after: currentRef.current || null, replaceEmpty: true });
        if (doc.numPages > count)
          setNotice({ text: t(`Nur die ersten ${count} von ${doc.numPages} Seiten wurden übernommen.`, `Only the first ${count} of ${doc.numPages} pages were taken over.`) });
        const first = answer?.created?.[0];
        if (first) requestAnimationFrame(() => show(first));
      } catch (e) {
        onError((e as Error).message || t("Das PDF konnte nicht importiert werden.", "The PDF could not be imported."));
      } finally {
        setBusy("");
      }
    },
    [onError, pageId, run, show, sync, t],
  );
  // "New notebook from PDF".
  useEffect(() => {
    if (!canEdit) return;
    const file = takeNotebookImport(pageId);
    if (file) void importPdf(file);
  }, [canEdit, importPdf, pageId]);
  const exportPdf = async () => {
    setBusy(t("PDF wird erstellt …", "Creating PDF …"));
    try {
      if (canEdit) await sync.flush();
      const { notebookPdf, notebookPdfSheets } = await import("@/lib/ink/notebook-pdf");
      const doc = editor.docRef.current;
      const bytes = await notebookPdf(
        notebookPdfSheets(
          paper,
          sheets.map((s) => ({ ...s, ink: doc })),
        ),
        async (file) => {
          const response = await fetch(`/api/files/${file}`, { credentials: "same-origin" });
          return response.ok ? response.arrayBuffer() : null;
        },
        { title },
      );
      downloadBlob(`${fileName(title)}.pdf`, new Blob([bytes as BlobPart], { type: "application/pdf" }));
    } catch {
      onError(t("Das PDF konnte nicht erstellt werden.", "The PDF could not be created."));
    } finally {
      setBusy("");
    }
  };

  // ---- Convert to text ----
  const convert = async (sheetId: string) => {
    const size = sizesRef.current.get(sheetId);
    if (!size) return;
    setBusy(t("Handschrift wird erkannt …", "Recognising handwriting …"));
    const result = await convertSelection(editor, size);
    setBusy("");
    if (result === "empty") setNotice({ text: t("In der Auswahl wurde kein Text erkannt.", "No text was recognised in the selection.") });
    if (result === "failed") setNotice({ text: t("Die Handschrift konnte nicht erkannt werden.", "The handwriting could not be recognised."), error: true });
  };

  // ---- Keys ----
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const mod = event.metaKey || event.ctrlKey;
      const list = sheetsRef.current;
      const index = Math.max(0, list.findIndex((s) => s.id === currentRef.current));
      if (mod && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        setZoom((z) => Math.min(ZOOMS.max, z + ZOOMS.step));
      } else if (mod && event.key === "-") {
        event.preventDefault();
        setZoom((z) => Math.max(ZOOMS.min, z - ZOOMS.step));
      } else if (mod && event.key === "0") {
        event.preventDefault();
        setZoom(1);
      } else if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void sync.flush();
      } else if (mod && event.shiftKey && event.key === "Enter" && canEdit) {
        event.preventDefault();
        void addSheet(currentRef.current || null);
      } else if (event.altKey && !mod && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const next = list[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        show(next.id, true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [addSheet, canEdit, show, sync]);

  // ---- Rendering ----
  const layouts = useMemo(
    () =>
      new Map(
        sheets.map((s) => {
          const own = effectivePaper(paper, s.paper);
          return [s.id, { paper: own, layout: s.background ? null : paperLayout(own, sizeOf(paper, s)) }];
        }),
      ),
    [sheets, paper],
  );
  const status =
    sync.status === "saving"
      ? t("Wird gespeichert …", "Saving …")
      : sync.status === "dirty"
        ? t("Nicht gespeichert", "Not saved")
        : sync.status === "error"
          ? t("Speichern fehlgeschlagen – wird erneut versucht", "Saving failed – trying again")
          : t("Gespeichert", "Saved");
  const templateName = (template: Paper["template"]) =>
    ({
      blank: t("Leer", "Blank"),
      "lined-college": t("Liniert (eng)", "Lined (college)"),
      "lined-wide": t("Liniert (weit)", "Lined (wide)"),
      grid: t("Kariert (5 mm)", "Grid (5 mm)"),
      dotted: t("Gepunktet", "Dotted"),
      cornell: t("Cornell-Notizen", "Cornell notes"),
      music: t("Notenpapier", "Music staff"),
    })[template];
  const currentIndex = Math.max(0, sheets.findIndex((s) => s.id === current));
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".notebook-menu-anchor")) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [menu]);

  const sheetMenu = (sheet: NotebookSheet, index: number) => (
    <div className="ink-menu notebook-menu" role="menu" aria-label={t(`Blatt ${index + 1}`, `Sheet ${index + 1}`)}>
      <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(sheet.id))}>
        <Plus size={16} /> {t("Neues Blatt danach", "New sheet after")}
      </button>
      <button type="button" role="menuitem" onClick={() => (setMenu(null), void duplicate(sheet.id))}>
        <CopySimple size={16} /> {t("Duplizieren", "Duplicate")}
      </button>
      {!sheet.background && (
        <button type="button" role="menuitem" onClick={() => (setMenu(null), openPaper(sheet.id))}>
          <Rows size={16} /> {t("Papier ändern …", "Change paper …")}
        </button>
      )}
      <button type="button" role="menuitem" disabled={index === 0} onClick={() => (setMenu(null), void move(sheet.id, index - 1))}>
        <ArrowUp size={16} /> {t("Nach oben", "Move up")}
      </button>
      <button type="button" role="menuitem" disabled={index === sheets.length - 1} onClick={() => (setMenu(null), void move(sheet.id, index + 1))}>
        <ArrowDown size={16} /> {t("Nach unten", "Move down")}
      </button>
      <button type="button" role="menuitem" className="danger" disabled={sheets.length <= 1} onClick={() => (setMenu(null), setDeleting(sheet.id))}>
        <Trash size={16} /> {t("Löschen", "Delete")}
      </button>
    </div>
  );

  return (
    <div className={`notebook-view${thumbs ? " with-thumbs" : ""}`}>
      <div className="notebook-bar">
        {canEdit && <InkToolbar editor={editor} toolKeys label={t("Schreibwerkzeuge", "Writing tools")} />}
        <div className="notebook-controls" role="toolbar" aria-label={t("Notizbuch", "Notebook")}>
          <button
            type="button"
            className={`icon-button${thumbs ? " active" : ""}`}
            aria-pressed={thumbs}
            aria-label={t("Seitenübersicht", "Page overview")}
            title={t("Seitenübersicht", "Page overview")}
            onClick={toggleThumbs}
          >
            <SidebarSimple size={18} />
          </button>
          <span className="notebook-position" aria-live="polite">
            {t(`Blatt ${currentIndex + 1} von ${sheets.length}`, `Sheet ${currentIndex + 1} of ${sheets.length}`)}
          </span>
          <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out") + keyHints.suffix("Mod+-")} onClick={() => changeZoom(zoom - ZOOMS.step)}>
            <MagnifyingGlassMinus size={18} />
          </button>
          <span className="notebook-zoom">{Math.round(zoom * 100)} %</span>
          <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in") + keyHints.suffix("Mod+=")} onClick={() => changeZoom(zoom + ZOOMS.step)}>
            <MagnifyingGlassPlus size={18} />
          </button>
          <button type="button" className="icon-button" aria-label={t("An Breite anpassen", "Fit to width")} title={t("An Breite anpassen", "Fit to width") + keyHints.suffix("Mod+0")} onClick={() => setZoom(1)}>
            <ArrowsOut size={18} />
          </button>
          {canEdit && (
            <div className="notebook-menu-anchor">
              <button
                type="button"
                className="icon-button"
                aria-label={t("Blatt hinzufügen", "Add sheet")}
                title={t("Blatt hinzufügen", "Add sheet") + keyHints.suffix("Mod+Shift+Enter")}
                aria-haspopup="menu"
                aria-expanded={menu === "add"}
                onClick={() => setMenu(menu === "add" ? null : "add")}
              >
                <Plus size={18} />
              </button>
              {menu === "add" && (
                <div className="ink-menu notebook-menu" role="menu" aria-label={t("Blatt hinzufügen", "Add sheet")}>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(current || null))}>
                    {t("Nach dem aktuellen Blatt", "After the current sheet")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(null))}>
                    {t("Am Ende", "At the end")}
                  </button>
                </div>
              )}
            </div>
          )}
          {canEdit && sheets.find((s) => s.id === current && !s.background) && (
            <button type="button" className="icon-button" aria-label={t("Papier ändern", "Change paper")} title={t("Papier ändern", "Change paper")} onClick={() => openPaper(current)}>
              <Rows size={18} />
            </button>
          )}
          <div className="notebook-menu-anchor">
            <button
              type="button"
              className="icon-button"
              aria-label={t("Weitere Aktionen", "More actions")}
              title={t("Weitere Aktionen", "More actions")}
              aria-haspopup="menu"
              aria-expanded={menu === "more"}
              onClick={() => setMenu(menu === "more" ? null : "more")}
            >
              <DotsThree size={18} weight="bold" />
            </button>
            {menu === "more" && (
              <div className="ink-menu notebook-menu notebook-menu-end" role="menu" aria-label={t("Weitere Aktionen", "More actions")}>
                {canEdit && (
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), fileInput.current?.click())}>
                    <FilePdf size={16} /> {t("PDF importieren …", "Import PDF …")}
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => (setMenu(null), void exportPdf())}>
                  <FileArrowDown size={16} /> {t("Als PDF exportieren", "Export as PDF")}
                </button>
              </div>
            )}
          </div>
          {canEdit && (
            <span className={`ink-status notebook-status${sync.status === "error" ? " is-error" : ""}`} role="status">
              {busy || status}
            </span>
          )}
          {!canEdit && busy && (
            <span className="ink-status notebook-status" role="status">
              {busy}
            </span>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importPdf(file);
            }}
          />
        </div>
      </div>
      {notice && (
        <p className={`notebook-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {notice.text}
          <button type="button" className="icon-button" aria-label={t("Hinweis schließen", "Dismiss")} onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </p>
      )}
      <div className="notebook-body">
        {thumbs && (
          <nav className="notebook-thumbs" aria-label={t("Seitenübersicht", "Page overview")}>
            <ol>
              {sheets.map((sheet, index) => {
                const size = sizes.get(sheet.id)!;
                const look = layouts.get(sheet.id)!;
                return (
                  <li
                    key={sheet.id}
                    className={`notebook-thumb${sheet.id === current ? " is-current" : ""}${dragging === sheet.id ? " is-dragging" : ""}${dropAt === index ? " drop-before" : ""}${dropAt === index + 1 && index === sheets.length - 1 ? " drop-after" : ""}`}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      setDragging(sheet.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", sheet.id);
                    }}
                    onDragOver={(e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      setDropAt(e.clientY > box.top + box.height / 2 ? index + 1 : index);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropAt(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const moving = dragging;
                      const at = dropAt;
                      setDragging(null);
                      setDropAt(null);
                      if (!moving || at === null) return;
                      const from = sheets.findIndex((s) => s.id === moving);
                      void move(moving, at > from ? at - 1 : at);
                    }}
                  >
                    <button
                      type="button"
                      className="notebook-thumb-open"
                      aria-current={sheet.id === current ? "page" : undefined}
                      aria-label={t(`Blatt ${index + 1}`, `Sheet ${index + 1}`)}
                      title={
                        canEdit
                          ? t("Zum Blatt; zum Verschieben ziehen", "Go to the sheet; drag to move") +
                            (keyHints.visible ? ` (${keyHints.keys("Alt+ArrowUp")} / ${keyHints.keys("Alt+ArrowDown")})` : "")
                          : undefined
                      }
                      onClick={() => {
                        show(sheet.id);
                        // On a phone the overview lies over the sheets: it gives way.
                        if (window.matchMedia?.("(max-width: 760px)").matches) setThumbs(false);
                      }}
                      onKeyDown={(e) => {
                        if (!canEdit || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                        e.preventDefault();
                        e.stopPropagation();
                        void move(sheet.id, index + (e.key === "ArrowUp" ? -1 : 1));
                      }}
                    >
                      <span
                        className={`notebook-thumb-paper${look.paper.color === "dark" && !sheet.background ? " is-dark" : ""}`}
                        style={{ aspectRatio: `${size.width} / ${size.height}` }}
                      >
                        {sheet.background ? (
                          <PdfBackground src={`/api/files/${sheet.background.file}`} page={sheet.background.page} width={120} />
                        ) : (
                          <PaperSvg layout={look.layout!} />
                        )}
                        <InkLayer page={sheet.id} size={size} doc={editor.doc} label={t(`Vorschau von Blatt ${index + 1}`, `Preview of sheet ${index + 1}`)} />
                      </span>
                      <span className="notebook-thumb-number">{index + 1}</span>
                    </button>
                    <div className="notebook-menu-anchor notebook-thumb-more">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t(`Aktionen für Blatt ${index + 1}`, `Actions for sheet ${index + 1}`)}
                        aria-haspopup="menu"
                        aria-expanded={menu === `sheet:${sheet.id}`}
                        hidden={!canEdit}
                        onClick={() => setMenu(menu === `sheet:${sheet.id}` ? null : `sheet:${sheet.id}`)}
                      >
                        <DotsThreeVertical size={16} weight="bold" />
                      </button>
                      {menu === `sheet:${sheet.id}` && sheetMenu(sheet, index)}
                    </div>
                  </li>
                );
              })}
            </ol>
            {canEdit && (
              <button type="button" className="notebook-thumb-add" onClick={() => void addSheet(null)}>
                <Plus size={16} /> {t("Blatt am Ende", "Sheet at the end")}
              </button>
            )}
          </nav>
        )}
        <div className="notebook-scroll" ref={scroller} onScroll={onScroll}>
          <div className="notebook-sheets" style={{ width }}>
            {sheets.map((sheet, index) => {
              const size = sizes.get(sheet.id)!;
              const look = layouts.get(sheet.id)!;
              const dark = !sheet.background && look.paper.color === "dark";
              return (
                <section
                  key={sheet.id}
                  className={`notebook-sheet${dark ? " is-dark" : ""}`}
                  data-sheet={sheet.id}
                  tabIndex={-1}
                  aria-label={t(`Blatt ${index + 1} von ${sheets.length}`, `Sheet ${index + 1} of ${sheets.length}`)}
                  style={{ width, aspectRatio: `${size.width} / ${size.height}` }}
                >
                  {sheet.background ? (
                    <PdfBackground src={`/api/files/${sheet.background.file}`} page={sheet.background.page} width={width} eager={index < 2} />
                  ) : (
                    <PaperSvg layout={look.layout!} />
                  )}
                  <InkLayer
                    page={sheet.id}
                    size={size}
                    editor={editor}
                    editing={canEdit}
                    onPan={onPan}
                    onZoom={onZoom}
                    onConvert={canEdit && canRecognize ? () => void convert(sheet.id) : undefined}
                    label={t(`Handschrift auf Blatt ${index + 1}`, `Handwriting on sheet ${index + 1}`)}
                  />
                </section>
              );
            })}
            {canEdit && (
              <button type="button" className="notebook-add-end" onClick={() => void addSheet(null)}>
                <Plus size={18} /> {t("Blatt hinzufügen", "Add sheet")}
              </button>
            )}
          </div>
        </div>
      </div>
      <Modal open={!!paperFor} onClose={() => setPaperFor(null)} title={t("Papier", "Paper")} className="notebook-paper-dialog">
        <div className="notebook-paper-form">
          <fieldset>
            <legend>{t("Vorlage", "Template")}</legend>
            <div className="notebook-templates">
              {PAPER_TEMPLATES.map((template) => (
                <label key={template} className={draft.template === template ? "chosen" : ""}>
                  <input type="radio" name="notebook-template" checked={draft.template === template} onChange={() => setDraft({ ...draft, template })} />
                  <span className={`notebook-template-preview${draft.color === "dark" ? " is-dark" : ""}`}>
                    <PaperSvg layout={paperLayout({ ...draft, template, orientation: "portrait" })} />
                  </span>
                  <span>{templateName(template)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="notebook-paper-row">
            <fieldset>
              <legend>{t("Format", "Size||paper")}</legend>
              {PAPER_SIZES.map((size) => (
                <label key={size}>
                  <input type="radio" name="notebook-size" checked={draft.size === size} onChange={() => setDraft({ ...draft, size })} />
                  {size === "a4" ? "A4" : "Letter"}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>{t("Ausrichtung", "Orientation")}</legend>
              {PAPER_ORIENTATIONS.map((orientation) => (
                <label key={orientation}>
                  <input type="radio" name="notebook-orientation" checked={draft.orientation === orientation} onChange={() => setDraft({ ...draft, orientation })} />
                  {orientation === "portrait" ? t("Hochformat", "Portrait") : t("Querformat", "Landscape")}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>{t("Papierfarbe", "Paper colour")}</legend>
              {PAPER_COLORS.map((color) => (
                <label key={color}>
                  <input type="radio" name="notebook-color" checked={draft.color === color} onChange={() => setDraft({ ...draft, color })} />
                  {color === "light" ? t("Hell", "Light") : t("Dunkel", "Dark")}
                </label>
              ))}
            </fieldset>
          </div>
          <fieldset>
            <legend>{t("Anwenden auf", "Apply to")}</legend>
            <label>
              <input type="radio" name="notebook-scope" checked={scope === "sheet"} onChange={() => setScope("sheet")} />
              {t("Dieses Blatt", "This sheet")}
            </label>
            <label>
              <input type="radio" name="notebook-scope" checked={scope === "new"} onChange={() => setScope("new")} />
              {t("Standard des Notizbuchs (Blätter ohne eigenes Papier)", "Notebook default (sheets without their own paper)")}
            </label>
            <label>
              <input type="radio" name="notebook-scope" checked={scope === "all"} onChange={() => setScope("all")} />
              {t("Alle Blätter", "All sheets")}
            </label>
          </fieldset>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setPaperFor(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" onClick={() => void savePaper()}>
              {t("Übernehmen", "Apply")}
            </button>
          </div>
        </div>
      </Modal>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={t("Blatt löschen?", "Delete sheet?")}>
        <p>{t("Das Blatt und alles, was darauf geschrieben ist, werden gelöscht.", "The sheet and everything written on it will be deleted.")}</p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => setDeleting(null)}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button danger-solid" onClick={() => deleting && void remove(deleting)}>
            {t("Löschen", "Delete")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
