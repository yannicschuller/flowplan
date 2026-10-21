// Stored settings of a database (lib/database-settings-schema.ts).
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { settingsSchema, type Automation, type DatabaseSettings } from "./database-settings-schema";
import { validZone } from "./date-values";
import { validateCellPatch } from "./database-operations";
import type { Field, Identity, Page } from "./types";

const TOKENS = new Set(["@today", "@now", "@actor", "@creator", "@clear"]);

export function databaseSettings(pageId: string): DatabaseSettings {
  const raw = one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", pageId);
  try {
    return settingsSchema.parse(JSON.parse(raw?.settings || "{}"));
  } catch {
    return {};
  }
}

// Changes some settings; the rest stays. `null` removes a setting.
export function updateDatabaseSettings(user: Identity, page: Page, fields: Field[], input: unknown) {
  const pageId = page.id;
  const patch = z.record(z.string(), z.unknown()).parse(input);
  const current = databaseSettings(pageId) as Record<string, unknown>;
  const previous = new Map((databaseSettings(pageId).automations || []).map((a) => [a.id, a]));
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in settingsSchema.shape) || key === "git") throw new HttpError(400, "Unbekannte Einstellung.");
    if (value === null) delete current[key];
    else current[key] = value;
  }
  const next = settingsSchema.parse(current);
  const known = new Set(fields.map((f) => f.id));
  const check = (id: string | undefined) => {
    if (id && !known.has(id)) throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
  };
  check(next.done?.field);
  check(next.workflow?.field);
  check(next.pointsField);
  for (const a of next.automations || []) {
    stampAutomation(user, a, previous.get(a.id));
    if (a.trigger.type === "changed" || a.trigger.type === "overdue") check(a.trigger.field);
    for (const c of a.conditions) check(c.field);
    const scheduled = a.trigger.type === "schedule";
    if (a.trigger.type === "schedule") {
      if (!validZone(a.trigger.timeZone)) throw new HttpError(400, "Ungültige Zeitzone.");
      if (a.conditions.length) throw new HttpError(400, "Geplante Regeln haben keine Bedingungen.");
    }
    for (const action of a.actions)
      if ((action.type === "create") !== scheduled)
        throw new HttpError(400, "Geplante Regeln legen nur Datensätze an; Datensätze anlegen nur geplante Regeln.");
      else if (action.type === "create") {
        if (action.template && !one("SELECT 1 FROM row_templates WHERE id=? AND page_id=?", action.template, pageId))
          throw new HttpError(400, "Datensatzvorlage nicht gefunden.");
        for (const fieldId of Object.keys(action.dates))
          if (fields.find((f) => f.id === fieldId)?.type !== "date")
            throw new HttpError(400, "Einstellung verweist auf eine unbekannte Eigenschaft.");
        Object.keys(action.cells).forEach(check);
        try {
          validateCellPatch(user, page, fields, action.cells);
        } catch {
          throw new HttpError(400, "Eine Regel setzt einen Wert, der nicht zur Eigenschaft passt.");
        }
      } else if (action.type === "set") {
        check(action.field);
        // A fixed value must be one the property accepts.
        if (!(typeof action.value === "string" && TOKENS.has(action.value)) && action.value !== "" && action.value !== null)
          try {
            validateCellPatch(user, page, fields, { [action.field]: action.value });
          } catch {
            throw new HttpError(400, "Eine Regel setzt einen Wert, der nicht zur Eigenschaft passt.");
          }
      }
  }
  for (const [status, ids] of Object.entries(next.workflow?.required || {})) {
    void status;
    ids.forEach(check);
  }
  storeSettings(pageId, next);
  return next;
}
// Who a rule acts for and since when: kept while the rule stays the same
// (switching it on or off included), otherwise the person saving it takes
// it over, so nobody can make a rule act with someone else's rights.
function stampAutomation(user: Identity, a: Automation, before: Automation | undefined) {
  const essence = (x: Automation) => JSON.stringify({ ...x, enabled: undefined, createdBy: undefined, since: undefined });
  if (before?.createdBy && before.since && essence(before) === essence(a)) {
    a.createdBy = before.createdBy;
    a.since = before.since;
  } else {
    a.createdBy = user.id;
    a.since = new Date().toISOString();
  }
}
export function storeSettings(pageId: string, settings: DatabaseSettings) {
  run("UPDATE databases SET settings=?,version=version+1 WHERE page_id=?", JSON.stringify(settings), pageId);
}
// What clients see: whether Git is connected, never the token or secret
// (those come from /api/git-config for people who may edit).
export function clientSettings(settings: DatabaseSettings) {
  const { git, ...rest } = settings;
  return git ? { ...rest, git: { token: "", secret: "", createdAt: git.createdAt } } : rest;
}
