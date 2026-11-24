import { z } from "zod";

// "Erledigte Aufgaben durchstreichen" (#458, Settings → Appearance &
// language → Editor): whether the text of a done task is struck through.
// On by default, as before #458. When off, a class on <html> takes the line
// away wherever the web app shows task lists – documents, journals,
// records' content, My tasks, the start page's task widget, a record's
// subtasks and sprint rows: a done task shows only its ticked box and the
// faded text colour. Cancelled tasks keep their line (it is what tells them
// from done ones). Display only: documents and exports are unchanged; pages
// the person shares or publishes show their visitors the same (#526,
// lib/public-appearance.ts). Stored per person on the server (users.strike_done_tasks:
// NULL = the default, 0 = off, 1 = on), delivered with the bootstrap.
export const DEFAULT_STRIKE_DONE_TASKS = true;
export const strikeDoneTasksSchema = z.boolean();
export const DONE_TASKS_PLAIN_CLASS = "done-tasks-plain";

// What a stored value means: only an explicit "off" takes the line away.
export function strikeDoneTasksOf(value: unknown): boolean {
  return !(value === false || value === 0 || value === "0");
}
