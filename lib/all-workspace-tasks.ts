// My tasks → "Alle Arbeitsbereiche" (#564): the person's tasks and task
// records of all their workspaces in one answer (GET /api/tasks/all).
//
// Nothing new is visible here: the tasks come from the same query as
// "Meine Aufgaben" of one workspace (lib/doc-tasks.ts, its page and record
// checks), restricted to the workspaces the person is a member of now, in
// ONE query for all of them; the records from crossRecords() per workspace
// (lib/cross-records.ts, which checks membership, page rights, private
// records and hidden properties itself). A workspace the person left, or a
// page they cannot read, never appears.
//
// Caps, so 30 or 50 workspaces stay one quick request: at most
// ALL_WORKSPACES_MAX workspaces (by name), ALL_TASKS_MAX tasks and
// ALL_RECORDS_MAX records in total – the records of the later workspaces
// are not collected once the cap is reached (`limited`).
import { z } from "zod";
import { all } from "./db";
import { tasksInWorkspaces } from "./doc-tasks";
import { crossRecords } from "./cross-records";
import type { Identity } from "./types";

export const ALL_WORKSPACES_MAX = 50;
export const ALL_TASKS_MAX = 1000;
export const ALL_RECORDS_MAX = 500;

export const allTasksSchema = z.object({
  done: z.boolean().default(false),
  // Only these workspaces (the filter of the view); empty: all of them.
  workspaces: z.array(z.uuid()).max(500).default([]),
  // Records from databases too (Quelle "Alle" or "Datenbanken").
  records: z.boolean().default(true),
  // The records' filter as for /api/records (mine, open, due, today …).
  filter: z.record(z.string(), z.unknown()).default({}),
});

export type WorkspaceRef = { id: string; name: string };

export async function allWorkspaceTasks(user: Identity, input: unknown) {
  const options = allTasksSchema.parse(input ?? {});
  const mine = await all<WorkspaceRef>(
    "SELECT w.id,w.name FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY lower(w.name),w.id",
    user.id,
  );
  const wanted = options.workspaces.length ? mine.filter((w) => options.workspaces.includes(w.id)) : mine;
  const chosen = wanted.slice(0, ALL_WORKSPACES_MAX);
  const ids = chosen.map((w) => w.id);
  const tasks = (await tasksInWorkspaces(user, ids, options.done)).slice(0, ALL_TASKS_MAX);
  type Found = Awaited<ReturnType<typeof crossRecords>>["records"][number] & { workspaceId: string };
  const records: Found[] = [];
  let limited = false;
  if (options.records)
    for (const w of chosen) {
      const left = ALL_RECORDS_MAX - records.length;
      if (left <= 0) {
        limited = true;
        break;
      }
      try {
        const found = await crossRecords(user, w.id, { ...options.filter, open: options.filter.open ?? !options.done, tasks: true }, left);
        records.push(...found.records.map((r) => ({ ...r, workspaceId: w.id })));
        if (found.limited) limited = true;
      } catch {
        // A workspace left in the meantime: its records stay out.
      }
    }
  // Dated first (soonest), as in one workspace.
  records.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0));
  return {
    // Every workspace of the person (for the filter), and which were collected.
    workspaces: mine,
    shown: ids,
    tasks,
    records,
    limited,
    tasksLimited: tasks.length >= ALL_TASKS_MAX,
    workspacesLimited: wanted.length > chosen.length,
  };
}
