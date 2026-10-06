// Checks subtask properties when a database's schema or settings change and
// keeps progress properties in step with the database's done rule.
import { HttpError } from "./auth";
import { doneRule, type DatabaseSettings } from "./database-settings-schema";
import type { Field, Page } from "./types";

export function prepareSubtaskFields(page: Page, fields: Field[], settings: DatabaseSettings) {
  const parents = fields.filter((f) => f.type === "relation" && f.parent);
  if (parents.length > 1) throw new HttpError(400, "Eine Datenbank hat höchstens eine Eigenschaft für übergeordnete Einträge.");
  for (const p of parents) p.relationPage = page.id;
  const rule = doneRule(fields, settings);
  for (const f of fields) {
    if (f.type !== "progress") continue;
    if (!parents[0]) throw new HttpError(400, "Fortschritt braucht zuerst eine Eigenschaft „Übergeordneter Eintrag“.");
    f.parentField = parents[0].id;
    f.doneField = rule?.field.id;
    f.doneValues = rule?.field.type === "checkbox" ? ["true"] : rule?.values || [];
  }
  return fields;
}
