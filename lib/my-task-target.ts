// Where "Aufgabe hinzufügen …" of My tasks writes (#457): the person's own
// page "Aufgaben" (lib/personal-tasks.ts, the default) or a task database
// they may add records to – per person and workspace (my_task_targets; no
// row: the page). The choice sits behind the field's chip in My tasks and
// is the command `task.target`; `task.add` follows it, so the apps' quick
// capture and widgets that add a task through it land in the same place.
//
// Only databases that count for My tasks are offered: a status or a done
// checkbox the person sees (doneRule, as crossRecords lists them), in a
// space the server can write (not end-to-end encrypted), and writable for
// the person (lib/capture.ts writable: editor, not locked, no journal PIN
// pending; the title not read-only for them). When the chosen database no
// longer qualifies – in the trash, read-only, no "done" any more – the task
// goes to the own page and the answer says why (`fallback`); the choice
// stays, so a database restored or unlocked is used again. A database
// purged from the trash takes the choice with it (ON DELETE CASCADE).
import { z } from "zod";
import { HttpError } from "./auth";
import { one, run } from "./db";
import { pageRole, requireMember } from "./permissions";
import { captureTargets, writable } from "./capture";
import { isEncryptedPage } from "./e2ee-server";
import { databaseSettings } from "./database-settings";
import { doneRule } from "./database-settings-schema";
import { hiddenFieldsFor, unwritableFieldIds } from "./field-access";
import { filterAsync } from "./each-async";
import type { Field, Identity, Page } from "./types";

// Why a chosen database is not used (the task goes to the own page).
export const TASK_TARGET_PROBLEMS = ["missing", "readonly", "untracked"] as const;
export type TaskTargetProblem = (typeof TASK_TARGET_PROBLEMS)[number];

export type TaskTarget =
  | { kind: "page" }
  | { kind: "database"; id: string; title: string; icon: string; problem: TaskTargetProblem | null };

export const taskTargetInput = z.object({
  workspaceId: z.uuid(),
  // null: the own page "Aufgaben".
  databaseId: z.uuid().nullable(),
});

async function fieldsOf(pageId: string) {
  const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  return raw ? (JSON.parse(raw.fields) as Field[]) : null;
}

// Whether the database can take this person's tasks: null when it can.
export async function taskTargetProblem(user: Identity, page: Page | undefined, workspaceId: string): Promise<TaskTargetProblem | null> {
  if (!page || page.deleted_at || page.kind !== "database" || page.workspace_id !== workspaceId) return "missing";
  const fields = await fieldsOf(page.id);
  if (!fields?.length) return "missing";
  if (!(await writable(user, page)) || (await isEncryptedPage(page))) return "readonly";
  if ((await unwritableFieldIds(user, page, fields)).has(fields[0].id)) return "readonly";
  const rule = doneRule(fields, await databaseSettings(page.id));
  if (!rule || (await hiddenFieldsFor(user, page, fields)).has(rule.field.id)) return "untracked";
  return null;
}

// The databases to choose from in My tasks.
export async function taskTargetDatabases(user: Identity, workspaceId: string) {
  const { databases } = await captureTargets(user, workspaceId);
  return await filterAsync(databases, async (d) => !(await taskTargetProblem(user, await one<Page>("SELECT * FROM pages WHERE id=?", d.id), workspaceId)));
}

// The stored choice with the database as it is now (its problem, if any).
export async function myTaskTarget(user: Identity, workspaceId: string): Promise<TaskTarget> {
  const row = await one<{ database_id: string }>("SELECT database_id FROM my_task_targets WHERE user_id=? AND workspace_id=?", user.id, workspaceId);
  if (!row) return { kind: "page" };
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", row.database_id);
  const problem = await taskTargetProblem(user, page, workspaceId);
  // A database the person cannot open (any more) shows no title or icon;
  // one in the trash keeps its name.
  const hidden = !page || page.workspace_id !== workspaceId || !(await canRead(user, page));
  return { kind: "database", id: row.database_id, title: hidden ? "" : page.title, icon: hidden ? "" : page.icon || "", problem };
}
const canRead = async (user: Identity, page: Page) => !!(await pageRole(user, page));

// The command `task.target`.
export async function setMyTaskTarget(user: Identity, raw: unknown): Promise<{ target: TaskTarget }> {
  const input = taskTargetInput.parse(raw);
  await requireMember(user, input.workspaceId, "editor");
  if (!input.databaseId) {
    await run("DELETE FROM my_task_targets WHERE user_id=? AND workspace_id=?", user.id, input.workspaceId);
    return { target: { kind: "page" } };
  }
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", input.databaseId);
  const problem = await taskTargetProblem(user, page, input.workspaceId);
  if (problem === "missing" || (problem && !(await canRead(user, page!)))) throw new HttpError(404, "Datenbank nicht gefunden.");
  if (problem === "readonly") throw new HttpError(403, "In dieser Datenbank darfst du keine Einträge anlegen.");
  if (problem === "untracked")
    throw new HttpError(400, "Diese Datenbank zählt nicht für Meine Aufgaben: Sie braucht einen Status oder ein Erledigt-Häkchen.");
  await run(
    `INSERT INTO my_task_targets(user_id,workspace_id,database_id,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,workspace_id) DO UPDATE SET database_id=excluded.database_id,updated_at=excluded.updated_at`,
    user.id,
    input.workspaceId,
    page!.id,
    Date.now(),
  );
  return { target: await myTaskTarget(user, input.workspaceId) };
}
