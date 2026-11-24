"use client";
// "Meine Aufgaben": one list of everything I have to do, grouped by due
// date – tasks from documents given to me (@me in the task), my own dated
// to-dos, the tasks in my journals and those of my own task page, and
// records from databases that can be done (a status or checkbox) with me in
// a person property. Tasks of my other workspaces follow in their own
// section. Ticking one off changes the document or the record it lives in.
//
// #208: "Aufgabe hinzufügen …" at the top writes a task into my own page
// "Aufgaben" (lib/personal-tasks.ts, made on first use in my private
// space); tasks others gave me since I last looked are marked "Neu" until I
// open My tasks again.
//
// #457: the chip at the end of the field chooses where it writes – the own
// page (default) or a task database the person may add records to
// (lib/my-task-target.ts, command `task.target`). Then the task becomes a
// record of it; when that database can no longer take tasks they go to the
// own page and a line below the field says why.
//
// #314: the two tabs ("Aufgaben aus Dokumenten", "Einträge aus
// Datenbanken") became this one list. The filter row – Quelle, Person, the
// date range and "Erledigte zeigen" – applies to both sources and is
// remembered on this device; the database picker, the search and the saved
// views only exist for records and say so. The server answers the two
// sources separately (/api/tasks, /api/records); they are merged here.
import { useLocale, useT } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DURATION, EASE_OUT, prefersReducedMotion } from "@/lib/motion";
import { CalendarBlank, CheckSquare, Plus, Tray, X } from "@phosphor-icons/react";
import { optimistic } from "@/lib/optimistic";
import { api, PageIcon } from "./ui";
import { RecordRow, RecordTools, RecordViews, type RecordsResult, type RecordView, type TaskRecord } from "./my-records";
import { ChipPopover } from "./chip-popover";
import { ListSkeleton } from "./skeleton";
import { dueLabel, dueState, localToday } from "@/lib/task-due";
import { dueGroupName, groupByDue } from "@/lib/due-groups";
import { DUE_RANGES, inDueRange, type DueRange } from "@/lib/due-range";
import { statusName, type TaskStatus } from "@/lib/task-status";
import { TaskStatusIcon } from "./task-status-menu";
import type { TaskTarget, TaskTargetProblem } from "@/lib/my-task-target";

type Task = {
  pageId: string;
  rowId: string | null;
  index: number;
  text: string;
  checked: boolean;
  // In progress, deferred, cancelled (#201); older servers send none.
  status?: TaskStatus;
  due: string | null;
  assigned: boolean;
  journal?: boolean;
  // In my own task page (#208).
  own?: boolean;
  // Given to me by someone else since I last opened My tasks.
  fresh?: boolean;
  title: string;
  icon: string;
  workspaceId?: string;
};
type Others = { workspaceId: string; name: string; tasks: Task[] }[];
type Personal = { pageId: string | null; canAdd: boolean; target?: TaskTarget };
type TargetDatabase = { id: string; title: string; icon: string; space: string };
type AddResult = {
  target?: "page" | "database";
  title?: string;
  unassigned?: string | null;
  unassignedReason?: "access" | "property" | null;
  fallback?: TaskTargetProblem | null;
};
// One line of the list: a task in a document or a record of a database.
type Entry =
  | { kind: "task"; key: string; due: string | null; checked: boolean; task: Task }
  | { kind: "record"; key: string; due: string | null; checked: boolean; record: TaskRecord };

type Source = "all" | "documents" | "databases";
// "mine": what the server gives me as mine – for documents every task it
// sends (given to me with @, my own to-dos and page, my journals), for
// records those with me in a person property. "all" widens the records to
// every one I can read; "own" is my page "Aufgaben" only.
type Person = "mine" | "all" | "own";
type Filters = { source: Source; person: Person; range: DueRange; done: boolean };
const DEFAULTS: Filters = { source: "all", person: "mine", range: "any", done: false };
const FILTERS_KEY = "flowplan.myTasks.filters";
// Before #314 only "Alle / Aus Dokumenten & Datenbanken / Eigene" was kept;
// "Eigene" carries over.
const OLD_FILTER_KEY = "flowplan.myTasks.filter";
const taskKey = (task: Task) => `${task.pageId}:${task.rowId}:${task.index}`;
const recordKey = (r: TaskRecord) => `record:${r.pageId}:${r.rowId}`;
// The device's today, for "morgen", "Freitag" … in a new task and the date ranges.
const today = () => localToday();

function storedFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Filters>;
      return {
        source: value.source === "documents" || value.source === "databases" ? value.source : "all",
        person: value.person === "all" || value.person === "own" ? value.person : "mine",
        range: DUE_RANGES.includes(value.range as DueRange) ? (value.range as DueRange) : "any",
        done: value.done === true,
      };
    }
    if (localStorage.getItem(OLD_FILTER_KEY) === "own") return { ...DEFAULTS, person: "own" };
  } catch {}
  return DEFAULTS;
}

export function MyTasks({
  workspaceId,
  onOpen,
  onError,
  onChanged,
  onSeen,
}: {
  workspaceId: string;
  onOpen: (pageId: string, rowId: string | null) => void;
  onError: (message: string) => void;
  onChanged: () => void;
  // My tasks opened: the badge of new tasks goes (#208).
  onSeen?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [others, setOthers] = useState<Others>([]);
  const [personal, setPersonal] = useState<Personal>({ pageId: null, canAdd: false });
  const [records, setRecords] = useState<RecordsResult | null>(null);
  const [filters, setFiltersState] = useState<Filters>(DEFAULTS);
  // Records only: which database, a search, the saved view shown. Not kept
  // on the device – a saved view is the way to keep them.
  const [database, setDatabase] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState("");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  // The target chip: its panel and the databases it offers (loaded on opening).
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetDatabases, setTargetDatabases] = useState<TargetDatabase[] | null>(null);
  const [targetBusy, setTargetBusy] = useState(false);
  // "Neu" stays on the tasks that were new when the list opened, while it is open.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The filters of this device come first; nothing loads before them, so
  // the list is not fetched twice (or shown with the wrong filters).
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setFiltersState(storedFilters());
    setReady(true);
  }, []);
  const setFilters = (patch: Partial<Filters>, keepView = false) => {
    if (!keepView) setView("");
    setFiltersState((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const { source, person, range, done } = filters;
  // Records take part unless only documents or only my own page are asked for.
  const wantRecords = source !== "documents" && person !== "own";
  const [busy, setBusy] = useState("");
  // Tasks just ticked off stay in their group, struck through, until they
  // have folded away (height and opacity) – then the reload drops them.
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const loadTasks = useCallback(async () => {
    if (!ready) return;
    try {
      const result = await api<{ tasks: Task[]; others?: Others; personal?: Personal }>(
        `/api/tasks?workspace=${workspaceId}${done ? "&done=1" : ""}`,
      );
      setTasks(result.tasks);
      setOthers(result.others || []);
      if (result.personal) setPersonal(result.personal);
      const now = [...result.tasks, ...(result.others || []).flatMap((w) => w.tasks)].filter((task) => task.fresh).map(taskKey);
      if (now.length) setFresh((current) => new Set([...current, ...now]));
      // Opened: what was new counts as seen from now on (once per opening).
      if (!seen.current) {
        seen.current = true;
        void api("/api/command", { action: "tasks.seen" })
          .then(() => onSeen?.())
          .catch(() => {});
      }
    } catch (e) {
      onError((e as Error).message);
    }
  }, [ready, workspaceId, done, onError, onSeen]);
  // The records' filter: the shared choices plus the record-only ones;
  // `tasks` leaves out databases without a status or checkbox (#314).
  const recordFilter = useMemo(
    () => ({
      mine: person === "mine",
      open: !done,
      due: range,
      databases: database ? [database] : [],
      query,
    }),
    [person, done, range, database, query],
  );
  // Only the answer to the latest filter is shown (typing in the search
  // sends several).
  const recordsTurn = useRef(0);
  const loadRecords = useCallback(async () => {
    if (!ready || !wantRecords) return;
    const turn = ++recordsTurn.current;
    try {
      const filter = { ...recordFilter, tasks: true, today: today() };
      const result = await api<RecordsResult>(`/api/records?workspace=${workspaceId}&filter=${encodeURIComponent(JSON.stringify(filter))}`);
      if (turn === recordsTurn.current) setRecords(result);
    } catch (e) {
      if (turn === recordsTurn.current) onError((e as Error).message);
    }
  }, [ready, workspaceId, wantRecords, recordFilter, onError]);
  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);
  useEffect(() => {
    // Typing in the search waits for a pause.
    const timer = setTimeout(() => void loadRecords(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadRecords, query]);
  const currentTarget = () => personal.target;
  const targetName = (target: TaskTarget | undefined) => (target?.kind === "database" ? target.title || t("Ohne Titel", "Untitled") : t("Aufgaben", "Tasks"));
  // Why a chosen database takes no tasks now.
  const fallbackText = (problem: TaskTargetProblem, target: TaskTarget | undefined) => {
    const name = targetName(target);
    const why =
      problem === "missing"
        ? t(`Die Datenbank „${name}“ gibt es nicht mehr`, `The database “${name}” no longer exists`)
        : problem === "readonly"
          ? t(`In „${name}“ darfst du keine Einträge mehr anlegen`, `You can no longer add records to “${name}”`)
          : t(`„${name}“ hat keinen Status und kein Erledigt-Häkchen mehr`, `“${name}” no longer has a status or a done checkbox`);
    return t(`${why} – neue Aufgaben landen auf deiner Seite „Aufgaben“.`, `${why} – new tasks go to your page “Tasks”.`);
  };
  const unassignedText = (result: AddResult) => {
    const who = result.unassigned!;
    if (result.target !== "database")
      return t(
        `${who} kann deine Seite „Aufgaben“ nicht öffnen, der Name bleibt im Text. Aufgaben für andere schreibst du in ein Dokument, das ihr beide seht.`,
        `${who} cannot open your page “Tasks”, so the name stays in the text. Write tasks for others in a document you both can see.`,
      );
    const name = result.title || t("Ohne Titel", "Untitled");
    return result.unassignedReason === "property"
      ? t(`„${name}“ hat keine Personen-Eigenschaft, die du ausfüllen darfst – ${who} bleibt im Text.`, `“${name}” has no person property you may fill – ${who} stays in the text.`)
      : t(`${who} kann „${name}“ nicht öffnen, der Name bleibt im Text.`, `${who} cannot open “${name}”, so the name stays in the text.`);
  };
  // The target chip opened: the databases to choose from.
  useEffect(() => {
    if (!targetOpen) return;
    let active = true;
    api<{ databases: TargetDatabase[]; target: TaskTarget }>(`/api/tasks/targets?workspace=${workspaceId}`)
      .then((r) => {
        if (!active) return;
        setTargetDatabases(r.databases);
        setPersonal((p) => ({ ...p, target: r.target }));
      })
      .catch((e) => active && onError((e as Error).message));
    return () => {
      active = false;
    };
  }, [targetOpen, workspaceId, onError]);
  const chooseTarget = async (databaseId: string | null) => {
    setTargetBusy(true);
    try {
      const r = await api<{ target: TaskTarget }>("/api/command", { action: "task.target", workspaceId, databaseId });
      setPersonal((p) => ({ ...p, target: r.target }));
      setNotice("");
      setTargetOpen(false);
      requestAnimationFrame(() => input.current?.focus());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setTargetBusy(false);
    }
  };
  const add = async () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    setNotice("");
    try {
      const result = await api<AddResult>("/api/command", {
        action: "task.add",
        workspaceId,
        text,
        today: today(),
        ...(locale === "de" || locale === "en" || locale === "fr" ? { locale } : {}),
      });
      setDraft("");
      const lines: string[] = [];
      // The chosen database could not take it: on the own page instead.
      if (result.fallback) lines.push(fallbackText(result.fallback, currentTarget()));
      // "@name" who cannot open the page or database: not given to them.
      if (result.unassigned) lines.push(unassignedText(result));
      setNotice(lines.join(" "));
      if (result.target === "database") {
        // A record: shown with the records, so the filters must let it through.
        if (source === "documents") setFilters({ source: "all" }, true);
        if (person === "own") setFilters({ person: "mine" }, true);
        void loadRecords();
      } else if (source === "databases") setFilters({ source: "all" }, true);
      await loadTasks();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAdding(false);
      // Ready for the next one.
      requestAnimationFrame(() => input.current?.focus());
    }
  };
  // The tasks from documents are filtered here, records by the server.
  const day = today();
  const shown = (task: Task) =>
    source !== "databases" && (person !== "own" || !!task.own) && inDueRange(task.due, task.checked, range, day);
  const settle = (key: string, on: boolean) =>
    setSettling((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  const change = async (task: Task, patch: { checked?: boolean; due?: string | null }) => {
    const key = taskKey(task);
    setBusy(key);
    const leaving = patch.checked === true && !done && !task.checked;
    if (leaving) settle(key, true);
    const same = (t: Task) => t.pageId === task.pageId && t.rowId === task.rowId && t.index === task.index;
    const put = (value: Partial<Task>) => {
      setTasks((list) => list?.map((t) => (same(t) ? { ...t, ...value } : t)) || null);
      setOthers((list) => list.map((w) => ({ ...w, tasks: w.tasks.map((t) => (same(t) ? { ...t, ...value } : t)) })));
    };
    // Shown at once (lib/optimistic.ts); a refusal puts the task back as it
    // was and the toast shows the server's message.
    const sent = await optimistic({
      key: `task:${key}`,
      apply: () => put(patch),
      commit: () =>
        api("/api/command", {
          action: "task.update",
          pageId: task.pageId,
          rowId: task.rowId,
          index: task.index,
          text: task.text,
          ...patch,
        }),
      rollback: () => {
        put({ checked: task.checked, due: task.due });
        if (leaving) settle(key, false);
      },
      onError: (e) => onError((e as Error).message),
    });
    try {
      if (sent) {
        if (leaving) await foldAway(key);
        await loadTasks();
        onChanged();
      }
    } finally {
      setBusy("");
      if (leaving) settle(key, false);
    }
  };
  // A record is ticked off the way the home and phone widgets do it
  // (lib/mobile-widget-actions.ts, task.complete): its checkbox, or the
  // first "done" option of its status – and back to the first open one.
  // Without the right to edit, the server refuses and it springs back.
  const tick = async (record: TaskRecord, checked: boolean) => {
    const key = recordKey(record);
    setBusy(key);
    const leaving = checked && !done && !record.done;
    if (leaving) settle(key, true);
    const put = (value: Partial<TaskRecord>) =>
      setRecords((r) => r && { ...r, records: r.records.map((x) => (x.rowId === record.rowId ? { ...x, ...value } : x)) });
    const sent = await optimistic({
      key: `task:${key}`,
      apply: () => put({ done: checked }),
      commit: () => api("/api/home/action", { action: "task.complete", source: "row", pageId: record.pageId, rowId: record.rowId, done: checked }),
      rollback: () => {
        put({ done: record.done });
        if (leaving) settle(key, false);
      },
      onError: (e) => onError((e as Error).message),
    });
    try {
      if (sent) {
        if (leaving) await foldAway(key);
        await loadRecords();
        onChanged();
      }
    } finally {
      setBusy("");
      if (leaving) settle(key, false);
    }
  };
  // Lets the struck-through task be seen briefly, then folds it away.
  async function foldAway(key: string) {
    const el = list.current?.querySelector<HTMLElement>(`li[data-task-key="${CSS.escape(key)}"]`);
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (!el.isConnected) return;
    el.style.overflow = "clip";
    await el
      .animate(
        [
          { height: `${el.offsetHeight}px`, opacity: 1 },
          { height: "0px", paddingTop: "0px", paddingBottom: "0px", borderBottomWidth: "0px", opacity: 0 },
        ],
        { duration: DURATION.slow, easing: EASE_OUT, fill: "forwards" },
      )
      .finished.catch(() => {});
  }
  const pickView = (v: RecordView | null) => {
    if (!v) {
      setView("");
      setDatabase("");
      setQuery("");
      return;
    }
    // A view is a choice of records: shown on their own, with its filters.
    setFilters(
      {
        source: "databases",
        person: v.filter.mine ? "mine" : "all",
        done: !v.filter.open,
        range: DUE_RANGES.includes(v.filter.due) ? v.filter.due : "any",
      },
      true,
    );
    setDatabase(v.filter.databases[0] || "");
    setQuery(v.filter.query);
    setView(v.id);
  };
  const saveView = async (name: string) => {
    try {
      const saved = await api<{ id: string }>("/api/command", { action: "recordView.save", workspaceId, name, filter: recordFilter });
      await loadRecords();
      setView(saved.id);
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  const deleteView = async (v: RecordView) => {
    await api("/api/command", { action: "recordView.delete", viewId: v.id }).catch((e) => onError((e as Error).message));
    if (view === v.id) setView("");
    void loadRecords();
  };

  const rangeNames: Record<DueRange, [string, string]> = {
    any: [t("Beliebig", "Any date"), t("Mit und ohne Datum", "With or without a date")],
    overdue: [t("Überfällig", "Overdue"), t("Fällig vor heute und noch offen", "Due before today and still open")],
    today: [t("Heute", "Today"), t("Heute fällig, dazu alles Überfällige", "Due today, plus everything overdue")],
    week: [t("Nächste 7 Tage", "Next 7 days"), t("Bis in 7 Tagen fällig, dazu alles Überfällige", "Due within 7 days, plus everything overdue")],
    dated: [t("Mit Datum", "With a date"), t("Alles mit Fälligkeit", "Everything with a due date")],
    undated: [t("Ohne Datum", "No date"), t("Alles ohne Fälligkeit", "Everything without a due date")],
  };
  const rangeLabel = range === "any" ? t("Beliebiges Datum", "Any date") : rangeNames[range][0];
  const segmented = <V extends string>(name: string, label: string, value: V, options: [V, string, string][], onPick: (v: V) => void, className: string) => (
    <span className={`segmented my-tasks-filter ${className}`} role="radiogroup" aria-label={label}>
      {options.map(([option, text, hint]) => (
        <label key={option} data-active={value === option} title={hint}>
          <input type="radio" name={name} checked={value === option} onChange={() => onPick(option)} />
          {text}
        </label>
      ))}
    </span>
  );

  // Both sources in one list: sorted by due date (undated last), so the
  // records fall in between the tasks of their group.
  const entries: Entry[] = [];
  for (const task of tasks || []) {
    if (!shown(task)) continue;
    const key = taskKey(task);
    // Tasks folding away keep their place until they are gone.
    entries.push({ kind: "task", key, due: task.due, checked: task.checked && !settling.has(key), task });
  }
  if (wantRecords)
    for (const record of records?.records || []) {
      const key = recordKey(record);
      entries.push({ kind: "record", key, due: record.due, checked: record.done && !settling.has(key), record });
    }
  entries.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const otherShown = others.map((w) => ({ ...w, tasks: w.tasks.filter(shown) })).filter((w) => w.tasks.length);
  const loading = !tasks || (wantRecords && !records);
  const filtered = source !== DEFAULTS.source || person !== DEFAULTS.person || range !== DEFAULTS.range || !!database || !!query;

  const taskItem = (task: Task) => {
    const key = taskKey(task);
    const checked = task.checked || settling.has(key);
    return (
      <li key={`${key}:${task.text}`} data-task-key={key} className={checked ? "checked" : ""}>
        <input
          type="checkbox"
          aria-label={`${task.text} erledigt`}
          checked={checked}
          disabled={busy === key}
          onChange={(e) => void change(task, { checked: e.target.checked })}
        />
        <span className="my-task-text">
          {task.text || t("Ohne Text", "No text")}
          {fresh.has(key) && !checked && (
            <span className="my-task-new" title={t("Dir gegeben seit deinem letzten Besuch hier", "Given to you since your last visit here")}>
              {t("Neu", "New||task")}
            </span>
          )}
        </span>
        {task.status && task.status !== "open" && task.status !== "done" && !settling.has(key) && (
          <span className="my-task-status" data-status={task.status}>
            <TaskStatusIcon status={task.status} />
            {statusName(t, task.status)}
          </span>
        )}
        <button type="button" className="my-task-page" onClick={() => onOpen(task.pageId, task.rowId)}>
          <PageIcon name={task.icon} size={14} />
          {task.title || t("Ohne Titel", "Untitled")}
        </button>
        <label className={`task-due ${task.due ? `task-due-${dueState(task.due, task.checked)}` : "task-due-add"}`}>
          {task.due ? (
            <>
              <span className="task-due-icon" aria-hidden="true">📅</span>
              {dueLabel(task.due)}
            </>
          ) : (
            t("+ Datum", "+ Date")
          )}
          <input
            type="date"
            aria-label={t(`Fälligkeit von ${task.text}`, `Due date of ${task.text}`)}
            value={task.due || ""}
            disabled={busy === key}
            onChange={(e) => void change(task, { due: e.target.value || null })}
          />
        </label>
        {task.due && (
          <button
            type="button"
            className="icon-button my-task-clear"
            aria-label={t(`Fälligkeit von ${task.text} entfernen`, `Remove due date of ${task.text}`)}
            title={t("Datum entfernen", "Remove date")}
            disabled={busy === key}
            onClick={() => void change(task, { due: null })}
          >
            <X size={13} />
          </button>
        )}
      </li>
    );
  };
  const item = (entry: Entry) =>
    entry.kind === "task" ? (
      taskItem(entry.task)
    ) : (
      <RecordRow
        key={entry.key}
        record={entry.record}
        taskKey={entry.key}
        checked={entry.record.done || settling.has(entry.key)}
        busy={busy === entry.key}
        settling={settling.has(entry.key)}
        onToggle={(checked) => void tick(entry.record, checked)}
        onOpen={() => onOpen(entry.record.pageId, entry.record.rowId)}
      />
    );

  // Why the list is empty, in the words of the filters that made it so.
  const empty = () => {
    if (person === "own")
      return t("Keine eigenen Aufgaben offen. Schreib oben eine – sie landet auf deiner Seite „Aufgaben“.", "No tasks of your own are open. Write one above – it goes to your page “Tasks”.");
    if (filtered || done) return t("Nichts passt zu diesen Filtern.", "Nothing matches these filters.");
    return (
      <>
        {t("Keine offenen Aufgaben in diesem Arbeitsbereich. Schreib in einem Dokument eine Aufgabe mit", "No open tasks in this workspace. Write a task in a document with")}{" "}<code>[]</code> {t("und erwähne jemanden mit", "and mention someone with")}{" "}
        <code>@</code>{t(", um sie zu vergeben; das Datum setzt du mit dem Kalender-Knopf in der Werkzeugleiste.", " to assign it; set the date with the calendar button in the toolbar.")}{" "}
        {t("Einträge aus Datenbanken mit Status erscheinen hier, wenn du in einer Personen-Eigenschaft stehst.", "Records from databases with a status show here when you are in a person property.")}
      </>
    );
  };

  const target = personal.target;
  const intoDatabase = target?.kind === "database" && !target.problem;
  // Where "Aufgabe hinzufügen" writes: the own page or a task database.
  const targetChip = () => (
    <ChipPopover
      icon={<Tray size={15} />}
      label={targetName(target)}
      name={t(`Ziel: ${targetName(target)}`, `Goes to: ${targetName(target)}`)}
      active={target?.kind === "database"}
      panelLabel={t("Neue Aufgaben landen in", "New tasks go to")}
      className="my-tasks-target"
      panelClassName="my-tasks-target-panel"
      open={targetOpen}
      onOpenChange={setTargetOpen}
    >
      <fieldset
        className="chip-panel chip-options my-tasks-targets"
        disabled={targetBusy}
        // Enter on a choice does not add the half-typed task (the panel sits in the form).
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
      >
        <legend className="sr-only">{t("Neue Aufgaben landen in", "New tasks go to")}</legend>
        <label data-active={target?.kind !== "database"}>
          <input type="radio" name="my-tasks-target" checked={target?.kind !== "database"} onChange={() => void chooseTarget(null)} />
          <span>
            {t("Meine Seite „Aufgaben“", "My page “Tasks”")}
            <small>{t("Ein Dokument in deinem privaten Bereich", "A document in your private space")}</small>
          </span>
        </label>
        {target?.kind === "database" && !targetDatabases?.some((d) => d.id === target.id) && (
          <label data-active="true">
            <input type="radio" name="my-tasks-target" checked readOnly />
            <span>
              {targetName(target)}
              <small>{target.problem ? t("Nimmt gerade keine Aufgaben an", "Takes no tasks right now") : t("Datenbank", "Database")}</small>
            </span>
          </label>
        )}
        {!targetDatabases ? (
          <p className="muted my-tasks-targets-note">{t("Wird geladen …", "Loading …")}</p>
        ) : (
          targetDatabases.map((d) => (
            <label key={d.id} data-active={target?.kind === "database" && target.id === d.id}>
              <input type="radio" name="my-tasks-target" checked={target?.kind === "database" && target.id === d.id} onChange={() => void chooseTarget(d.id)} />
              <span>
                <span className="my-tasks-target-name">
                  <PageIcon name={d.icon} size={14} />
                  {d.title || t("Ohne Titel", "Untitled")}
                </span>
                <small>{d.space}</small>
              </span>
            </label>
          ))
        )}
        {targetDatabases && !targetDatabases.length && (
          <p className="muted my-tasks-targets-note">
            {t(
              "Keine Datenbank mit Status oder Erledigt-Häkchen, in der du Einträge anlegen darfst.",
              "No database with a status or a done checkbox that you may add records to.",
            )}
          </p>
        )}
      </fieldset>
    </ChipPopover>
  );
  return (
    <div className="utility-content my-tasks" ref={list}>
      <div className="utility-title">
        <CheckSquare size={30} />
        <h1>{t("Meine Aufgaben", "My tasks")}</h1>
        <p>
          {t(
            "Aufgaben, die dir mit @Name gegeben wurden, deine eigenen, die aus deinen Journalen und Einträge aus Datenbanken mit Status, in denen du als Person eingetragen bist.",
            "Tasks given to you with @name, your own, those from your journals and records from databases with a status that list you in a person property.",
          )}
        </p>
      </div>
      {personal.canAdd && (
        <form
          className="my-tasks-add"
          // The hint shows while there is text: not on focus alone, which
          // would move the filter below away from a click that blurs the field.
          data-typing={draft.length > 0 || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Plus size={16} aria-hidden="true" />
          <input
            ref={input}
            type="text"
            value={draft}
            maxLength={500}
            disabled={adding}
            enterKeyHint="done"
            placeholder={t("Aufgabe hinzufügen …", "Add a task …")}
            aria-label={t("Aufgabe hinzufügen", "Add a task")}
            aria-describedby="my-tasks-add-hint"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft("")}
          />
          {targetChip()}
          <small id="my-tasks-add-hint" className="my-tasks-add-hint">
            {intoDatabase
              ? t(
                  `Enter legt sie als Eintrag in „${targetName(target)}“ an – „morgen“ oder „Freitag“ setzen das Fälligkeitsdatum, @Name die Person.`,
                  `Enter adds it as a record to “${targetName(target)}” – “tomorrow” or “Friday” set the due date, @name the person.`,
                )
              : t("Enter legt sie auf deiner Seite „Aufgaben“ an – „morgen“ oder „Freitag“ setzen das Datum.", "Enter adds it to your page “Tasks” – “tomorrow” or “Friday” set the date.")}
          </small>
        </form>
      )}
      {personal.canAdd && target?.kind === "database" && target.problem && !notice && (
        <p className="my-tasks-notice my-tasks-target-problem" role="status">
          {fallbackText(target.problem, target)}
        </p>
      )}
      {notice && (
        <p className="my-tasks-notice" role="status">
          {notice}
        </p>
      )}
      <div className="my-tasks-bar">
        {segmented(
          "my-tasks-source",
          t("Quelle", "Source"),
          source,
          [
            ["all", t("Alle", "All"), t("Aufgaben aus Dokumenten und Einträge aus Datenbanken", "Tasks from documents and records from databases")],
            ["documents", t("Dokumente", "Documents"), t("Aufgaben mit Kästchen in Dokumenten, Journalen und deiner Seite „Aufgaben“", "Tasks with a checkbox in documents, journals and your page “Tasks”")],
            ["databases", t("Datenbanken", "Databases"), t("Einträge aus Datenbanken mit Status oder Erledigt-Häkchen", "Records from databases with a status or a done checkbox")],
          ],
          (value) => setFilters({ source: value }),
          "my-tasks-source",
        )}
        {segmented(
          "my-tasks-person",
          t("Person", "Person"),
          person,
          [
            ["mine", t("Mir zugewiesen", "Assigned to me"), t("Dir mit @ gegebene, eigene und Journal-Aufgaben; Einträge, in denen du in einer Personen-Eigenschaft stehst", "Tasks given to you with @, your own and journal tasks; records that list you in a person property")],
            ["all", t("Alle", "All"), t("Dazu alle Einträge aus Datenbanken, die du sehen kannst", "Plus every record from databases you can see")],
            ["own", t("Eigene", "My own||tasks"), t("Nur deine Seite „Aufgaben“", "Only your page “Tasks”")],
          ],
          (value) => setFilters({ person: value }),
          "my-tasks-person",
        )}
        <ChipPopover
          icon={<CalendarBlank size={15} />}
          label={rangeLabel}
          name={t(`Fälligkeit: ${rangeLabel}`, `Due: ${rangeLabel}`)}
          active={range !== "any"}
          panelLabel={t("Fälligkeit", "Due")}
          className="my-tasks-range"
          panelClassName="my-tasks-range-panel"
          open={rangeOpen}
          onOpenChange={setRangeOpen}
        >
          <fieldset className="chip-panel chip-options my-tasks-ranges">
            <legend className="sr-only">{t("Fälligkeit", "Due")}</legend>
            {DUE_RANGES.map((option) => (
              <label key={option} data-active={range === option}>
                <input
                  type="radio"
                  name="my-tasks-range"
                  checked={range === option}
                  onChange={() => {
                    setFilters({ range: option });
                    setRangeOpen(false);
                  }}
                />
                <span>
                  {rangeNames[option][0]}
                  <small>{rangeNames[option][1]}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </ChipPopover>
        <label className="my-tasks-done">
          <input type="checkbox" checked={done} onChange={(e) => setFilters({ done: e.target.checked })} />
          {t("Erledigte zeigen", "Show completed")}
        </label>
        {intoDatabase ? (
          <button type="button" className="text-button my-tasks-page-link" onClick={() => onOpen(target.id, null)}>
            {t(`„${targetName(target)}“ öffnen`, `Open “${targetName(target)}”`)}
          </button>
        ) : (
          personal.pageId && (
            <button type="button" className="text-button my-tasks-page-link" onClick={() => onOpen(personal.pageId!, null)}>
              {t("Seite „Aufgaben“ öffnen", "Open the page “Tasks”")}
            </button>
          )
        )}
      </div>
      {wantRecords && records && (
        <div className="my-tasks-records">
          <RecordTools
            databases={records.databases}
            database={database}
            query={query}
            onDatabase={(id) => {
              setView("");
              setDatabase(id);
            }}
            onQuery={(value) => {
              setView("");
              setQuery(value);
            }}
            onSave={saveView}
          />
          <RecordViews views={records.views} active={view} onPick={pickView} onDelete={(v) => void deleteView(v)} />
        </div>
      )}
      {loading ? (
        <ListSkeleton rows={4} label={t("Aufgaben werden geladen …", "Loading tasks …")} />
      ) : !entries.length ? (
        <div className="empty-state">
          <CheckSquare size={28} />
          <p>{empty()}</p>
        </div>
      ) : (
        groupByDue(entries).map(([name, group]) => (
          <section key={name} className={`my-tasks-group ${name === "Überfällig" ? "overdue" : ""}`}>
            <h2>
              {dueGroupName(name, t)} <small>{group.length}</small>
            </h2>
            <ul>{group.map(item)}</ul>
          </section>
        ))
      )}
      {wantRecords && records?.limited && (
        <p className="muted">{t("Die ersten 500 Einträge – grenze die Suche ein.", "The first 500 records – narrow the search.")}</p>
      )}
      {otherShown.length > 0 && (
        <section className="my-tasks-others" aria-labelledby="my-tasks-others">
          <h2 id="my-tasks-others">{t("Aus anderen Arbeitsbereichen", "From other workspaces")}</h2>
          {otherShown.map((w) => (
            <section key={w.workspaceId} className="my-tasks-group" aria-label={w.name}>
              <h3>
                {w.name} <small>{w.tasks.length}</small>
              </h3>
              <ul>{w.tasks.map(taskItem)}</ul>
            </section>
          ))}
        </section>
      )}
    </div>
  );
}
