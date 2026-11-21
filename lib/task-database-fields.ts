// Which properties of a task database take a task's state, due date,
// person and parent – for "Aufgabe erstellen" (#380, lib/automation-task.ts)
// and "Aufgaben in Datenbank verschieben" (#420, components/tasks-to-
// database.tsx). The state is the database's done rule (lib/database-
// settings-schema.ts doneRule: the configured one, a status select with an
// option like "Erledigt", or a checkbox called "Erledigt"/"Done"); "open"
// is the first option that is not done, as My tasks sets when a record is
// unticked (lib/mobile-widget-actions.ts). Client-safe.
import { doneRule, dueField, type DatabaseSettings } from "./database-settings-schema";
import type { Field } from "./types";

export type TaskFields = {
  // A select or checkbox property; null when the database knows no "done".
  status: Field | null;
  doneValue: string;
  openValue: string;
  due: Field | null;
  person: Field | null;
  // The property for the parent record (subtasks), if the database has one.
  parent: Field | null;
};

// The first option of a select that does not mean done.
export const openOption = (field: Field, doneValues: string[]) => (field.options || []).find((o) => !doneValues.includes(o)) || "";

export function taskFields(fields: Field[], settings?: DatabaseSettings, pageId?: string): TaskFields {
  const rule = doneRule(fields, settings);
  const status = rule && (rule.field.type === "select" || rule.field.type === "checkbox") ? rule.field : null;
  return {
    status,
    doneValue: status?.type === "select" ? rule!.values[0] || "" : "",
    openValue: status?.type === "select" ? openOption(status, rule!.values) : "",
    due: dueField(fields, settings) || null,
    person: fields.find((f) => f.type === "person") || null,
    parent: fields.find((f) => f.type === "relation" && f.parent && (!pageId || f.relationPage === pageId)) || null,
  };
}
