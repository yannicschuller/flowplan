"use client";
// "Meine Aufgaben": tasks from documents given to me (@me in the task) and
// my own dated to-dos, grouped by due date. Ticking one off changes the
// document it lives in.
import { useCallback, useEffect, useState } from "react";
import { CheckSquare, X } from "@phosphor-icons/react";
import { api, PageIcon } from "./ui";
import { dueLabel, dueState, localToday } from "@/lib/task-due-plugin";

type Task = {
  pageId: string;
  rowId: string | null;
  index: number;
  text: string;
  checked: boolean;
  due: string | null;
  assigned: boolean;
  title: string;
  icon: string;
};
const shift = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await api<{ tasks: Task[] }>(`/api/tasks?workspace=${workspaceId}${done ? "&done=1" : ""}`);
      setTasks(result.tasks);
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
    setTasks((list) =>
      list?.map((t) =>
        t.pageId === task.pageId && t.rowId === task.rowId && t.index === task.index
          ? { ...t, ...patch }
          : t,
      ) || null,
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
  return (
    <div className="utility-content my-tasks">
      <div className="utility-title">
        <CheckSquare size={30} />
        <h1>Meine Aufgaben</h1>
        <p>
          Aufgaben aus allen Seiten, die dir mit @Name gegeben wurden, und deine
          eigenen mit Datum.
        </p>
      </div>
      <label className="my-tasks-done">
        <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
        Erledigte zeigen
      </label>
      {!tasks ? (
        <p className="muted">Aufgaben werden geladen …</p>
      ) : !tasks.length ? (
        <div className="empty-state">
          <CheckSquare size={28} />
          <p>
            Keine offenen Aufgaben. Schreib in einem Dokument eine Aufgabe mit
            <code>[]</code> und erwähne jemanden mit <code>@</code>, um sie zu
            vergeben; das Datum setzt du am Ende der Zeile.
          </p>
        </div>
      ) : (
        groupTasks(tasks).map(([name, list]) => (
          <section key={name} className={`my-tasks-group ${name === "Überfällig" ? "overdue" : ""}`}>
            <h2>
              {name} <small>{list.length}</small>
            </h2>
            <ul>
              {list.map((task) => {
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
                    <span className="my-task-text">{task.text || "Ohne Text"}</span>
                    <button type="button" className="my-task-page" onClick={() => onOpen(task.pageId, task.rowId)}>
                      <PageIcon name={task.icon} size={14} />
                      {task.title || "Ohne Titel"}
                    </button>
                    <label className={`task-due ${task.due ? `task-due-${dueState(task.due, task.checked)}` : "task-due-add"}`}>
                      {task.due ? `📅 ${dueLabel(task.due)}` : "+ Datum"}
                      <input
                        type="date"
                        aria-label={`Fälligkeit von ${task.text}`}
                        value={task.due || ""}
                        disabled={busy === key}
                        onChange={(e) => void change(task, { due: e.target.value || null })}
                      />
                    </label>
                    {task.due && (
                      <button
                        type="button"
                        className="icon-button my-task-clear"
                        aria-label={`Fälligkeit von ${task.text} entfernen`}
                        title="Datum entfernen"
                        disabled={busy === key}
                        onClick={() => void change(task, { due: null })}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
