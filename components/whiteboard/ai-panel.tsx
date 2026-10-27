"use client";
// AI on whiteboards and the sticky → record bridge (see lib/whiteboard-ai.ts
// and lib/ai/whiteboard.ts). One hook for the board (components/whiteboard/
// whiteboard.tsx calls it once) that returns its entry points – the "KI"
// action in the toolbar (phones: the tool sheet), "Nach Thema gruppieren
// (KI)" in the arrange menu, "Als Einträge in Datenbank …" in the selection
// bar – and the dialog behind them.
//
// Results become ordinary board edits (one transaction each, so one undo
// step, synced to everyone like any edit). AI entries only show when the
// "whiteboard" feature is usable for the person; on a board closed to the
// AI the ones that read the board are disabled with the reason. Turning
// notes into records works without AI.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import { ArrowSquareOut, Database, FileText, Info, Sparkle, Stop, TreeStructure, UsersFour, Warning } from "@phosphor-icons/react";
import { aiPageReadable, aiUsable } from "@/lib/ai/client";
import { serverMessage } from "@/lib/i18n-errors";
import {
  freeSpot,
  generatedSchema,
  guessOption,
  STICKY_COLOR_NAMES,
  structureItems,
  themeLayout,
  WB_AI_LIMITS,
  type GenerateKind,
  type GeneratedStructure,
  type ThemeGroup,
} from "@/lib/whiteboard-ai";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { AiProviderFooter, useAi, useAiBlockedHint } from "../ai-context";
import { useLocale, useT } from "../i18n";
import { showToast, showUndo } from "../toast";
import { Modal, PageIcon, api } from "../ui";
import { Select } from "../select";

type Rect = { x: number; y: number; w: number; h: number };
export type BoardAiControl = {
  pageId: string;
  editable: boolean;
  selection: Set<string>;
  read: () => WhiteboardItem[];
  itemsMap: Y.Map<Y.Map<unknown>>;
  change: (fn: () => void) => void;
  addItem: (item: Omit<WhiteboardItem, "id" | "z"> & { z?: number }) => string;
  setProps: (id: string, props: Partial<WhiteboardItem>) => void;
  undo: Y.UndoManager;
  visibleRect: () => Rect;
  center: () => { x: number; y: number };
  setSelection: (ids: Set<string>) => void;
  fit: (list: WhiteboardItem[]) => void;
  // Saves pending board changes (the server reads the stored board).
  flush: () => Promise<void>;
  onOpenPage: (pageId: string) => void;
};
type BoardAction = { key: string; label: string; title: string; icon: ReactNode; run: () => void };
type View = "menu" | "cluster" | "summary" | "generate" | "records";
type Running = { text: string; abort: AbortController };
type DbField = { id: string; name: string; type: string; options?: string[] };

const isNote = (i: WhiteboardItem) => i.type === "sticky" && !i.locked && !i.covered;
const centreIn = (i: WhiteboardItem, r: Rect) => {
  const cx = i.x + i.w / 2,
    cy = i.y + i.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
};

// POST with JSON and an abort signal; errors in the reader's language.
async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage(data?.error || "Die KI-Anfrage ist fehlgeschlagen."));
  return data as T;
}

export function useBoardAi(ctl: BoardAiControl) {
  const t = useT();
  const locale = useLocale();
  const { status } = useAi();
  const blockedHint = useAiBlockedHint();
  const aiOn = ctl.editable && aiUsable(status, "whiteboard");
  const readable = aiOn && aiPageReadable(status, ctl.pageId);
  const [view, setView] = useState<View | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const runningRef = useRef<Running | null>(null);
  runningRef.current = running;
  // A request still running when the board goes away stops.
  useEffect(() => () => runningRef.current?.abort.abort(), []);

  // What an action works on: the selection, a selected frame's content or –
  // without a selection – what is in view (notes) or the whole board.
  function scope(kind: "notes" | "board") {
    const items = ctl.read();
    const selected = items.filter((i) => ctl.selection.has(i.id));
    if (selected.length === 1 && selected[0].type === "frame") {
      const frame = selected[0];
      return { items: items.filter((i) => i.id !== frame.id && centreIn(i, frame)), where: "frame" as const, name: frame.text || "" };
    }
    if (selected.length) return { items: selected, where: "selection" as const, name: "" };
    if (kind === "notes") return { items: items.filter((i) => centreIn(i, ctl.visibleRect())), where: "view" as const, name: "" };
    return { items, where: "board" as const, name: "" };
  }
  const scopeText = (s: ReturnType<typeof scope>, count: string) =>
    s.where === "frame"
      ? t(`${count} im Rahmen „${s.name || "Rahmen"}“`, `${count} in the frame “${s.name || "Frame"}”`)
      : s.where === "selection"
        ? t(`${count} ausgewählt`, `${count} selected`)
        : s.where === "view"
          ? t(`${count} im sichtbaren Bereich`, `${count} in view`)
          : t(`${count} auf dem ganzen Board`, `${count} on the whole board`);
  const notesCount = (n: number) => (n === 1 ? t("1 Zettel", "1 note") : t(`${n} Zettel`, `${n} notes`));

  function open(next: View) {
    setError("");
    setRetry(null);
    setView(next);
  }
  function close() {
    running?.abort.abort();
    setRunning(null);
    setView(null);
  }
  // Runs a request with progress, cancel and errors in the dialog.
  async function task<T>(text: string, work: (signal: AbortSignal, report: (text: string) => void) => Promise<T>, again: () => void): Promise<T | null> {
    const abort = new AbortController();
    setError("");
    setRetry(null);
    setRunning({ text, abort });
    const report = (next: string) => setRunning((current) => (current?.abort === abort ? { text: next, abort } : current));
    try {
      return await work(abort.signal, report);
    } catch (e) {
      if (abort.signal.aborted || (e as Error).name === "AbortError") return null;
      setError((e as Error).message || t("Die KI-Anfrage ist fehlgeschlagen.", "The AI request failed."));
      setRetry(() => again);
      return null;
    } finally {
      setRunning((current) => (current?.abort === abort ? null : current));
    }
  }
  // One board change = one undo step, offered in the toast as well.
  function apply(fn: () => void, message: string) {
    ctl.undo.stopCapturing();
    ctl.change(fn);
    ctl.undo.stopCapturing();
    showUndo(message, () => {
      ctl.undo.undo();
    });
  }

  // ---- Cluster by theme ----
  const [clusterInfo, setClusterInfo] = useState("");
  async function cluster(ids?: string[]) {
    const s = scope("notes");
    const notes = ids ? ctl.read().filter((i) => ids.includes(i.id) && isNote(i)) : s.items.filter(isNote);
    open("cluster");
    setClusterInfo(ids ? notesCount(notes.length) : scopeText(s, notesCount(notes.length)));
    if (notes.length < 2) {
      setError(t("Wähle mindestens zwei Notizzettel aus – oder zeige sie im sichtbaren Bereich.", "Select at least two sticky notes – or bring them into view."));
      return;
    }
    const again = () => void cluster(notes.map((n) => n.id));
    const result = await task(
      t("Die KI sucht Themen …", "The AI is looking for themes …"),
      async (signal) => {
        await ctl.flush();
        return post<{ groups: ThemeGroup[]; sent: number; skipped: number }>("/api/ai/whiteboard/cluster", { pageId: ctl.pageId, ids: notes.map((n) => n.id), locale }, signal);
      },
      again,
    );
    if (!result) return;
    // The notes as they are now (someone may have moved or removed one).
    const now = new Map(ctl.read().map((i) => [i.id, i]));
    const present = notes.map((n) => now.get(n.id)).filter((i): i is WhiteboardItem => !!i && isNote(i));
    const { positions, labels } = themeLayout(present, result.groups);
    apply(
      () => {
        for (const p of positions) ctl.setProps(p.id, { x: Math.round(p.x), y: Math.round(p.y) });
        for (const label of labels) ctl.addItem({ type: "text", x: label.x, y: label.y, w: label.w, h: 32, text: label.text, fontSize: 18, bold: true, align: "left" });
      },
      t(`${present.length} Zettel in ${labels.length} Themen gruppiert`, `${present.length} notes grouped into ${labels.length} themes`),
    );
    setView(null);
  }

  // ---- Summary page ----
  const [withTasks, setWithTasks] = useState(true);
  const [summaryDone, setSummaryDone] = useState<null | { pageId: string; title: string; included: number; total: number; parts: number; truncated: boolean; counts: Record<string, number> }>(null);
  async function summarize() {
    const s = scope("board");
    const ids = s.where === "board" ? undefined : s.items.map((i) => i.id);
    setSummaryDone(null);
    const result = await task(
      t("Die KI liest das Board und schreibt die Seite …", "The AI is reading the board and writing the page …"),
      async (signal) => {
        await ctl.flush();
        return post<NonNullable<typeof summaryDone>>("/api/ai/whiteboard/summarize", { pageId: ctl.pageId, ...(ids ? { ids } : {}), tasks: withTasks, locale }, signal);
      },
      () => void summarize(),
    );
    if (result) setSummaryDone(result);
  }

  // ---- Generate a mind map or flowchart ----
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<GenerateKind>("mindmap");
  async function generate() {
    if (prompt.trim().length < 3) return setError(t("Beschreibe kurz, was entstehen soll.", "Describe briefly what to create."));
    const result = await task(
      kind === "mindmap" ? t("Die KI entwirft die Mindmap …", "The AI is drafting the mind map …") : t("Die KI entwirft das Diagramm …", "The AI is drafting the diagram …"),
      (signal) => post<GeneratedStructure>("/api/ai/whiteboard/generate", { pageId: ctl.pageId, prompt: prompt.trim(), kind, locale }, signal),
      () => void generate(),
    );
    if (!result) return;
    // Checked again here: only the shapes and links the board knows.
    const parsed = generatedSchema.safeParse(result);
    if (!parsed.success || !parsed.data.nodes.length) return setError(t("Die KI hat keine verwertbare Antwort geliefert. Bitte erneut versuchen.", "The AI did not give a usable answer. Please try again."));
    const { shapes, connectors } = structureItems(parsed.data, ctl.center());
    // Not on top of what is already there: moved right to free space.
    const left = Math.min(...shapes.map((s) => s.item.x)),
      top = Math.min(...shapes.map((s) => s.item.y));
    const shift = freeSpot(
      { x: left, y: top, w: Math.max(...shapes.map((s) => s.item.x + s.item.w)) - left, h: Math.max(...shapes.map((s) => s.item.y + s.item.h)) - top },
      ctl.read().filter((i) => i.type !== "connector" && i.type !== "pen"),
    );
    for (const s of shapes) s.item.x += shift.dx;
    const created: string[] = [];
    apply(
      () => {
        const ids = new Map<string, string>();
        for (const s of shapes) {
          const id = ctl.addItem(s.item);
          ids.set(s.key, id);
          created.push(id);
        }
        for (const c of connectors) {
          const a = shapes.find((s) => s.key === c.from)!.item,
            b = shapes.find((s) => s.key === c.to)!.item;
          ctl.addItem({
            ...c.item,
            from: { id: ids.get(c.from)!, x: a.x + a.w / 2, y: a.y + a.h / 2 },
            to: { id: ids.get(c.to)!, x: b.x + b.w / 2, y: b.y + b.h / 2 },
          });
        }
      },
      kind === "mindmap" ? t("Mindmap erzeugt", "Mind map created") : t("Diagramm erzeugt", "Diagram created"),
    );
    if (parsed.data.dropped) showToast({ text: t(`${parsed.data.dropped} weitere Knoten wurden weggelassen (Höchstgrenze).`, `${parsed.data.dropped} more nodes were left out (limit).`) });
    ctl.setSelection(new Set(created));
    const placed = ctl.read().filter((i) => created.includes(i.id));
    const r = ctl.visibleRect();
    if (placed.some((i) => i.x < r.x || i.y < r.y || i.x + i.w > r.x + r.w || i.y + i.h > r.y + r.h)) ctl.fit(placed);
    setView(null);
  }

  // ---- Notes → database records ----
  const [notes, setNotes] = useState<WhiteboardItem[]>([]);
  function openRecords() {
    const s = scope("notes");
    setNotes(s.items.filter((i) => i.type === "sticky" && !i.covered && (i.text || "").trim()));
    open("records");
  }

  const entry: BoardAction | null = aiOn
    ? {
        key: "ai",
        label: t("KI", "AI"),
        title: t("KI auf dem Whiteboard: gruppieren, zusammenfassen, erzeugen", "AI on the whiteboard: group, summarise, create"),
        icon: <Sparkle size={18} />,
        run: () => open("menu"),
      }
    : null;
  const selectedNotes = (selected: WhiteboardItem[]) => selected.filter(isNote);
  const arrangeItem = (selected: WhiteboardItem[], done: () => void) =>
    aiOn && selectedNotes(selected).length >= 2 ? (
      <button
        role="menuitem"
        disabled={!readable}
        title={readable ? undefined : blockedHint}
        onClick={() => {
          done();
          void cluster(selectedNotes(selected).map((i) => i.id));
        }}
      >
        <Sparkle size={14} /> {t("Nach Thema gruppieren (KI)", "Group by theme (AI)")}
      </button>
    ) : null;
  const recordsButton = (selected: WhiteboardItem[]) =>
    ctl.editable && selected.some((i) => i.type === "sticky" && !i.covered && (i.text || "").trim()) ? (
      <button aria-label={t("Als Einträge in Datenbank …", "As records in database …")} title={t("Als Einträge in Datenbank …", "As records in database …")} onClick={openRecords}>
        <Database size={16} />
      </button>
    ) : null;

  const busy = !!running;
  const title =
    view === "cluster"
      ? t("Nach Thema gruppieren (KI)", "Group by theme (AI)")
      : view === "summary"
        ? t("Zusammenfassen als Seite", "Summarise as a page")
        : view === "generate"
          ? t("Mit KI erzeugen …", "Create with AI …")
          : view === "records"
            ? t("Als Einträge in Datenbank …", "As records in database …")
            : t("KI auf dem Whiteboard", "AI on the whiteboard");
  const progress = running && (
    <div className="wb-ai-progress" role="status" aria-live="polite">
      <span className="wb-ai-spinner" aria-hidden />
      <span>{running.text}</span>
      <button type="button" className="button compact" onClick={() => running.abort.abort()}>
        <Stop size={14} weight="fill" /> {t("Abbrechen", "Cancel")}
      </button>
    </div>
  );
  const failure = error && (
    <div className="wb-ai-error" role="alert">
      <Warning size={16} aria-hidden />
      <span>{error}</span>
      {retry && (
        <button type="button" className="button compact" onClick={() => retry()}>
          {t("Erneut versuchen", "Try again")}
        </button>
      )}
    </div>
  );
  const summaryScope = view === "summary" ? scope("board") : null;
  const elements = (n: number) => (n === 1 ? t("1 Element", "1 element") : t(`${n} Elemente`, `${n} elements`));
  const dialogs = (
    <Modal open={!!view} onClose={close} title={title} sheet className="wb-ai-dialog">
      {view === "menu" && (
        <div className="wb-ai-menu">
          <button type="button" disabled={!readable} onClick={() => void cluster()}>
            <UsersFour size={20} aria-hidden />
            <span>
              <strong>{t("Nach Thema gruppieren (KI)", "Group by theme (AI)")}</strong>
              <small>{readable ? t("Ausgewählte Zettel – oder alle im sichtbaren Bereich – nach Themen ordnen, mit Überschriften.", "Arrange the selected notes – or all in view – by theme, with headings.") : blockedHint}</small>
            </span>
          </button>
          <button type="button" disabled={!readable} onClick={() => open("summary")}>
            <FileText size={20} aria-hidden />
            <span>
              <strong>{t("Zusammenfassen als Seite", "Summarise as a page")}</strong>
              <small>{readable ? t("Themen, Entscheidungen, offene Fragen und Aufgaben als neue Seite neben dem Board.", "Themes, decisions, open questions and action items as a new page next to the board.") : blockedHint}</small>
            </span>
          </button>
          <button type="button" onClick={() => open("generate")}>
            <TreeStructure size={20} aria-hidden />
            <span>
              <strong>{t("Mit KI erzeugen …", "Create with AI …")}</strong>
              <small>{t("Eine Mindmap oder ein Flussdiagramm aus einer Beschreibung.", "A mind map or a flowchart from a description.")}</small>
            </span>
          </button>
          <button type="button" onClick={openRecords}>
            <Database size={20} aria-hidden />
            <span>
              <strong>{t("Als Einträge in Datenbank …", "As records in database …")}</strong>
              <small>{t("Zettel als Datenbankeinträge anlegen und als Karten aufs Board legen.", "Create records from notes and show them as cards on the board.")}</small>
            </span>
          </button>
          <AiProviderFooter />
        </div>
      )}
      {view === "cluster" && (
        <div className="wb-ai-body">
          <p className="muted">{clusterInfo}</p>
          {progress}
          {failure}
          <AiProviderFooter />
        </div>
      )}
      {view === "summary" && summaryScope && (
        <div className="wb-ai-body">
          {summaryDone ? (
            <>
              <p role="status">{t(`Die Seite „${summaryDone.title}“ wurde neben dem Board angelegt.`, `The page “${summaryDone.title}” was created next to the board.`)}</p>
              <p className="muted small">
                {t(
                  `${summaryDone.counts.themes} Themen · ${summaryDone.counts.decisions} Entscheidungen · ${summaryDone.counts.questions} offene Fragen · ${summaryDone.counts.actions} Aufgaben`,
                  `${summaryDone.counts.themes} themes · ${summaryDone.counts.decisions} decisions · ${summaryDone.counts.questions} open questions · ${summaryDone.counts.actions} action items`,
                )}
              </p>
              {(summaryDone.included < summaryDone.total || summaryDone.truncated || summaryDone.parts > 1) && (
                <p className="ai-summary-note">
                  <Info size={14} aria-hidden />
                  <span>
                    {summaryDone.included < summaryDone.total &&
                      t(`${summaryDone.included} von ${summaryDone.total} Elementen berücksichtigt (Höchstgrenze); ${summaryDone.total - summaryDone.included} wurden weggelassen.`, `${summaryDone.included} of ${summaryDone.total} elements included (limit); ${summaryDone.total - summaryDone.included} were left out.`)}
                    {summaryDone.parts > 1 && ` ${t(`Großes Board: in ${summaryDone.parts} Teilen gelesen.`, `Large board: read in ${summaryDone.parts} parts.`)}`}
                    {summaryDone.truncated && ` ${t("Sehr groß: nur der Anfang wurde berücksichtigt.", "Very large: only the beginning was included.")}`}
                  </span>
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="button" onClick={close}>
                  {t("Schließen", "Close")}
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    const id = summaryDone.pageId;
                    close();
                    ctl.onOpenPage(id);
                  }}
                >
                  <ArrowSquareOut size={16} /> {t("Seite öffnen", "Open page")}
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void summarize();
              }}
            >
              <p className="muted">{scopeText(summaryScope, elements(summaryScope.items.filter((i) => i.type !== "connector" && i.type !== "pen").length))}</p>
              <label className="checkbox-label">
                <input type="checkbox" checked={withTasks} disabled={busy} onChange={(e) => setWithTasks(e.target.checked)} />
                {t("Aufgaben übernehmen (als Aufgaben mit Person und Termin)", "Take over action items (as tasks with person and due date)")}
              </label>
              {progress}
              {failure}
              {!busy && (
                <div className="modal-actions">
                  <button type="button" className="button" onClick={close}>
                    {t("Abbrechen", "Cancel")}
                  </button>
                  <button className="button primary">
                    <Sparkle size={16} /> {t("Seite erstellen", "Create page")}
                  </button>
                </div>
              )}
              <AiProviderFooter />
            </form>
          )}
        </div>
      )}
      {view === "generate" && (
        <form
          className="wb-ai-body"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <div className="segmented" role="radiogroup" aria-label={t("Art", "Kind")}>
            <label data-active={kind === "mindmap"}>
              <input type="radio" name="wb-ai-kind" checked={kind === "mindmap"} disabled={busy} onChange={() => setKind("mindmap")} />
              {t("Mindmap", "Mind map")}
            </label>
            <label data-active={kind === "flowchart"}>
              <input type="radio" name="wb-ai-kind" checked={kind === "flowchart"} disabled={busy} onChange={() => setKind("flowchart")} />
              {t("Flussdiagramm", "Flowchart")}
            </label>
          </div>
          <label className="wb-ai-field">
            {t("Beschreibung", "Description")}
            <textarea
              rows={4}
              maxLength={WB_AI_LIMITS.prompt}
              value={prompt}
              disabled={busy}
              placeholder={
                kind === "mindmap"
                  ? t("z. B. Ideen für unser Sommerfest", "e.g. ideas for our summer party")
                  : t("z. B. Ablauf einer Urlaubsanfrage mit Genehmigung", "e.g. how a holiday request is approved")
              }
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void generate();
                }
              }}
            />
          </label>
          <p className="muted small">{t("Entsteht in der Mitte des sichtbaren Bereichs; mit Rückgängig wieder weg.", "Appears in the middle of the view; undo removes it again.")}</p>
          {progress}
          {failure}
          {!busy && (
            <div className="modal-actions">
              <button type="button" className="button" onClick={close}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button className="button primary" disabled={prompt.trim().length < 3}>
                <Sparkle size={16} /> {t("Erzeugen", "Create")}
              </button>
            </div>
          )}
          <AiProviderFooter />
        </form>
      )}
      {view === "records" && (
        <RecordsForm
          ctl={ctl}
          notes={notes}
          aiOn={readable}
          busy={busy}
          progress={progress}
          failure={failure}
          task={task}
          setError={setError}
          onDone={(message, databaseId) => {
            setView(null);
            showToast({ text: message, action: { label: t("Datenbank öffnen", "Open database"), run: () => ctl.onOpenPage(databaseId) } });
          }}
          onCancel={close}
          apply={apply}
        />
      )}
    </Modal>
  );
  return { entry, arrangeItem, recordsButton, dialogs };
}

type SplitView = Record<string, { cells: Record<string, unknown>; view: { name: string; value: string }[]; problem?: string }>;
function RecordsForm({
  ctl,
  notes,
  aiOn,
  busy,
  progress,
  failure,
  task,
  setError,
  onDone,
  onCancel,
  apply,
}: {
  ctl: BoardAiControl;
  notes: WhiteboardItem[];
  aiOn: boolean;
  busy: boolean;
  progress: ReactNode;
  failure: ReactNode;
  task: <T>(text: string, work: (signal: AbortSignal, report: (text: string) => void) => Promise<T>, again: () => void) => Promise<T | null>;
  setError: (message: string) => void;
  onDone: (message: string, databaseId: string) => void;
  onCancel: () => void;
  apply: (fn: () => void, message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [targets, setTargets] = useState<{ id: string; title: string; icon: string }[] | null>(null);
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<DbField[] | null>(null);
  const [colorField, setColorField] = useState("");
  const [colorOptions, setColorOptions] = useState<Record<string, string>>({});
  const [personField, setPersonField] = useState("");
  const [mode, setMode] = useState<"replace" | "link">("replace");
  const [split, setSplit] = useState(false);
  const [preview, setPreview] = useState<SplitView | null>(null);
  const { status } = useAi();
  useEffect(() => {
    void api<{ id: string; title: string; icon: string }[]>(`/api/transfer-targets?page=${ctl.pageId}`)
      .then((list) => {
        setTargets(list);
        if (list.length === 1) setTarget(list[0].id);
      })
      .catch(() => setTargets([]));
  }, [ctl.pageId]);
  useEffect(() => {
    setFields(null);
    setColorField("");
    setPersonField("");
    setPreview(null);
    if (!target) return;
    let alive = true;
    void api<{ database: { fields: DbField[] } }>(`/api/pages/${target}`)
      .then((data) => alive && setFields(data.database.fields))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [target, setError]);
  const colors = useMemo(() => [...new Set(notes.map((n) => n.fill || "#fff6b6"))], [notes]);
  const selects = (fields || []).slice(1).filter((f) => f.type === "select");
  const people = (fields || []).slice(1).filter((f) => f.type === "person");
  const options = selects.find((f) => f.id === colorField)?.options || [];
  useEffect(() => {
    setColorOptions(Object.fromEntries(colors.map((c) => [c, guessOption(c, options)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorField, fields, colors]);
  const splitAllowed = aiOn && !!target && !(status?.excludedPages || []).includes(target);
  const shown = (targets || []).filter((x) => x.title.toLowerCase().includes(query.trim().toLowerCase()));
  const tooMany = notes.length > WB_AI_LIMITS.records;
  const list = notes.slice(0, WB_AI_LIMITS.records);
  const databaseName = targets?.find((x) => x.id === target)?.title || "";
  const colorName = (c: string) => (STICKY_COLOR_NAMES[c] ? t(...STICKY_COLOR_NAMES[c]) : c);

  async function runSplit() {
    const out: SplitView = {};
    const result = await task(
      t("Die KI liest die Zettel …", "The AI is reading the notes …"),
      async (signal, report) => {
        for (let i = 0; i < list.length; i += WB_AI_LIMITS.split) {
          if (i) report(t(`Die KI liest die Zettel … ${i} von ${list.length}`, `The AI is reading the notes … ${i} of ${list.length}`));
          await ctl.flush();
          const part = await post<{ records: SplitView }>(
            "/api/ai/whiteboard/split",
            { pageId: ctl.pageId, databaseId: target, ids: list.slice(i, i + WB_AI_LIMITS.split).map((n) => n.id), locale },
            signal,
          );
          Object.assign(out, part.records);
        }
        return out;
      },
      () => void runSplit(),
    );
    if (result) setPreview(result);
  }
  // Record ids chosen once per note and target: a retry after a failure
  // finds the records already created and does not create them twice.
  const rowIds = useRef(new Map<string, string>());
  async function create() {
    const rowId = (itemId: string) => {
      const key = `${target}:${itemId}`;
      if (!rowIds.current.has(key)) rowIds.current.set(key, crypto.randomUUID());
      return rowIds.current.get(key)!;
    };
    const rows = list.map((n) => {
      const cells = preview?.[n.id]?.cells;
      return { itemId: n.id, rowId: rowId(n.id), text: n.text || "", color: n.fill || "#fff6b6", author: n.author || null, ...(cells && Object.keys(cells).length ? { cells } : {}) };
    });
    const done: { itemId: string; rowId: string }[] = [];
    const result = await task(
      t(`Einträge werden angelegt … 0 von ${rows.length}`, `Creating records … 0 of ${rows.length}`),
      async (signal, report) => {
        for (let i = 0; i < rows.length; i += WB_AI_LIMITS.batch) {
          if (signal.aborted) break;
          const answer = await api<{ records: { itemId: string; rowId: string }[] }>("/api/command", {
            action: "whiteboard.toRecords",
            pageId: ctl.pageId,
            databaseId: target,
            ...(colorField ? { colorField, colorOptions: Object.fromEntries(Object.entries(colorOptions).filter(([, v]) => v)) } : {}),
            ...(personField ? { personField } : {}),
            records: rows.slice(i, i + WB_AI_LIMITS.batch),
          });
          done.push(...answer.records);
          report(t(`Einträge werden angelegt … ${done.length} von ${rows.length}`, `Creating records … ${done.length} of ${rows.length}`));
        }
        return done;
      },
      () => void create(),
    );
    // Whatever was created so far goes onto the board, even after a stop.
    if (!done.length) return;
    const items = new Map(ctl.read().map((i) => [i.id, i]));
    const placed = done.map((d) => ({ ...d, note: items.get(d.itemId) })).filter((d) => d.note);
    const bounds = placed.length ? { right: Math.max(...placed.map((d) => d.note!.x + d.note!.w)) } : { right: 0 };
    const created: string[] = [];
    const count = placed.length;
    apply(
      () => {
        const sorted = [...placed].sort((a, b) => a.note!.y - b.note!.y || a.note!.x - b.note!.x);
        let y = sorted.length ? Math.min(...sorted.map((d) => d.note!.y)) : 0;
        for (const d of sorted) {
          const note = d.note!;
          if (mode === "replace") {
            const id = ctl.addItem({ type: "card", pageId: target, rowId: d.rowId, x: note.x, y: note.y, w: Math.max(240, note.w), h: Math.max(110, Math.min(note.h, 140)), fill: "#e0782c" });
            created.push(id);
            // Connectors keep their ends: now on the card.
            for (const c of ctl.read())
              if (c.type === "connector")
                for (const end of ["from", "to"] as const)
                  if (c[end]?.id === note.id) ctl.setProps(c.id, { [end]: { ...c[end]!, id } });
            ctl.itemsMap.delete(note.id);
          } else {
            const id = ctl.addItem({ type: "card", pageId: target, rowId: d.rowId, x: bounds.right + 120, y, w: 240, h: 110, fill: "#e0782c" });
            y += 130;
            created.push(id);
            ctl.addItem({ type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: note.id, x: note.x + note.w, y: note.y + note.h / 2 }, to: { id, x: bounds.right + 120, y: y - 75 }, stroke: "#868e96", strokeWidth: 2, dashed: true, endArrow: true, route: "curved" });
          }
        }
      },
      mode === "replace" ? t(`${count} Zettel durch Eintragskarten ersetzt`, `${count} notes replaced by record cards`) : t(`${count} Eintragskarten verknüpft`, `${count} record cards linked`),
    );
    ctl.setSelection(new Set(created));
    if (result)
      onDone(
        done.length === 1 ? t(`1 Eintrag in „${databaseName}“ angelegt.`, `1 record created in “${databaseName}”.`) : t(`${done.length} Einträge in „${databaseName}“ angelegt.`, `${done.length} records created in “${databaseName}”.`),
        target,
      );
  }

  if (!notes.length)
    return (
      <div className="wb-ai-body">
        <p>{t("Wähle Notizzettel mit Text aus – sie werden zu Einträgen.", "Select sticky notes with text – they become records.")}</p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onCancel}>
            {t("Schließen", "Close")}
          </button>
        </div>
      </div>
    );
  return (
    <form
      className="wb-ai-body transfer-dialog"
      onSubmit={(e) => {
        e.preventDefault();
        if (!target || busy) return;
        if (split && splitAllowed && !preview) void runSplit();
        else void create();
      }}
    >
      <p className="muted">
        {notes.length === 1 ? t("1 Zettel wird zu einem Eintrag.", "1 note becomes a record.") : t(`${notes.length} Zettel werden zu Einträgen.`, `${notes.length} notes become records.`)}
        {tooMany && ` ${t(`Höchstens ${WB_AI_LIMITS.records} auf einmal – die übrigen bleiben Zettel.`, `At most ${WB_AI_LIMITS.records} at once – the others stay notes.`)}`}
      </p>
      {targets && targets.length > 6 && (
        <input type="search" aria-label={t("Datenbank suchen", "Search database")} placeholder={t("Datenbank suchen …", "Search database …")} value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div className="transfer-targets wb-ai-targets" role="radiogroup" aria-label={t("Ziel-Datenbank", "Target database")}>
        {!targets ? (
          <p className="muted">{t("Wird geladen …", "Loading …")}</p>
        ) : !targets.length ? (
          <p className="muted">{t("Es gibt keine Datenbank, in die du schreiben darfst.", "There is no database you may write to.")}</p>
        ) : (
          shown.map((x) => (
            <label key={x.id} className="transfer-target" data-active={target === x.id}>
              <input type="radio" name="wb-records-target" checked={target === x.id} disabled={busy} onChange={() => setTarget(x.id)} />
              <PageIcon name={x.icon} size={16} />
              <span>{x.title || t("Ohne Titel", "Untitled")}</span>
            </label>
          ))
        )}
      </div>
      {target && fields && (
        <fieldset className="wb-ai-mapping" disabled={busy}>
          <legend>{t("Zuordnung", "Mapping")}</legend>
          <div className="wb-ai-map-row">
            <span>{t("Zetteltext", "Note text")}</span>
            <span aria-hidden>→</span>
            <strong>{fields[0]?.name || t("Titel", "Title")}</strong>
          </div>
          <label className="wb-ai-map-row">
            <span>{t("Farbe", "Colour")}</span>
            <span aria-hidden>→</span>
            <Select aria-label={t("Eigenschaft für die Farbe", "Property for the colour")} value={colorField} onChange={(e) => setColorField(e.target.value)}>
              <option value="">{t("– nicht übernehmen –", "– do not use –")}</option>
              {selects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
          {colorField &&
            colors.map((c) => (
              <label key={c} className="wb-ai-map-row wb-ai-color">
                <span>
                  <i className="wb-ai-swatch" style={{ background: c }} aria-hidden /> {colorName(c)}
                </span>
                <span aria-hidden>→</span>
                <Select aria-label={t(`Option für ${colorName(c)}`, `Option for ${colorName(c)}`)} value={colorOptions[c] || ""} onChange={(e) => setColorOptions({ ...colorOptions, [c]: e.target.value })}>
                  <option value="">{t("– leer –", "– empty –")}</option>
                  {options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          <label className="wb-ai-map-row">
            <span>{t("Autor", "Author")}</span>
            <span aria-hidden>→</span>
            <Select aria-label={t("Eigenschaft für den Autor", "Property for the author")} value={personField} onChange={(e) => setPersonField(e.target.value)}>
              <option value="">{t("– nicht übernehmen –", "– do not use –")}</option>
              {people.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
          {!selects.length && !people.length && <p className="muted small">{t("Die Datenbank hat keine Auswahl- oder Personen-Eigenschaft.", "The database has no select or person property.")}</p>}
        </fieldset>
      )}
      <div className="segmented" role="radiogroup" aria-label={t("Zettel auf dem Board", "Notes on the board")}>
        <label data-active={mode === "replace"}>
          <input type="radio" name="wb-records-mode" checked={mode === "replace"} disabled={busy} onChange={() => setMode("replace")} />
          {t("Durch Karten ersetzen", "Replace with cards")}
        </label>
        <label data-active={mode === "link"}>
          <input type="radio" name="wb-records-mode" checked={mode === "link"} disabled={busy} onChange={() => setMode("link")} />
          {t("Behalten und verknüpfen", "Keep and link")}
        </label>
      </div>
      {splitAllowed && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={split}
            disabled={busy}
            onChange={(e) => {
              setSplit(e.target.checked);
              setPreview(null);
            }}
          />
          <Sparkle size={14} aria-hidden /> {t("Mit KI aufteilen: weitere Eigenschaften aus dem Text füllen", "Split with AI: fill further properties from the text")}
        </label>
      )}
      {preview && (
        <ul className="wb-ai-preview" aria-label={t("Vorschau", "Preview")}>
          {list.map((n) => {
            const p = preview[n.id];
            return (
              <li key={n.id}>
                <strong>{(n.text || "").split("\n")[0]}</strong>
                {p?.view.length ? <span>{p.view.map((v) => `${v.name}: ${v.value}`).join(" · ")}</span> : <span className="muted">{t("Keine weiteren Werte", "No further values")}</span>}
                {p?.problem && <span className="wb-ai-problem">{p.problem}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {progress}
      {failure}
      {!busy && (
        <div className="modal-actions">
          <button type="button" className="button" onClick={onCancel}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={!target || !fields}>
            {split && splitAllowed && !preview
              ? t("Vorschau mit KI", "Preview with AI")
              : list.length === 1
                ? t("1 Eintrag anlegen", "Create 1 record")
                : t(`${list.length} Einträge anlegen`, `Create ${list.length} records`)}
          </button>
        </div>
      )}
      {split && splitAllowed && <AiProviderFooter />}
    </form>
  );
}
