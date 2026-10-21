// Repeating records ("wiederkehrende Aufgabe"): a record with a repeat rule
// (lib/recurrence.ts) gets a successor once it is done – a copy that is
// open again, with the rule's date property moved to the next occurrence
// and the other dates moved by as many days. The rule moves on to the
// successor, so marking the old record done again creates nothing.
import { z } from "zod";
import { id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireRow, replaceRowDocument } from "./row-documents";
import { nextOccurrence, parseRepeat, repeatSchema, shiftDateValue } from "./recurrence";
import { Temporal, validDateValue } from "./date-values";
import { doneRule, isDone, type DatabaseSettings } from "./database-settings-schema";
import type { Field, Identity } from "./types";

type Cells = Record<string, unknown>;
// Values the server computes; a successor gets its own.
const COMPUTED = new Set(["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "time"]);

const repeatInput = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  version: z.number().int().positive(),
  repeat: repeatSchema.nullable(),
});
// Command "row.repeat": sets or removes the rule of a record.
export function setRowRepeat(user: Identity, input: unknown) {
  const b = repeatInput.parse(input);
  const { row } = requireRow(user, b.pageId, b.rowId, true);
  if (row.version !== b.version) throw new HttpError(409, "Der Eintrag wurde inzwischen geändert. Bitte erneut versuchen.");
  let stored = "";
  if (b.repeat) {
    const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", b.pageId)!.fields) as Field[];
    if (fields.find((f) => f.id === b.repeat!.field)?.type !== "date")
      throw new HttpError(400, "Die Wiederholung braucht eine Datumseigenschaft.");
    const rule = { ...b.repeat };
    // Monthly and yearly rules keep the day of the month they start on.
    const raw = row.cells as unknown;
    const value = ((typeof raw === "string" ? JSON.parse(raw) : raw) as Cells)[rule.field];
    if (rule.freq !== "daily" && rule.freq !== "weekly" && !rule.day && validDateValue(value))
      rule.day = Temporal.PlainDate.from(value.slice(0, 10)).day;
    if (rule.freq !== "weekly") delete rule.weekdays;
    stored = JSON.stringify(rule);
  }
  run(
    "UPDATE rows SET repeat=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    stored,
    user.id,
    row.id,
  );
  return { ok: true };
}

// After a change: when a repeating record became done, creates its successor
// and returns its id (the caller runs the "created" automations).
export function spawnNextRecord(
  actor: Identity | null,
  pageId: string,
  rowId: string,
  fields: Field[],
  settings: DatabaseSettings,
  before: Cells,
  after: Cells,
): string | null {
  const done = doneRule(fields, settings);
  if (!done || isDone(done, before) || !isDone(done, after)) return null;
  const row = one<{ repeat: string; created_by: string; icon: string; cover: string; access: string }>(
    "SELECT repeat,created_by,icon,cover,access FROM rows WHERE id=? AND page_id=?",
    rowId,
    pageId,
  );
  const rule = parseRepeat(row?.repeat);
  if (!row || !rule) return null;
  const today = new Date().toISOString().slice(0, 10);
  const current = after[rule.field];
  const base = validDateValue(current) ? current : today;
  const next = nextOccurrence(base, rule);
  const days = Temporal.PlainDate.from(base.slice(0, 10)).until(Temporal.PlainDate.from(next), { largestUnit: "days" }).days;
  const cells: Cells = {};
  for (const [key, value] of Object.entries(after)) {
    const field = fields.find((f) => f.id === key);
    if (field && COMPUTED.has(field.type)) continue;
    cells[key] = field?.type === "date" && validDateValue(value) ? shiftDateValue(value, days) : value;
  }
  cells[rule.field] = validDateValue(current) ? shiftDateValue(current, days) : next;
  // Open again: the status it had before, or an unticked box.
  cells[done.field.id] = done.field.type === "checkbox" ? false : before[done.field.id] ?? "";
  const rid = id(),
    author = actor?.id || row.created_by;
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,icon,cover,access,repeat) VALUES(?,?,?,?,?,?,?,?,?,?)",
    rid,
    pageId,
    JSON.stringify(cells),
    Date.now(),
    author,
    author,
    row.icon,
    row.cover,
    row.access,
    row.repeat,
  );
  run("UPDATE rows SET repeat='' WHERE id=?", rowId);
  const html = one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId)?.html;
  if (html) replaceRowDocument(rid, html, author);
  return rid;
}
