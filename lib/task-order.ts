// The order of open tasks in the widgets of the mobile apps (the overview's
// summary, lib/mobile-devices.ts, and the interactive "Tasks" widget,
// lib/mobile-widgets.ts): overdue first – the oldest first –, then due
// today, then upcoming by date, then those without a date. Equal dates go
// by priority (high first, where tasks have one), then by their place: the
// page (by title), the record and the position in the document, or the
// position in the database view.
import type { Field } from "./types";

export type OrderedTask = {
  due: string | null;
  // 0 is the most urgent; null: no priority.
  priority?: number | null;
  // Where the task stands: page title, page, record, position.
  page?: string;
  pageId?: string;
  rowId?: string | null;
  index?: number;
};

// 0 overdue, 1 today, 2 upcoming, 3 without a date.
export function dueGroup(due: string | null, today: string) {
  if (!due) return 3;
  return due < today ? 0 : due === today ? 1 : 2;
}

const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

export function compareTasks(today: string) {
  return (a: OrderedTask, b: OrderedTask) => {
    const group = dueGroup(a.due, today) - dueGroup(b.due, today);
    if (group) return group;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    const pa = a.priority ?? Number.POSITIVE_INFINITY,
      pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (
      collator.compare(a.page ?? "", b.page ?? "") ||
      (a.pageId ?? "").localeCompare(b.pageId ?? "") ||
      (a.rowId ?? "").localeCompare(b.rowId ?? "") ||
      (a.index ?? 0) - (b.index ?? 0)
    );
  };
}

// Sorted copy; tasks equal in every respect keep their order (stable sort).
export function sortTasks<T extends OrderedTask>(tasks: readonly T[], today: string): T[] {
  return [...tasks].sort(compareTasks(today));
}

// A database's priority: a select property called "Priority" (German
// "Priorität", French "Priorité", or "Prio"). Its options rank by their
// words where they say it (urgent, high, medium, low), otherwise by their
// order – the first option the most urgent, as the templates list them.
const PRIORITY_NAME = /^(priorit(y|ät|é|e|aet)|prio)$/i;
const LEVELS: [RegExp, number][] = [
  [/^(urgent|dringend|critical|kritisch|critique|sofort|asap|p0)(?![\p{L}\p{N}])/iu, 0],
  [/^(high|hoch|haute|élevée|elevee|wichtig|p1)(?![\p{L}\p{N}])/iu, 1],
  [/^(medium|mittel|moyenne|normal|normale|p2)(?![\p{L}\p{N}])/iu, 2],
  [/^(low|niedrig|basse|faible|gering|p3)(?![\p{L}\p{N}])/iu, 3],
];
const level = (option: string) => {
  const word = option.trim().replace(/^[^\p{L}\p{N}]+/u, "");
  for (const [pattern, rank] of LEVELS) if (pattern.test(word)) return rank;
  return null;
};

export function priorityField(fields: readonly Field[]) {
  return fields.find((field) => field.type === "select" && PRIORITY_NAME.test(field.name.trim()));
}

export function priorityRank(field: Field | undefined, value: unknown): number | null {
  if (!field) return null;
  const chosen = Array.isArray(value) ? value[0] : value;
  if (typeof chosen !== "string" || !chosen) return null;
  const options = field.options ?? [];
  if (options.some((option) => level(option) !== null)) return level(chosen);
  const index = options.indexOf(chosen);
  return index >= 0 ? index : null;
}
