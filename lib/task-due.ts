// Due dates on tasks (lib/task-due-plugin.ts): the day, its label and its
// state, without the editor – for task lists, the start page and dashboards.
import { LOCALE_TAG, tr } from "./locale-tag";

const pad = (n: number) => String(n).padStart(2, "0");
export function localToday(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function dueLabel(due: string, today = localToday()) {
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
  const diff = Math.round((day(due) - day(today)) / 864e5);
  if (diff === 0) return tr("Heute", "Today");
  if (diff === 1) return tr("Morgen", "Tomorrow");
  if (diff === -1) return tr("Gestern", "Yesterday");
  const date = new Date(`${due}T00:00:00Z`);
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString(LOCALE_TAG, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
export function dueState(due: string, checked: boolean, today = localToday()) {
  if (checked) return "done";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "later";
}
