"use client";
// "Meine Aufgaben": tasks from documents given to me (@me in the task), my
// own dated to-dos, the tasks in my journals and those of my own task page,
// grouped by due date; those of my other workspaces follow in their own
// section. Ticking one off changes the document it lives in.
//
// #208: "Aufgabe hinzufügen …" at the top writes a task into my own page
// "Aufgaben" (lib/personal-tasks.ts, made on first use in my private
// space); "Alle / Aus Dokumenten & Datenbanken / Eigene" narrows the list
// (remembered on this device); tasks others gave me since I last looked
// are marked "Neu" until I open My tasks again.
import { useLocale, useT } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { DURATION, EASE_OUT, prefersReducedMotion } from "@/lib/motion";
import { CheckSquare, Plus, X } from "@phosphor-icons/react";
import { optimistic } from "@/lib/optimistic";
import { api, PageIcon } from "./ui";
import { MyRecords } from "./my-records";
import { ListSkeleton } from "./skeleton";
import { dueLabel, dueState } from "@/lib/task-due-plugin";
import { dueGroupName, groupByDue } from "@/lib/due-groups";
import { statusName, type TaskStatus } from "@/lib/task-status";
import { TaskStatusIcon } from "./task-status-menu";

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
type Personal = { pageId: string | null; canAdd: boolean };
type Filter = "all" | "documents" | "own";
const FILTER_KEY = "flowplan.myTasks.filter";
const taskKey = (task: Task) => `${task.pageId}:${task.rowId}:${task.index}`;
// The device's today, for "morgen", "Freitag" … in a new task.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function storedFilter(): Filter {
  try {
    const value = localStorage.getItem(FILTER_KEY);
    return value === "documents" || value === "own" ? value : "all";
  } catch {
    return "all";
  }
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
  const [filter, setFilterState] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  // "Neu" stays on the tasks that were new when the list opened, while it is open.
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setFilterState(storedFilter()), []);
  const setFilter = (value: Filter) => {
    setFilterState(value);
    try {
      localStorage.setItem(FILTER_KEY, value);
    } catch {}
  };
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"tasks" | "records">("tasks");
  // Tasks just ticked off stay in their group, struck through, until they
  // have folded away (height and opacity) – then the reload drops them.
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
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
  }, [workspaceId, done, onError, onSeen]);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    setNotice("");
    try {
      const result = await api<{ unassigned?: string | null }>("/api/command", {
        action: "task.add",
        workspaceId,
        text,
        today: today(),
        ...(locale === "de" || locale === "en" || locale === "fr" ? { locale } : {}),
      });
      setDraft("");
      // "@name" of someone who cannot open the private page: not given to them.
      if (result.unassigned)
        setNotice(
          t(
            `${result.unassigned} kann deine Seite „Aufgaben“ nicht öffnen, der Name bleibt im Text. Aufgaben für andere schreibst du in ein Dokument, das ihr beide seht.`,
            `${result.unassigned} cannot open your page “Tasks”, so the name stays in the text. Write tasks for others in a document you both can see.`,
          ),
        );
      await load();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAdding(false);
      // Ready for the next one.
      requestAnimationFrame(() => input.current?.focus());
    }
  };
  const shown = (task: Task) => (filter === "all" ? true : filter === "own" ? !!task.own : !task.own);
  const change = async (task: Task, patch: { checked?: boolean; due?: string | null }) => {
    const key = `${task.pageId}:${task.rowId}:${task.index}`;
    setBusy(key);
    const leaving = patch.checked === true && !done && !task.checked;
    if (leaving) setSettling((s) => new Set(s).add(key));
    const same = (t: Task) =>
      t.pageId === task.pageId && t.rowId === task.rowId && t.index === task.index;
    const put = (value: Partial<Task>) => {
      setTasks((list) => list?.map((t) => (same(t) ? { ...t, ...value } : t)) || null);
      setOthers((list) =>
        list.map((w) => ({ ...w, tasks: w.tasks.map((t) => (same(t) ? { ...t, ...value } : t)) })),
      );
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
        if (leaving)
          setSettling((s) => {
            const n = new Set(s);
            n.delete(key);
            return n;
          });
      },
      onError: (e) => onError((e as Error).message),
    });
    try {
      if (sent) {
        if (leaving) await foldAway(key);
        await load();
        onChanged();
      }
    } finally {
      setBusy("");
      if (leaving)
        setSettling((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
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
  const item = (task: Task) => {
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
  return (
    <div className="utility-content my-tasks" ref={list}>
      <div className="utility-title">
        <CheckSquare size={30} />
        <h1>{t("Meine Aufgaben", "My tasks")}</h1>
        <p>
          {t("Aufgaben, die dir mit @Name gegeben wurden, deine eigenen und alle Aufgaben aus deinen Journalen.", "Tasks given to you with @name, your own and all tasks from your journals.")}
        </p>
      </div>
      <div className="my-tasks-tabs" role="tablist" aria-label={t("Bereich", "Section")}>
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
          {t("Aufgaben aus Dokumenten", "Tasks from documents")}
        </button>
        <button role="tab" aria-selected={tab === "records"} onClick={() => setTab("records")}>
          {t("Einträge aus Datenbanken", "Records from databases")}
        </button>
      </div>
      {tab === "records" ? (
        <MyRecords workspaceId={workspaceId} onOpen={(pageId, rowId) => onOpen(pageId, rowId)} onError={onError} />
      ) : (
      <>
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
          <small id="my-tasks-add-hint" className="my-tasks-add-hint">
            {t("Enter legt sie auf deiner Seite „Aufgaben“ an – „morgen“ oder „Freitag“ setzen das Datum.", "Enter adds it to your page “Tasks” – “tomorrow” or “Friday” set the date.")}
          </small>
        </form>
      )}
      {notice && (
        <p className="my-tasks-notice" role="status">
          {notice}
        </p>
      )}
      <div className="my-tasks-bar">
        <span className="segmented my-tasks-filter" role="radiogroup" aria-label={t("Aufgaben filtern", "Filter tasks")}>
          {(
            [
              ["all", t("Alle", "All")],
              ["documents", t("Aus Dokumenten & Datenbanken", "From documents & databases")],
              ["own", t("Eigene", "My own||tasks")],
            ] as const
          ).map(([value, label]) => (
            <label key={value} data-active={filter === value}>
              <input type="radio" name="my-tasks-filter" checked={filter === value} onChange={() => setFilter(value)} />
              {label}
            </label>
          ))}
        </span>
        <label className="my-tasks-done">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          {t("Erledigte zeigen", "Show completed")}
        </label>
        {personal.pageId && (
          <button type="button" className="text-button my-tasks-page-link" onClick={() => onOpen(personal.pageId!, null)}>
            {t("Seite „Aufgaben“ öffnen", "Open the page “Tasks”")}
          </button>
        )}
      </div>
      {!tasks ? (
        <ListSkeleton rows={4} label={t("Aufgaben werden geladen …", "Loading tasks …")} />
      ) : filter !== "all" && tasks.length > 0 && !tasks.some(shown) ? (
        <div className="empty-state">
          <CheckSquare size={28} />
          <p>
            {filter === "own"
              ? t("Keine eigenen Aufgaben offen. Schreib oben eine – sie landet auf deiner Seite „Aufgaben“.", "No tasks of your own are open. Write one above – it goes to your page “Tasks”.")
              : t("Keine offenen Aufgaben aus Dokumenten oder Datenbanken.", "No open tasks from documents or databases.")}
          </p>
        </div>
      ) : !tasks.length ? (
        <div className="empty-state">
          <CheckSquare size={28} />
          <p>
            {t("Keine offenen Aufgaben in diesem Arbeitsbereich. Schreib in einem Dokument eine Aufgabe mit", "No open tasks in this workspace. Write a task in a document with")}{" "}<code>[]</code> {t("und erwähne jemanden mit", "and mention someone with")}{" "}
            <code>@</code>{t(", um sie zu vergeben; das Datum setzt du mit dem Kalender-Knopf in der Werkzeugleiste.", " to assign it; set the date with the calendar button in the toolbar.")}
          </p>
        </div>
      ) : (
        groupByDue(
          // Tasks folding away keep their place until they are gone.
          (settling.size ? tasks.map((x) => (settling.has(taskKey(x)) ? { ...x, checked: false } : x)) : tasks).filter(shown),
        ).map(([name, list]) => (
          <section key={name} className={`my-tasks-group ${name === "Überfällig" ? "overdue" : ""}`}>
            <h2>
              {dueGroupName(name, t)} <small>{list.length}</small>
            </h2>
            <ul>
              {list.map(item)}
            </ul>
          </section>
        ))
      )}
      {others.some((w) => w.tasks.some(shown)) && (
        <section className="my-tasks-others" aria-labelledby="my-tasks-others">
          <h2 id="my-tasks-others">{t("Aus anderen Arbeitsbereichen", "From other workspaces")}</h2>
          {others
            .map((w) => ({ ...w, tasks: w.tasks.filter(shown) }))
            .filter((w) => w.tasks.length)
            .map((w) => (
              <section key={w.workspaceId} className="my-tasks-group" aria-label={w.name}>
                <h3>
                  {w.name} <small>{w.tasks.length}</small>
                </h3>
                <ul>{w.tasks.map(item)}</ul>
              </section>
            ))}
        </section>
      )}
      </>
      )}
    </div>
  );
}
