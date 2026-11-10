"use client";
// A notebook page (lib/notebook.ts): sheets of paper – or pages of an
// imported PDF – one below the other, written on with the ink engine
// (components/ink, lib/ink/README.md). Thumbnails to jump, add, duplicate,
// delete, reorder (drag or keys) and change the paper; zoom; export as PDF.
// The page overview (notebook-overview.tsx: grid, bookmarks, search,
// selection, table of contents), links on sheets (sheet-links.tsx) and
// presenting with follow mode (notebook-presentation.tsx) organise it
// (lib/notebook-organize.ts). Ink is saved as it is drawn
// (components/ink/use-surface-sync.ts). Loaded on first use
// (workspace-app.tsx), with the ink code.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowsOut,
  BookmarkSimple,
  CopySimple,
  FolderSimple,
  LinkSimple,
  ListBullets,
  PencilSimpleLine,
  Presentation,
  SquaresFour,
  ArrowCounterClockwise,
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
import { useMenuPlacement } from "../ink/menu-placement";
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
  MAX_IMPORT_PAGES,
  MAX_SHEETS,
  type Paper,
  type PaperOverride,
} from "@/lib/notebook-paper";
import type { NotebookPayload, NotebookSheet } from "@/lib/notebook";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { Select } from "../select";
import { stepZoom } from "@/lib/pinch-zoom";
import { usePinchZoom } from "./use-pinch-zoom";
import { NotebookOverview, type OverviewActions } from "./notebook-overview";
import { BookmarkRibbon, SheetPicture } from "./sheet-thumb";
import { SheetLinks } from "./sheet-links";
import { LinkDialog, TitleDialog, TransferDialog, TrashDialog } from "./notebook-dialogs";
import { NotebookPresentation } from "./notebook-presentation";
import { useNotebookLive } from "./use-notebook-live";
import { NOTEBOOK_STRUCTURE_EVENT, type NotebookStructureEvent } from "./outline-api";
import type { NotebookLink, NotebookLinkTarget, OutlineEntry } from "@/lib/notebook-organize-model";

export type { NotebookPayload };
type CommandAnswer = {
  paper: Paper;
  sheets: NotebookSheet[];
  outline?: OutlineEntry[];
  created?: string[];
  trashed?: string[];
  ink?: Record<string, { doc: InkDoc; version: number }>;
};
// Where new sheets go (lib/notebook.ts sheetPlace): before the first sheet,
// after a sheet, or at the end (after: null).
type Place = { at: "start" } | { after: string | null };


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
  // The menus of the bar open under their button, those of the overview
  // from the left edge of theirs; all stay inside the window.
  const placeMenu = useMenuPlacement();
  const placeStartMenu = useMenuPlacement("start");
  const canEdit = editable && notebook.canEdit;
  const [paper, setPaper] = useState<Paper>(notebook.paper);
  const [sheets, setSheets] = useState<NotebookSheet[]>(() =>
    notebook.sheets.map(({ id, position, paper: own, background, title, bookmark, links }) => ({ id, position, paper: own, background, title, bookmark, links })),
  );
  const [outline, setOutline] = useState<OutlineEntry[]>(notebook.outline || []);
  // Recognised handwriting as loaded (search in the overview).
  const recognized = useMemo(() => Object.fromEntries(notebook.sheets.flatMap((s) => (s.recognized ? [[s.id, s.recognized]] : []))), [notebook.sheets]);
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
  const [notice, setNotice] = useState<{ text: string; error?: boolean; action?: { label: string; run: () => void } } | null>(null);
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
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const list = [...el.querySelectorAll<HTMLElement>(".notebook-sheet")];
    const middle = el.scrollTop + el.clientHeight / 3;
    const found = list.findLast((s) => s.offsetTop <= middle) || list[0];
    if (found?.dataset.sheet) setCurrent(found.dataset.sheet);
  }, []);
  // `y`: a place on the sheet in points (a heading of the contents).
  const show = useCallback((sheetId: string, focus = false, y = 0) => {
    const el = scroller.current?.querySelector<HTMLElement>(`.notebook-sheet[data-sheet="${sheetId}"]`);
    if (!el || !scroller.current) return;
    const size = sizesRef.current.get(sheetId);
    const offset = y > 0 && size ? (y * el.clientWidth) / size.width - 40 : 0;
    scroller.current.scrollTo({ top: el.offsetTop - 12 + Math.max(0, offset), behavior: "auto" });
    setCurrent(sheetId);
    if (focus) el.focus({ preventScroll: true });
  }, []);
  // Buttons and keys go in steps; two fingers and trackpads zoom freely,
  // anchored where they pinch, and two fingers pan (use-pinch-zoom.ts).
  const zoomStep = useCallback((direction: 1 | -1) => setZoom((z) => stepZoom(z, direction, ZOOMS.step, ZOOMS)), []);
  const sheetsBox = useRef<HTMLDivElement>(null);
  usePinchZoom({ scroller, content: sheetsBox, sheetSelector: ".notebook-sheet", zoom, setZoom, limits: ZOOMS });

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
      if (answer.outline) setOutline(answer.outline);
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
    async (after: string | null, place: Place = { after }) => {
      const answer = await run({ action: "notebook.sheet.add", ...place });
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
  // Deleting goes into the notebook's trash: the notice undoes it, "Gelöschte
  // Blätter …" restores later (lib/notebook-organize.ts).
  const restore = useCallback(
    async (trashIds: string[]) => {
      const answer = await run({ action: "notebook.trash.restore", trashIds });
      const first = answer?.created?.[0];
      if (first) requestAnimationFrame(() => show(first));
      return !!answer;
    },
    [run, show],
  );
  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    await sync.flush();
    const index = sheets.findIndex((s) => s.id === ids[0]);
    const answer = await run(ids.length === 1 ? { action: "notebook.sheet.delete", sheetId: ids[0] } : { action: "notebook.sheets.delete", sheetIds: ids });
    if (!answer) return;
    for (const sid of ids) {
      sync.forget(sid);
      editor.applyRemote(sid, []);
    }
    const next = answer.sheets[Math.min(Math.max(0, index), answer.sheets.length - 1)];
    if (next && ids.includes(currentRef.current)) setCurrent(next.id);
    const trashed = answer.trashed || [];
    setNotice({
      text: ids.length === 1 ? t("Blatt gelöscht.", "Sheet deleted.") : t(`${ids.length} Blätter gelöscht.`, `${ids.length} sheets deleted.`),
      action: trashed.length ? { label: t("Rückgängig", "Undo"), run: () => (setNotice(null), void restore(trashed)) } : undefined,
    });
  };
  const moveOrder = async (order: string[]) => {
    if (order.join() === sheetsRef.current.map((s) => s.id).join()) return;
    // At once on the screen; the server confirms.
    const byId = new Map(sheetsRef.current.map((s) => [s.id, s]));
    setSheets(order.map((sid) => byId.get(sid)!));
    await run({ action: "notebook.sheet.move", order });
  };
  const move = async (sheetId: string, to: number) =>
    await moveOrder(
      moveTo(
        sheets.map((s) => s.id),
        sheetId,
        to,
      ),
    );
  const bookmark = async (ids: string[], on: boolean) => {
    // At once on the screen; the server confirms.
    setSheets((list) => list.map((s) => (ids.includes(s.id) ? { ...s, bookmark: on || undefined } : s)));
    await run({ action: "notebook.sheet.meta", sheetIds: ids, bookmark: on });
  };
  const duplicateMany = async (ids: string[]) => {
    await sync.flush();
    const answer = await run(ids.length === 1 ? { action: "notebook.sheet.duplicate", sheetId: ids[0] } : { action: "notebook.sheets.duplicate", sheetIds: ids });
    if ((answer?.created?.length || 0) > 1) setNotice({ text: t(`${answer!.created!.length} Blätter dupliziert.`, `${answer!.created!.length} sheets duplicated.`) });
  };
  const saveOutline = async (next: OutlineEntry[]) => {
    setOutline(next);
    await run({ action: "notebook.outline", outline: next });
  };
  // A sheet's title, or a sheet marked as a chapter of the contents.
  const [titleFor, setTitleFor] = useState<{ kind: "rename" | "chapter"; sheet: string } | null>(null);
  const saveTitle = async (value: string) => {
    const target = titleFor;
    setTitleFor(null);
    if (!target) return;
    if (target.kind === "rename") await run({ action: "notebook.sheet.meta", sheetIds: [target.sheet], title: value });
    else if (value) await run({ action: "notebook.outline.add", sheetId: target.sheet, title: value });
  };
  // Into another notebook.
  const [transferring, setTransferring] = useState<string[] | null>(null);
  const transfer = async (target: string, mode: "copy" | "move", place: "start" | "end") => {
    const ids = transferring || [];
    setTransferring(null);
    if (!ids.length) return;
    await sync.flush();
    try {
      const answer = await api<CommandAnswer & { target: { id: string; title: string }; copied: number }>("/api/command", {
        action: "notebook.sheets.transfer",
        pageId,
        targetPageId: target,
        sheetIds: ids,
        mode,
        ...(place === "start" ? { at: "start" } : { after: null }),
      });
      if (mode === "move")
        for (const sid of ids) {
          sync.forget(sid);
          editor.applyRemote(sid, []);
        }
      apply(answer);
      if (mode === "move" && ids.includes(currentRef.current) && answer.sheets[0]) setCurrent(answer.sheets[0].id);
      const name = answer.target.title || t("Ohne Titel", "Untitled");
      setNotice({
        text:
          mode === "move"
            ? answer.copied === 1
              ? t(`Blatt nach „${name}“ verschoben.`, `Moved the sheet to “${name}”.`)
              : t(`${answer.copied} Blätter nach „${name}“ verschoben.`, `Moved ${answer.copied} sheets to “${name}”.`)
            : answer.copied === 1
              ? t(`Blatt nach „${name}“ kopiert.`, `Copied the sheet to “${name}”.`)
              : t(`${answer.copied} Blätter nach „${name}“ kopiert.`, `Copied ${answer.copied} sheets to “${name}”.`),
        action: { label: t("Öffnen", "Open"), run: () => (window.location.hash = `page=${answer.target.id}`) },
      });
    } catch (e) {
      onError((e as Error).message);
    }
  };
  // Links on a sheet.
  const [linking, setLinking] = useState<{ sheet: string; link: NotebookLink | null } | null>(null);
  const saveLinks = async (sheetId: string, links: NotebookLink[]) => {
    setSheets((list) => list.map((s) => (s.id === sheetId ? { ...s, links: links.length ? links : undefined } : s)));
    await run({ action: "notebook.sheet.links", sheetId, links });
  };
  const saveLink = async (value: { label: string; target: NotebookLinkTarget; area: boolean }) => {
    const at = linking;
    setLinking(null);
    if (!at) return;
    const list = sheetsRef.current.find((s) => s.id === at.sheet)?.links || [];
    const size = sizesRef.current.get(at.sheet) || { width: 595, height: 842 };
    const link: NotebookLink = at.link
      ? { ...at.link, target: value.target, ...(value.label ? { label: value.label } : {}) }
      : {
          id: Math.random().toString(36).slice(2, 12),
          // A new one below the others, near the top left.
          x: 48,
          y: Math.min(size.height - 80, 48 + list.length * 44),
          w: value.area ? 220 : 160,
          h: value.area ? 90 : 28,
          ...(value.label ? { label: value.label } : {}),
          target: value.target,
        };
    if (!value.label) delete link.label;
    await saveLinks(at.sheet, at.link ? list.map((l) => (l.id === link.id ? link : l)) : [...list, link]);
  };
  const followLink = (target: NotebookLinkTarget) => {
    if ("sheet" in target) show(target.sheet, true);
    else window.location.hash = `page=${target.page}`;
  };
  const sheetName = useCallback(
    (sid: string) => {
      const i = sheetsRef.current.findIndex((s) => s.id === sid);
      const sheet = sheetsRef.current[i];
      return sheet?.title || t(`Blatt ${i + 1}`, `Sheet ${i + 1}`);
    },
    [t],
  );
  const [trashOpen, setTrashOpen] = useState(false);
  // Other parts of the notebook (the lasso: a heading for the contents).
  useEffect(() => {
    const take = (event: Event) => {
      const detail = (event as NotebookStructureEvent).detail;
      if (detail?.pageId === pageId && detail.answer && typeof detail.answer === "object" && "sheets" in detail.answer) apply(detail.answer as CommandAnswer);
    };
    window.addEventListener(NOTEBOOK_STRUCTURE_EVENT, take);
    return () => window.removeEventListener(NOTEBOOK_STRUCTURE_EVENT, take);
  }, [apply, pageId]);

  // ---- Paper dialog ----
  // The sheets the dialog is for (one, or a selection in the overview).
  const [paperFor, setPaperFor] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<Paper>(paper);
  const [scope, setScope] = useState<"sheet" | "all" | "new">("sheet");
  const openPaper = (sheetId: string | string[]) => {
    // PDF pages keep their page as background.
    const ids = (Array.isArray(sheetId) ? sheetId : [sheetId]).filter((sid) => !sheets.find((s) => s.id === sid)?.background);
    if (!ids.length) return;
    const sheet = sheets.find((s) => s.id === ids[0]);
    setDraft(effectivePaper(paper, sheet?.paper));
    setScope("sheet");
    setPaperFor(ids);
  };
  const savePaper = async () => {
    const sheetIds = paperFor;
    setPaperFor(null);
    if (!sheetIds?.length) return;
    if (scope === "sheet") {
      // Only what differs from the notebook is the sheet's own.
      const own: PaperOverride = {};
      for (const key of ["template", "size", "orientation", "color"] as const) if (draft[key] !== paper[key]) Object.assign(own, { [key]: draft[key] });
      await run({ action: "notebook.sheet.paper", sheetIds, paper: own });
    } else await run({ action: "notebook.paper", paper: draft, all: scope === "all" });
  };

  // ---- PDF import and export ----
  const fileInput = useRef<HTMLInputElement>(null);
  // Where the PDF chosen next goes; the dialog that asks.
  const pdfPlace = useRef<Place>({ after: null });
  const [inserting, setInserting] = useState<string | null>(null);
  const choosePdf = (place: Place) => {
    pdfPlace.current = place;
    fileInput.current?.click();
  };
  const importPdf = useCallback(
    async (file: File, place: Place = { after: currentRef.current || null }) => {
      // Full notebooks take no more sheets: said before anything is uploaded.
      const list = sheetsRef.current;
      const fresh = list.length === 1 && !list[0].background && !editor.docRef.current.pages[list[0].id]?.length;
      const room = Math.min(MAX_IMPORT_PAGES, MAX_SHEETS - list.length + (fresh ? 1 : 0));
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
        onError(t("Bitte ein PDF wählen.", "Please choose a PDF."));
        return;
      }
      if (room <= 0) {
        onError(t(`Ein Notizbuch hat höchstens ${MAX_SHEETS} Blätter.`, `A notebook has at most ${MAX_SHEETS} sheets.`));
        return;
      }
      setBusy(t("PDF wird hochgeladen …", "Uploading PDF …"));
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
        const count = Math.min(doc.numPages, room);
        const pages: PageSize[] = [];
        for (let i = 1; i <= count; i++) {
          if (i === 1 || i % 10 === 0) setBusy(t(`Seiten werden gelesen … ${i} von ${count}`, `Reading pages … ${i} of ${count}`));
          const viewport = (await doc.getPage(i)).getViewport({ scale: 1 });
          pages.push({ width: viewport.width, height: viewport.height });
        }
        setBusy(t("Blätter werden angelegt …", "Adding sheets …"));
        const answer = await run({ action: "notebook.import", fileId: uploaded.id, pages, ...place, replaceEmpty: true });
        if (answer && doc.numPages > count)
          setNotice({ text: t(`Nur die ersten ${count} von ${doc.numPages} Seiten wurden übernommen.`, `Only the first ${count} of ${doc.numPages} pages were taken over.`) });
        const first = answer?.created?.[0];
        if (first) requestAnimationFrame(() => show(first));
      } catch (e) {
        onError((e as Error).message || t("Das PDF konnte nicht importiert werden.", "The PDF could not be imported."));
      } finally {
        setBusy("");
      }
    },
    [editor, onError, pageId, run, show, sync, t],
  );
  // "Insert PDF": a notebook with nothing on it yet takes the PDF at once,
  // otherwise the dialog asks where (after the current sheet first).
  const insertPdf = () => {
    const list = sheetsRef.current;
    if (list.length === 1 && !list[0].background && !editor.docRef.current.pages[list[0].id]?.length) return choosePdf({ after: null });
    const at = list.findIndex((s) => s.id === currentRef.current);
    setInserting(at < 0 || at === list.length - 1 ? "end" : `after:${list[at].id}`);
  };
  const placeOf = (choice: string): Place => (choice === "start" ? { at: "start" } : choice.startsWith("after:") ? { after: choice.slice(6) } : { after: null });
  // "New notebook from PDF".
  useEffect(() => {
    if (!canEdit) return;
    const file = takeNotebookImport(pageId);
    if (file) void importPdf(file);
  }, [canEdit, importPdf, pageId]);
  // All sheets, or those chosen in the overview.
  const exportPdf = async (only?: string[]) => {
    setBusy(t("PDF wird erstellt …", "Creating PDF …"));
    try {
      if (canEdit) await sync.flush();
      const { notebookPdf, notebookPdfSheets } = await import("@/lib/ink/notebook-pdf");
      const doc = editor.docRef.current;
      const bytes = await notebookPdf(
        notebookPdfSheets(
          paper,
          sheets.filter((s) => !only || only.includes(s.id)).map((s) => ({ ...s, ink: doc })),
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

  // ---- Page overview, presenting, following ----
  const [overview, setOverview] = useState<"pages" | "outline" | null>(null);
  const live = useNotebookLive(pageId);
  // Presenting (follow: null) or following someone (their user id).
  const [presentation, setPresentation] = useState<{ follow: string | null } | null>(null);
  const presenter = live.presenters[0] || null;
  const followed = presentation?.follow ? live.presenters.find((p) => p.userId === presentation.follow) || null : null;
  // The presenter stopped: following ends with a word.
  const wasFollowing = useRef<string | null>(null);
  useEffect(() => {
    if (presentation?.follow && followed) wasFollowing.current = followed.name;
    if (presentation?.follow && !followed && wasFollowing.current) {
      const name = wasFollowing.current;
      wasFollowing.current = null;
      setPresentation(null);
      setNotice({ text: t(`${name} präsentiert nicht mehr.`, `${name} stopped presenting.`) });
    }
  }, [presentation, followed, t]);
  const overviewActions: OverviewActions = {
    show: (sid, y) => requestAnimationFrame(() => show(sid, true, y)),
    move: moveOrder,
    duplicate: duplicateMany,
    remove,
    bookmark,
    paper: (ids) => openPaper(ids),
    exportPdf: (ids) => exportPdf(ids),
    transfer: (ids) => setTransferring(ids),
    outline: saveOutline,
    addChapter: (sid) => setTitleFor({ kind: "chapter", sheet: sid }),
  };

  // ---- Keys ----
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
        zoomStep(1);
      } else if (mod && event.key === "-") {
        event.preventDefault();
        zoomStep(-1);
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
  }, [addSheet, canEdit, show, sync, zoomStep]);

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

  const sheetMenu = (sheet: NotebookSheet, index: number, close: () => void = () => setMenu(null)) => (
    <div ref={placeStartMenu} className="ink-menu notebook-menu" role="menu" aria-label={t(`Blatt ${index + 1}`, `Sheet ${index + 1}`)}>
      <button type="button" role="menuitem" onClick={() => (close(), void bookmark([sheet.id], !sheet.bookmark))}>
        <BookmarkSimple size={16} weight={sheet.bookmark ? "fill" : "regular"} /> {sheet.bookmark ? t("Lesezeichen entfernen", "Remove bookmark") : t("Als Lesezeichen", "Bookmark")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), setTitleFor({ kind: "rename", sheet: sheet.id }))}>
        <PencilSimpleLine size={16} /> {t("Umbenennen …", "Rename …")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), setTitleFor({ kind: "chapter", sheet: sheet.id }))}>
        <ListBullets size={16} /> {t("Seite als Kapitel markieren …", "Mark page as a chapter …")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), setLinking({ sheet: sheet.id, link: null }))}>
        <LinkSimple size={16} /> {t("Link einfügen …", "Insert link …")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), void addSheet(sheet.id))}>
        <Plus size={16} /> {t("Neues Blatt danach", "New sheet after")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), choosePdf(index === 0 ? { at: "start" } : { after: sheets[index - 1].id }))}>
        <FilePdf size={16} /> {t("PDF davor einfügen …", "Insert PDF before …")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), choosePdf({ after: sheet.id }))}>
        <FilePdf size={16} /> {t("PDF danach einfügen …", "Insert PDF after …")}
      </button>
      <button type="button" role="menuitem" onClick={() => (close(), void duplicate(sheet.id))}>
        <CopySimple size={16} /> {t("Duplizieren", "Duplicate")}
      </button>
      {!sheet.background && (
        <button type="button" role="menuitem" onClick={() => (close(), openPaper(sheet.id))}>
          <Rows size={16} /> {t("Papier ändern …", "Change paper …")}
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => (close(), setTransferring([sheet.id]))}>
        <FolderSimple size={16} /> {t("In anderes Notizbuch …", "To another notebook …")}
      </button>
      <button type="button" role="menuitem" disabled={index === 0} onClick={() => (close(), void move(sheet.id, index - 1))}>
        <ArrowUp size={16} /> {t("Nach oben", "Move up")}
      </button>
      <button type="button" role="menuitem" disabled={index === sheets.length - 1} onClick={() => (close(), void move(sheet.id, index + 1))}>
        <ArrowDown size={16} /> {t("Nach unten", "Move down")}
      </button>
      <button type="button" role="menuitem" className="danger" disabled={sheets.length <= 1} onClick={() => (close(), void remove([sheet.id]))}>
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
          <button
            type="button"
            className={`icon-button${overview ? " active" : ""}`}
            aria-pressed={!!overview}
            aria-label={t("Alle Blätter und Inhalt", "All sheets and contents")}
            title={t("Alle Blätter und Inhalt", "All sheets and contents")}
            onClick={() => setOverview(overview ? null : "pages")}
          >
            <SquaresFour size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("Präsentieren", "Present")}
            title={t("Präsentieren (Vollbild, andere können folgen)", "Present (full screen, others can follow)")}
            onClick={() => (setOverview(null), setPresentation({ follow: null }))}
          >
            <Presentation size={18} />
          </button>
          <span className="notebook-position" aria-live="polite">
            {t(`Blatt ${currentIndex + 1} von ${sheets.length}`, `Sheet ${currentIndex + 1} of ${sheets.length}`)}
          </span>
          <button type="button" className="icon-button" aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out") + keyHints.suffix("Mod+-")} onClick={() => zoomStep(-1)}>
            <MagnifyingGlassMinus size={18} />
          </button>
          <span className="notebook-zoom">{Math.round(zoom * 100)} %</span>
          <button type="button" className="icon-button" aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in") + keyHints.suffix("Mod+=")} onClick={() => zoomStep(1)}>
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
                <div ref={placeMenu} className="ink-menu notebook-menu" role="menu" aria-label={t("Blatt hinzufügen", "Add sheet")}>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(current || null))}>
                    {t("Nach dem aktuellen Blatt", "After the current sheet")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(null))}>
                    {t("Am Ende", "At the end")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), void addSheet(null, { at: "start" }))}>
                    {t("Vor dem ersten Blatt", "Before the first sheet")}
                  </button>
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), insertPdf())}>
                    <FilePdf size={16} /> {t("PDF einfügen …", "Insert PDF …")}
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
              <div ref={placeMenu} className="ink-menu notebook-menu notebook-menu-end" role="menu" aria-label={t("Weitere Aktionen", "More actions")}>
                {canEdit && (
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), insertPdf())}>
                    <FilePdf size={16} /> {t("PDF einfügen …", "Insert PDF …")}
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => (setMenu(null), void exportPdf())}>
                  <FileArrowDown size={16} /> {t("Als PDF exportieren", "Export as PDF")}
                </button>
                <button type="button" role="menuitem" onClick={() => (setMenu(null), setOverview("outline"))}>
                  <ListBullets size={16} /> {t("Inhaltsverzeichnis", "Table of contents")}
                </button>
                {canEdit && (
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), setTrashOpen(true))}>
                    <ArrowCounterClockwise size={16} /> {t("Gelöschte Blätter …", "Deleted sheets …")}
                  </button>
                )}
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
              if (file) void importPdf(file, pdfPlace.current);
            }}
          />
        </div>
      </div>
      {presenter && !presentation && (
        <p className="notebook-notice notebook-follow-notice" role="status">
          <Presentation size={16} aria-hidden="true" />
          {t(`${presenter.name} präsentiert dieses Notizbuch.`, `${presenter.name} is presenting this notebook.`)}
          <button type="button" className="button primary" onClick={() => (setOverview(null), setPresentation({ follow: presenter.userId }))}>
            {t("Folgen", "Follow")}
          </button>
        </p>
      )}
      {notice && (
        <p className={`notebook-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {notice.text}
          {notice.action && (
            <button type="button" className="text-button" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
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
                      aria-label={t(`Blatt ${index + 1}`, `Sheet ${index + 1}`) + (sheet.title ? `: ${sheet.title}` : "")}
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
                      <span className="notebook-thumb-frame">
                        <SheetPicture
                          sheet={sheet}
                          size={size}
                          layout={look.layout}
                          dark={look.paper.color === "dark" && !sheet.background}
                          doc={editor.doc}
                          width={120}
                          label={t(`Vorschau von Blatt ${index + 1}`, `Preview of sheet ${index + 1}`)}
                        />
                        {sheet.bookmark && <BookmarkRibbon label={t("Lesezeichen", "Bookmark")} />}
                      </span>
                      <span className="notebook-thumb-number">
                        {index + 1}
                        {sheet.title && <span className="notebook-thumb-title">{sheet.title}</span>}
                      </span>
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
        {overview && (
          <NotebookOverview
            sheets={sheets}
            sizes={sizes}
            layouts={layouts}
            doc={editor.doc}
            recognized={recognized}
            outline={outline}
            current={current}
            canEdit={canEdit}
            tab={overview}
            onTab={setOverview}
            actions={overviewActions}
            sheetMenu={sheetMenu}
            onClose={() => setOverview(null)}
          />
        )}
        <div className="notebook-scroll" ref={scroller} onScroll={onScroll}>
          <div className="notebook-sheets" ref={sheetsBox} style={{ width }}>
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
                    onConvert={canEdit && canRecognize ? () => void convert(sheet.id) : undefined}
                    label={t(`Handschrift auf Blatt ${index + 1}`, `Handwriting on sheet ${index + 1}`)}
                  />
                  {sheet.links && (
                    <SheetLinks
                      links={sheet.links}
                      size={size}
                      editable={canEdit}
                      areas={!canEdit || editor.tool === "lasso" || editor.tool === "laser"}
                      sheetName={sheetName}
                      onFollow={followLink}
                      onChange={(links) => void saveLinks(sheet.id, links)}
                      onEdit={(link) => setLinking({ sheet: sheet.id, link })}
                    />
                  )}
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
              {(paperFor?.length || 0) > 1 ? t(`Die ${paperFor!.length} ausgewählten Blätter`, `The ${paperFor!.length} selected sheets`) : t("Dieses Blatt", "This sheet")}
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
      <Modal open={!!inserting} onClose={() => setInserting(null)} title={t("PDF einfügen", "Insert PDF")} className="notebook-insert-dialog">
        <div className="notebook-paper-form">
          <p>
            {t(
              "Jede Seite des PDFs wird ein eigenes Blatt mit der Seite als Hintergrund; darauf schreibst du wie auf jedem Blatt.",
              "Each page of the PDF becomes a sheet of its own with the page as background; you write on it like on any sheet.",
            )}
          </p>
          <label className="notebook-insert-place">
            {t("Einfügen", "Insert")}
            <Select value={inserting || "end"} onChange={(e) => setInserting(e.target.value)}>
              <option value="start">{t("Vor dem ersten Blatt", "Before the first sheet")}</option>
              {sheets.slice(0, -1).map((s, i) => (
                <option key={s.id} value={`after:${s.id}`}>
                  {t(`Nach Blatt ${i + 1}`, `After sheet ${i + 1}`)}
                </option>
              ))}
              <option value="end">{t(`Am Ende (nach Blatt ${sheets.length})`, `At the end (after sheet ${sheets.length})`)}</option>
            </Select>
          </label>
          <p className="notebook-insert-hint">
            {t(
              `Höchstens ${MAX_IMPORT_PAGES} Seiten auf einmal, ${MAX_SHEETS} Blätter je Notizbuch.`,
              `At most ${MAX_IMPORT_PAGES} pages at a time, ${MAX_SHEETS} sheets per notebook.`,
            )}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setInserting(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                const choice = inserting || "end";
                setInserting(null);
                choosePdf(placeOf(choice));
              }}
            >
              <FilePdf size={16} /> {t("PDF wählen …", "Choose PDF …")}
            </button>
          </div>
        </div>
      </Modal>
      <TitleDialog
        open={!!titleFor}
        title={titleFor?.kind === "chapter" ? t("Seite als Kapitel markieren", "Mark page as a chapter") : t("Blatt umbenennen", "Rename sheet")}
        label={titleFor?.kind === "chapter" ? t("Titel des Kapitels", "Chapter title") : t("Titel des Blatts", "Sheet title")}
        hint={
          titleFor?.kind === "chapter"
            ? t("Das Kapitel erscheint im Inhaltsverzeichnis (Übersicht → Inhalt).", "The chapter shows in the table of contents (overview → Contents).")
            : t("Leer lassen für die Nummer.", "Leave empty for the number.")
        }
        initial={titleFor ? sheets.find((s) => s.id === titleFor.sheet)?.title || "" : ""}
        submit={titleFor?.kind === "chapter" ? t("Hinzufügen", "Add") : t("Speichern", "Save")}
        onClose={() => setTitleFor(null)}
        onSave={(value) => void saveTitle(value)}
      />
      <TransferDialog
        open={!!transferring}
        pageId={pageId}
        count={transferring?.length || 0}
        canMove={!!transferring && transferring.length < sheets.length}
        onClose={() => setTransferring(null)}
        onTransfer={(target, mode, place) => void transfer(target, mode, place)}
      />
      <LinkDialog
        open={!!linking}
        pageId={pageId}
        sheets={sheets}
        sheetId={linking?.sheet || ""}
        link={linking?.link || null}
        onClose={() => setLinking(null)}
        onSave={(value) => void saveLink(value)}
        onDelete={
          linking?.link
            ? () => {
                const at = linking;
                setLinking(null);
                if (at?.link) void saveLinks(at.sheet, (sheets.find((s) => s.id === at.sheet)?.links || []).filter((l) => l.id !== at.link!.id));
              }
            : undefined
        }
      />
      <TrashDialog open={trashOpen} pageId={pageId} onClose={() => setTrashOpen(false)} onRestore={restore} />
      {presentation && (!presentation.follow || followed) && (
        <NotebookPresentation
          pageId={pageId}
          title={title}
          sheets={sheets}
          sizes={sizes}
          layouts={layouts}
          doc={editor.doc}
          start={current}
          follow={presentation.follow ? followed : null}
          onPoint={live.onPoint}
          onFollowLink={(target) => {
            setPresentation(null);
            window.location.hash = `page=${target.page}`;
          }}
          onClose={(sid) => {
            setPresentation(null);
            requestAnimationFrame(() => show(sid));
          }}
        />
      )}
    </div>
  );
}
