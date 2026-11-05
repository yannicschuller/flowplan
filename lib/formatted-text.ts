// Formatted text properties (#126) on the server: the one-time migration
// that keeps every existing value showing as before (schema 90) and the
// conversion when a property becomes or stops being formatted text (a type
// change, a different title). Values themselves: lib/inline-markdown.ts.
import type { DatabaseSync } from "node:sqlite";
import { escapeInline, isFormattedText, toPlain } from "./inline-markdown";
import type { Field } from "./types";

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
export function convertFormattedValues(d: DatabaseSync, pageId: string, before: Field[], after: Field[]) {
  const change = formattedChanges(before, after);
  if (!change.escape.length && !change.plain.length) return;
  for (const table of ["rows", "row_templates"] as const)
    for (const row of d.prepare(`SELECT id,cells FROM ${table} WHERE page_id=?`).all(pageId) as { id: string; cells: string }[]) {
      const next = convertCells(JSON.parse(row.cells), change);
      if (next.changed) d.prepare(`UPDATE ${table} SET cells=? WHERE id=?`).run(JSON.stringify(next.cells), row.id);
    }
}

// Schema 90 – formatted text properties (#126): every text property but
// the title holds inline Markdown from now on. Once, the existing values
// are escaped so they show exactly as before ("*stars*" stays with its
// stars): records, record templates, records in the trash, database
// versions and saved database templates. Titles stay as they are.
export const FORMATTED_TEXT_MIGRATION = "formatted-text-126";
export function migrateFormattedText(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS data_migrations(name TEXT PRIMARY KEY,at INTEGER NOT NULL)");
  if (d.prepare("SELECT 1 FROM data_migrations WHERE name=?").get(FORMATTED_TEXT_MIGRATION)) return;
  d.exec("SAVEPOINT formatted_text");
  try {
    // Relation sync, AI properties and embeddings need not see this: the
    // text people read stays the same.
    d.exec("UPDATE relation_sync_control SET syncing=1 WHERE id=1");
    const databases = d.prepare("SELECT page_id,fields FROM databases").all() as { page_id: string; fields: string }[];
    const touched: string[] = [];
    const queued = new Set(
      (d.prepare("SELECT row_id FROM ai_auto_dirty UNION SELECT row_id FROM ai_embed_dirty").all() as { row_id: string }[]).map((r) => r.row_id),
    );
    for (const db of databases) {
      let fields: Field[];
      try {
        fields = JSON.parse(db.fields);
      } catch {
        continue;
      }
      if (!Array.isArray(fields) || !fields.some((f) => isFormattedText(f, fields))) continue;
      for (const table of ["rows", "row_templates"] as const)
        for (const row of d.prepare(`SELECT id,cells FROM ${table} WHERE page_id=?`).all(db.page_id) as { id: string; cells: string }[]) {
          const next = escapeFormattedCells(JSON.parse(row.cells), fields);
          if (!next.changed) continue;
          d.prepare(`UPDATE ${table} SET cells=? WHERE id=?`).run(JSON.stringify(next.cells), row.id);
          if (table === "rows") touched.push(row.id);
        }
      for (const entry of d.prepare("SELECT id,payload FROM row_trash WHERE page_id=?").all(db.page_id) as { id: string; payload: string }[]) {
        const payload = JSON.parse(entry.payload) as { row?: { cells?: unknown } };
        const raw = payload.row?.cells;
        const cells = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!cells || typeof cells !== "object") continue;
        const next = escapeFormattedCells(cells as Cells, fields);
        if (!next.changed) continue;
        payload.row!.cells = typeof raw === "string" ? JSON.stringify(next.cells) : next.cells;
        d.prepare("UPDATE row_trash SET payload=? WHERE id=?").run(JSON.stringify(payload), entry.id);
      }
    }
    // Database versions and saved database templates carry their own
    // properties next to their records.
    const escapeSnapshot = (json: string) => {
      const data = JSON.parse(json) as { database?: { fields?: Field[] }; rows?: { cells?: Cells }[]; rowTemplates?: { cells?: Cells }[] };
      const fields = data.database?.fields;
      if (!Array.isArray(fields)) return null;
      let changed = false;
      for (const list of [data.rows, data.rowTemplates])
        for (const item of Array.isArray(list) ? list : []) {
          if (!item?.cells || typeof item.cells !== "object") continue;
          const next = escapeFormattedCells(item.cells, fields);
          if (next.changed) {
            item.cells = next.cells;
            changed = true;
          }
        }
      return changed ? JSON.stringify(data) : null;
    };
    for (const snap of d.prepare("SELECT s.id,s.html FROM snapshots s JOIN pages p ON p.id=s.page_id WHERE p.kind='database' AND s.html LIKE '{%'").all() as { id: string; html: string }[]) {
      try {
        const next = escapeSnapshot(snap.html);
        if (next) d.prepare("UPDATE snapshots SET html=? WHERE id=?").run(next, snap.id);
      } catch {}
    }
    for (const template of d.prepare("SELECT id,payload FROM templates WHERE kind='database'").all() as { id: string; payload: string }[]) {
      try {
        const next = escapeSnapshot(template.payload);
        if (next) d.prepare("UPDATE templates SET payload=? WHERE id=?").run(next, template.id);
      } catch {}
    }
    // Leave out what the triggers queued for AI properties and embeddings
    // of the escaped records (search and offline copies do follow).
    for (const rowId of touched.filter((r) => !queued.has(r))) {
      d.prepare("DELETE FROM ai_auto_dirty WHERE row_id=?").run(rowId);
      d.prepare("DELETE FROM ai_embed_dirty WHERE row_id=?").run(rowId);
    }
    d.exec("UPDATE relation_sync_control SET syncing=0 WHERE id=1");
    d.prepare("INSERT INTO data_migrations(name,at) VALUES(?,?)").run(FORMATTED_TEXT_MIGRATION, Date.now());
    d.exec("RELEASE formatted_text");
  } catch (error) {
    d.exec("ROLLBACK TO formatted_text");
    d.exec("RELEASE formatted_text");
    throw error;
  }
}
