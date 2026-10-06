"use client";
// "Meine Aufgaben": tasks from documents given to me (@me in the task), my
// own dated to-dos and the tasks in my journals, grouped by due date; those
// of my other workspaces follow in their own section. Ticking one off
// changes the document it lives in.
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { CheckSquare, X } from "@phosphor-icons/react";
import { api, PageIcon } from "./ui";
import { MyRecords } from "./my-records";
import { dueLabel, dueState, localToday } from "@/lib/task-due-plugin";

type Task = {
  pageId: string;
  rowId: string | null;
  index: number;
  text: string;
  checked: boolean;
  due: string | null;
  assigned: boolean;
  journal?: boolean;
  title: string;
  icon: string;
  workspaceId?: string;
};
type Others = { workspaceId: string; name: string; tasks: Task[] }[];
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// Group names are German keys; shown in the reader's language.
const groupNames: Record<string, string> = {
  Überfällig: "Overdue",
  Heute: "Today",
  "Nächste 7 Tage": "Next 7 days",
  Später: "Later",
  "Ohne Datum": "No date",
  Erledigt: "Completed",
};
export function groupTasks(tasks: Task[], today = localToday()) {
  const week = shift(today, 7);
  const groups: [string, Task[]][] = [
    ["Überfällig", []],
    ["Heute", []],
    ["Nächste 7 Tage", []],
    ["Später", []],
    ["Ohne Datum", []],
    ["Erledigt", []],
  ];
  const at = (name: string) => groups.find(([n]) => n === name)![1];
  for (const task of tasks) {
    if (task.checked) at("Erledigt").push(task);
    else if (!task.due) at("Ohne Datum").push(task);
    else if (task.due < today) at("Überfällig").push(task);
    else if (task.due === today) at("Heute").push(task);
    else if (task.due <= week) at("Nächste 7 Tage").push(task);
    else at("Später").push(task);
  }
  return groups.filter(([, list]) => list.length);
}

export function MyTasks({
  workspaceId,
  onOpen,
  onError,
  onChanged,
}: {
  workspaceId: string;
  onOpen: (pageId: string, rowId: string | null) => void;
  onError: (message: string) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [others, setOthers] = useState<Others>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<"tasks" | "records">("tasks");
  const load = useCallback(async () => {
    try {
      const result = await api<{ tasks: Task[]; others?: Others }>(
        `/api/tasks?workspace=${workspaceId}${done ? "&done=1" : ""}`,
      );
      setTasks(result.tasks);
      setOthers(result.others || []);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [workspaceId, done, onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (task: Task, patch: { checked?: boolean; due?: string | null }) => {
    const key = `${task.pageId}:${task.rowId}:${task.index}`;
    setBusy(key);
    // Show the change at once; the reload below brings the stored state.
    const same = (t: Task) =>
      t.pageId === task.pageId && t.rowId === task.rowId && t.index === task.index;
    setTasks((list) => list?.map((t) => (same(t) ? { ...t, ...patch } : t)) || null);
    setOthers((list) =>
      list.map((w) => ({ ...w, tasks: w.tasks.map((t) => (same(t) ? { ...t, ...patch } : t)) })),
    );
    try {
      await api("/api/command", {
        action: "task.update",
        pageId: task.pageId,
        rowId: task.rowId,
        index: task.index,
        text: task.text,
        ...patch,
      });
      await load();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
      await load();
    } finally {
      setBusy("");
    }
  };
  const item = (task: Task) => {
    const key = `${task.pageId}:${task.rowId}:${task.index}`;
    return (
      <li key={`${key}:${task.text}`} className={task.checked ? "checked" : ""}>
        <input
          type="checkbox"
          aria-label={`${task.text} erledigt`}
          checked={task.checked}
          disabled={busy === key}
          onChange={(e) => void change(task, { checked: e.target.checked })}
        />
        <span className="my-task-text">{task.text || t("Ohne Text", "No text")}</span>
        <button type="button" className="my-task-page" onClick={() => onOpen(task.pageId, task.rowId)}>
          <PageIcon name={task.icon} size={14} />
          {task.title || t("Ohne Titel", "Untitled")}
        </button>
        <label className={`task-due ${task.due ? `task-due-${dueState(task.due, task.checked)}` : "task-due-add"}`}>
          {task.due ? `📅 ${dueLabel(task.due)}` : "+ Datum"}
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
    <div className="utility-content my-tasks">
      <div className="utility-title">
        <CheckSquare size={30} />
        <h1>{t("Meine Aufgaben", "My tasks")}</h1>
        <p>
          {t("Aufgaben, die dir mit @Name gegeben wurden, deine eigenen mit Datum und alle Aufgaben aus deinen Journalen.", "Tasks given to you with @name, your own with a date and all tasks from your journals.")}
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
      <label className="my-tasks-done">
        <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
        {t("Erledigte zeigen", "Show completed")}
      </label>
      {!tasks ? (
        <p className="muted">{t("Aufgaben werden geladen …", "Loading tasks …")}</p>
      ) : !tasks.length ? (
        <div className="empty-state">
          <CheckSquare size={28} />
          <p>
            {t("Keine offenen Aufgaben in diesem Arbeitsbereich. Schreib in einem Dokument eine Aufgabe mit", "No open tasks in this workspace. Write a task in a document with")}{" "}<code>[]</code> {t("und erwähne jemanden mit", "and mention someone with")}{" "}
            <code>@</code>{t(", um sie zu vergeben; das Datum setzt du mit dem Kalender-Knopf in der Werkzeugleiste.", " to assign it; set the date with the calendar button in the toolbar.")}
          </p>
        </div>
      ) : (
        groupTasks(tasks).map(([name, list]) => (
          <section key={name} className={`my-tasks-group ${name === "Überfällig" ? "overdue" : ""}`}>
            <h2>
              {t(name, groupNames[name] || name)} <small>{list.length}</small>
            </h2>
            <ul>
              {list.map(item)}
            </ul>
          </section>
        ))
      )}
      {others.length > 0 && (
        <section className="my-tasks-others" aria-labelledby="my-tasks-others">
          <h2 id="my-tasks-others">{t("Aus anderen Arbeitsbereichen", "From other workspaces")}</h2>
          {others.map((w) => (
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
