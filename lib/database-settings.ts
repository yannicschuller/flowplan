// Stored settings of a database (lib/database-settings-schema.ts).
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { settingsSchema, type Automation, type DatabaseSettings, type TaskAction } from "./database-settings-schema";
import { requirePage } from "./permissions";
import { validZone } from "./date-values";
import { validateCellPatch } from "./database-operations";
import type { Field, Identity, Page } from "./types";

const TOKENS = new Set(["@today", "@now", "@actor", "@creator", "@clear"]);

export async function databaseSettings(pageId: string): Promise<DatabaseSettings> {
  const raw = await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", pageId);
  try {
    return settingsSchema.parse(JSON.parse(raw?.settings || "{}"));
  } catch {
    return {};
  }
}

// Changes some settings; the rest stays. `null` removes a setting.
export async function updateDatabaseSettings(user: Identity, page: Page, fields: Field[], input: unknown) {
  const pageId = page.id;
  const patch = z.record(z.string(), z.unknown()).parse(input);
  const current = (await databaseSettings(pageId)) as Record<string, unknown>;
  const previous = new Map(((await databaseSettings(pageId)).automations || []).map((a) => [a.id, a]));
  for (const [key, value] of Object.entries(patch)) {
    // The card mapping has its own action (study.settings, lib/study.ts).
    if (!(key in settingsSchema.shape) || key === "git" || key === "study") throw new HttpError(400, "Unbekannte Einstellung.");
    if (value === null) delete current[key];
    else current[key] = value;
  }
  const next = settingsSchema.parse(current);
  const known = new Set(fields.map((f) => f.id));
  const check = (id: string | undefined) => {
    if (id && !known.has(id)) throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
  };
  check(next.done?.field);
  // The due date (#248): a date property of this database.
  const dueId = next.due && "field" in next.due ? next.due.field : undefined;
  if (dueId && fields.find((f) => f.id === dueId)?.type !== "date")
    throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
  check(next.workflow?.field);
  check(next.pointsField);
  // Rules replaced by a workflow stay as they were (only removing them is
  // possible); nobody marks a rule as replaced but the server.
  next.automations = next.automations?.map((a) => {
    const before = previous.get(a.id);
    if (before?.workflow) return before;
    const { workflow: _ignored, ...rest } = a;
    return rest;
  });
  for (const a of next.automations || []) {
    if (a.workflow) continue;
    stampAutomation(user, a, previous.get(a.id));
    if (a.trigger.type === "changed" || a.trigger.type === "overdue") check(a.trigger.field);
    for (const c of a.conditions) check(c.field);
    const scheduled = a.trigger.type === "schedule";
    if (a.trigger.type === "schedule") {
      if (!validZone(a.trigger.timeZone)) throw new HttpError(400, "Ungültige Zeitzone.");
      if (a.conditions.length) throw new HttpError(400, "Geplante Regeln haben keine Bedingungen.");
    }
    for (const action of a.actions)
      if (action.type === "task") await checkTaskAction(user, page, fields, action, scheduled);
      else if ((action.type === "create") !== scheduled)
        throw new HttpError(400, "Geplante Regeln legen nur Datensätze oder Aufgaben an; Datensätze anlegen nur geplante Regeln.");
      else if (action.type === "template") {
        if (!(await one("SELECT 1 FROM row_templates WHERE id=? AND page_id=?", action.template, pageId)))
          throw new HttpError(400, "Datensatzvorlage nicht gefunden.");
      } else if (action.type === "create") {
        if (action.template && !(await one("SELECT 1 FROM row_templates WHERE id=? AND page_id=?", action.template, pageId)))
          throw new HttpError(400, "Datensatzvorlage nicht gefunden.");
        for (const fieldId of Object.keys(action.dates))
          if (fields.find((f) => f.id === fieldId)?.type !== "date")
            throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
        Object.keys(action.cells).forEach(check);
        try {
          await validateCellPatch(user, page, fields, action.cells);
        } catch {
          throw new HttpError(400, "Eine Regel setzt einen Wert, der nicht zur Eigenschaft passt.");
        }
      } else if (action.type === "set") {
        check(action.field);
        // A fixed value must be one the property accepts.
        if (!(typeof action.value === "string" && TOKENS.has(action.value)) && action.value !== "" && action.value !== null)
          try {
            await validateCellPatch(user, page, fields, { [action.field]: action.value });
          } catch {
            throw new HttpError(400, "Eine Regel setzt einen Wert, der nicht zur Eigenschaft passt.");
          }
      }
  }
  for (const [status, ids] of Object.entries(next.workflow?.required || {})) {
    void status;
    ids.forEach(check);
  }
  await storeSettings(pageId, next);
  return next;
}
// "Aufgabe erstellen" (#380, lib/automation-task.ts): what the rule names
// exists and fits, and the person saving it – the one it will act for –
// may create records in the task database.
async function checkTaskAction(user: Identity, page: Page, fields: Field[], action: TaskAction, scheduled: boolean) {
  if (!action.text) throw new HttpError(400, "Die Aufgabe braucht einen Text.");
  const unknown = () => new HttpError(400, "Die Aufgabe verweist auf eine unbekannte Eigenschaft.");
  const who = action.assignee;
  if (scheduled && (action.target === "document" || who === "@creator" || who.startsWith("field:") || action.relation))
    throw new HttpError(400, "Geplante Regeln haben keinen auslösenden Eintrag: Ihre Aufgaben kommen in eine Datenbank, ohne Personen oder Verknüpfung des Eintrags.");
  if (who.startsWith("field:")) {
    if (fields.find((f) => f.id === who.slice(6))?.type !== "person") throw unknown();
  } else if (who && !who.startsWith("@")) {
    if (!(await one("SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND COALESCE(u.disabled,0)=0", page.workspace_id, who)))
      throw new HttpError(400, "Die Person der Aufgabe ist kein Mitglied des Arbeitsbereichs.");
  } else if (who && who !== "@actor" && who !== "@creator") throw unknown();
  if (action.target === "document") return;
  if (!action.database) throw new HttpError(400, "Wähle eine Datenbank für die Aufgabe.");
  const target = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", action.database);
  if (!target || target.kind !== "database" || target.workspace_id !== page.workspace_id) throw new HttpError(400, "Die Datenbank für die Aufgabe gibt es nicht (mehr).");
  try {
    await requirePage(user, target.id, true);
  } catch {
    throw new HttpError(403, "In der Datenbank für die Aufgabe darfst du keine Einträge anlegen.");
  }
  const taskFields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", target.id))?.fields || "[]") as Field[];
  const typed = (fieldId: string, types: string[]) => !fieldId || types.includes(taskFields.find((f) => f.id === fieldId)?.type || "");
  if (!typed(action.personField, ["person"]) || !typed(action.dueField, ["date"])) throw unknown();
  if (action.relation && !taskFields.some((f) => f.id === action.relation && f.type === "relation" && f.relationPage === page.id)) throw unknown();
  for (const [fieldId, value] of Object.entries(action.values)) {
    const field = taskFields.find((f) => f.id === fieldId);
    if (!field || !["select", "multiselect"].includes(field.type)) throw unknown();
    if (value && !(field.options || []).includes(value)) throw new HttpError(400, "Eine Regel setzt einen Wert, der nicht zur Eigenschaft passt.");
  }
}
// Who a rule acts for and since when: kept while the rule stays the same
// (switching it on or off included), otherwise the person saving it takes
// it over, so nobody can make a rule act with someone else's rights.
export function stampAutomation(user: Identity, a: Automation, before: Automation | undefined) {
  const essence = (x: Automation) => JSON.stringify({ ...x, enabled: undefined, createdBy: undefined, since: undefined });
  if (before?.createdBy && before.since && essence(before) === essence(a)) {
    a.createdBy = before.createdBy;
    a.since = before.since;
  } else {
    a.createdBy = user.id;
    a.since = new Date().toISOString();
  }
}
export async function storeSettings(pageId: string, settings: DatabaseSettings) {
  await run("UPDATE databases SET settings=?,version=version+1 WHERE page_id=?", JSON.stringify(settings), pageId);
}
// What clients see: whether Git is connected, never the token or secret
// (those come from /api/git-config for people who may edit).
export function clientSettings(settings: DatabaseSettings) {
  const { git, ...rest } = settings;
  return git ? { ...rest, git: { token: "", secret: "", createdAt: git.createdAt } } : rest;
}
