// Formatted text properties (#126) on the server: the one-time migration
// that keeps every existing value showing as before (schema 90) and the
// conversion when a property becomes or stops being formatted text (a type
// change, a different title). Values themselves: lib/inline-markdown.ts.
import { escapeInline, isFormattedText, toPlain } from "./inline-markdown";
import type { Field } from "./types";
import { all, run } from "./db";

type Cells = Record<string, unknown>;
const SPECIAL = /[\\*_~`[\]]/;

// Plain strings → inline Markdown in the formatted text properties of
// `fields`. Values without * _ ~ ` [ ] \ stay the same string.
export function escapeFormattedCells(cells: Cells, fields: Field[]): { cells: Cells; changed: boolean } {
  let changed = false;
  const out = { ...cells };
  for (const f of fields) {
    const value = out[f.id];
    if (!isFormattedText(f, fields) || typeof value !== "string" || !SPECIAL.test(value)) continue;
    out[f.id] = escapeInline(value);
    changed = true;
  }
  return { cells: out, changed };
}

// How the values of a database change when its properties do: a property
// that becomes formatted text has its strings escaped, one that stops being
// formatted text (another type, or now the title) keeps their plain text.
export function formattedChanges(before: Field[], after: Field[]) {
  const was = new Set(before.filter((f) => isFormattedText(f, before)).map((f) => f.id));
  const now = new Set(after.filter((f) => isFormattedText(f, after)).map((f) => f.id));
  const kept = new Set(before.map((f) => f.id));
  return {
    // New properties start empty: nothing to escape.
    escape: [...now].filter((id) => !was.has(id) && kept.has(id)),
    plain: [...was].filter((id) => !now.has(id) && after.some((f) => f.id === id)),
  };
}

export function convertCells(cells: Cells, change: { escape: string[]; plain: string[] }): { cells: Cells; changed: boolean } {
  let changed = false;
  const out = { ...cells };
  for (const id of change.escape) {
    const value = out[id];
    if (typeof value === "string" && SPECIAL.test(value)) {
      out[id] = escapeInline(value);
      changed = true;
    }
  }
  for (const id of change.plain) {
    const value = out[id];
    if (typeof value === "string" && SPECIAL.test(value)) {
      out[id] = toPlain(value);
      changed = true;
    }
  }
  return { cells: out, changed };
}

// database.update: the records and record templates of the database follow
// a change of their properties (inside the caller's transaction).
export async function convertFormattedValues(pageId: string, before: Field[], after: Field[]) {
  const change = formattedChanges(before, after);
  if (!change.escape.length && !change.plain.length) return;
  for (const table of ["rows", "row_templates"] as const)
    for (const row of await all<{ id: string; cells: string }>(`SELECT id,cells FROM ${table} WHERE page_id=?`, pageId)) {
      const next = convertCells(JSON.parse(row.cells), change);
      if (next.changed) await run(`UPDATE ${table} SET cells=? WHERE id=?`, JSON.stringify(next.cells), row.id);
    }
}

// Schema 90 – formatted text properties (#126): every text property but
// the title holds inline Markdown from now on. Once, the existing values
// are escaped so they show exactly as before ("*stars*" stays with its
// stars): records, record templates, records in the trash, database
// versions and saved database templates. Titles stay as they are. The
// step itself: lib/data-steps.ts.
export const FORMATTED_TEXT_MIGRATION = "formatted-text-126";
