// Stored settings of a database (lib/database-settings-schema.ts).
import { z } from "zod";
import { one, run } from "./db";
import { HttpError } from "./auth";
import { settingsSchema, type DatabaseSettings } from "./database-settings-schema";
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
    if (a.trigger.type === "changed" || a.trigger.type === "overdue") check(a.trigger.field);
    for (const c of a.conditions) check(c.field);
    for (const action of a.actions)
      if (action.type === "set") {
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
export function storeSettings(pageId: string, settings: DatabaseSettings) {
  run("UPDATE databases SET settings=?,version=version+1 WHERE page_id=?", JSON.stringify(settings), pageId);
}
// What clients see: the Git secret only as a hint that one exists.
export function clientSettings(settings: DatabaseSettings) {
  const { git, ...rest } = settings;
  return git ? { ...rest, git: { token: git.token, secret: git.secret, createdAt: git.createdAt } } : rest;
}
