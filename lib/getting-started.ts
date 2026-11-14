// The checklist "Erste Schritte" (components/getting-started.tsx): starts
// when a person finishes or skips the introduction, per person and
// workspace (table getting_started). Items tick from what the server sees
// happen (gettingStartedAfterCommand, noteGettingStarted after an import)
// or from the browser (the app, the search), and by hand. The list a person
// sees: lib/getting-started-items.ts.
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, memberRole, requireMember } from "./permissions";
import {
  CHECKLIST_ITEMS,
  ONBOARDING_GOALS,
  ONBOARDING_SOURCES,
  checklistView,
  type ChecklistItem,
  type ChecklistState,
  type OnboardingGoal,
  type OnboardingSource,
} from "./getting-started-items";
import type { Field, Identity } from "./types";

type Row = { started_at: number; hidden_at: number | null; goal: string | null; source: string | null; done: string };

function parseDone(text: string): ChecklistState["done"] {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter(([k, v]) => (CHECKLIST_ITEMS as readonly string[]).includes(k) && typeof v === "number"),
    ) as ChecklistState["done"];
  } catch {
    return {};
  }
}
function stateOf(row: Row): ChecklistState {
  return {
    startedAt: row.started_at,
    hiddenAt: row.hidden_at,
    goal: (ONBOARDING_GOALS as readonly string[]).includes(row.goal || "") ? (row.goal as OnboardingGoal) : null,
    source: (ONBOARDING_SOURCES as readonly string[]).includes(row.source || "") ? (row.source as OnboardingSource) : null,
    done: parseDone(row.done),
  };
}
const rowOf = async (userId: string, workspaceId: string) =>
  await one<Row>("SELECT started_at,hidden_at,goal,source,done FROM getting_started WHERE user_id=? AND workspace_id=?", userId, workspaceId);

// For the bootstrap: null until the introduction ended once.
export async function gettingStarted(user: Identity, workspaceId: string) {
  if (user.demo) return null;
  const row = await rowOf(user.id, workspaceId);
  if (!row) return null;
  const role = await memberRole(user, workspaceId);
  if (!role) return null;
  return checklistView(stateOf(row), { owner: role === "owner", guest: await isGuest(user, workspaceId), canWrite: role !== "viewer" });
}

// Ticks an item, once (the first time counts). Without a checklist nothing
// happens: people who never saw the introduction get no list.
export async function noteGettingStarted(userId: string, workspaceId: string, item: ChecklistItem, at = Date.now()) {
  const row = await rowOf(userId, workspaceId);
  if (!row) return false;
  const done = parseDone(row.done);
  if (done[item] !== undefined) return false;
  done[item] = at;
  await run("UPDATE getting_started SET done=? WHERE user_id=? AND workspace_id=?", JSON.stringify(done), userId, workspaceId);
  return true;
}

const startSchema = z.object({
  workspaceId: z.uuid(),
  goal: z.enum(ONBOARDING_GOALS).nullish(),
  source: z.enum(ONBOARDING_SOURCES).nullish(),
  // Imported in the introduction: the item is not shown.
  imported: z.boolean().optional(),
});
const markSchema = z.object({ workspaceId: z.uuid(), item: z.enum(CHECKLIST_ITEMS), done: z.boolean() });
const hideSchema = z.object({ workspaceId: z.uuid(), hidden: z.boolean() });

export async function gettingStartedCommand(user: Identity, action: string, input: Record<string, unknown>, now = Date.now()) {
  if (action === "gettingStarted.start") {
    const b = startSchema.parse(input);
    await requireMember(user, b.workspaceId);
    const row = await rowOf(user.id, b.workspaceId);
    if (!row) {
      await run(
        "INSERT INTO getting_started(user_id,workspace_id,started_at,goal,source,done) VALUES(?,?,?,?,?,?)",
        user.id,
        b.workspaceId,
        now,
        b.goal ?? null,
        b.source ?? null,
        JSON.stringify(b.imported ? { import: now } : {}),
      );
    } else {
      // The introduction again (Settings, command palette): the list shows
      // again, with what was done; new answers replace the old ones.
      const done = parseDone(row.done);
      if (b.imported && done.import === undefined) done.import = now;
      await run(
        "UPDATE getting_started SET hidden_at=NULL,goal=COALESCE(?,goal),source=COALESCE(?,source),done=? WHERE user_id=? AND workspace_id=?",
        b.goal ?? null,
        b.source ?? null,
        JSON.stringify(done),
        user.id,
        b.workspaceId,
      );
    }
    return await gettingStarted(user, b.workspaceId);
  }
  if (action === "gettingStarted.mark") {
    const b = markSchema.parse(input);
    await requireMember(user, b.workspaceId);
    const row = await rowOf(user.id, b.workspaceId);
    if (!row) throw new HttpError(404, "Keine Checkliste „Erste Schritte“ in diesem Arbeitsbereich.");
    const done = parseDone(row.done);
    if (b.done) done[b.item] ??= now;
    else delete done[b.item];
    await run("UPDATE getting_started SET done=? WHERE user_id=? AND workspace_id=?", JSON.stringify(done), user.id, b.workspaceId);
    return await gettingStarted(user, b.workspaceId);
  }
  if (action === "gettingStarted.hide") {
    const b = hideSchema.parse(input);
    await requireMember(user, b.workspaceId);
    if (!(await rowOf(user.id, b.workspaceId))) throw new HttpError(404, "Keine Checkliste „Erste Schritte“ in diesem Arbeitsbereich.");
    await run("UPDATE getting_started SET hidden_at=? WHERE user_id=? AND workspace_id=?", b.hidden ? now : null, user.id, b.workspaceId);
    return await gettingStarted(user, b.workspaceId);
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// A database counts as a task list when its records can be done: a
// checkbox, or a choice named like a status.
const taskLike = (fields: Field[]) =>
  fields.some((f) => f.type === "checkbox" || (f.type === "select" && /status|zustand|state/i.test(f.name)));

// After a command (lib/api.ts): what it means for the checklist. Cheap:
// only for the few actions below, one lookup each.
export async function gettingStartedAfterCommand(user: Identity, action: string, b: Record<string, unknown>, result: unknown) {
  if (user.demo || user.apiScope) return;
  const created = (result as { id?: unknown; rowId?: unknown } | null) ?? {};
  switch (action) {
    case "page.create": {
      if (typeof created.id !== "string") return;
      const page = await one<{ workspace_id: string; kind: string }>("SELECT workspace_id,kind FROM pages WHERE id=?", created.id);
      if (page?.kind === "document") await noteGettingStarted(user.id, page.workspace_id, "page");
      return;
    }
    case "row.create":
    case "capture.record": {
      const rowId = action === "row.create" ? created.id : created.rowId;
      if (typeof rowId !== "string") return;
      const db = await one<{ workspace_id: string; fields: string }>(
        "SELECT p.workspace_id,d.fields FROM rows r JOIN pages p ON p.id=r.page_id JOIN databases d ON d.page_id=r.page_id WHERE r.id=?",
        rowId,
      );
      if (db && taskLike(JSON.parse(db.fields) as Field[])) await noteGettingStarted(user.id, db.workspace_id, "task");
      return;
    }
    case "task.add":
      if (typeof b.workspaceId === "string") await noteGettingStarted(user.id, b.workspaceId, "task");
      return;
    case "member.invite":
      if (typeof b.workspaceId === "string") await noteGettingStarted(user.id, b.workspaceId, "invite");
      return;
    case "page.import":
      if (typeof b.workspaceId === "string") await noteGettingStarted(user.id, b.workspaceId, "import");
      return;
  }
}
