// Sticky notes → database records (command "whiteboard.toRecords", no AI
// needed): the note's first line becomes the title, further lines the
// record's document, its colour optionally a select option and its author
// optionally a person. The browser then replaces the notes with live record
// cards (lib/whiteboard-cards.ts) or links them – an ordinary board edit,
// so collaborators see it at once and it can be undone.
//
// Idempotent: each record carries an id chosen by the browser; a repeated
// command (retry, double click) finds the record already there and answers
// the same. Only editors of the board who may add records to the database
// use it; values are checked like every edit (validateCellPatch: field
// permissions, options, members). At most WB_AI_LIMITS.batch records per
// command; the browser sends larger selections in batches.
import { HttpError } from "./auth";
import { one } from "./db";
import { command, database } from "./api";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { validateCellPatch } from "./database-operations";
import { replaceRowDocument } from "./row-documents";
import { escaped } from "./document-server";
import { noteTitle, toRecordsInput } from "./whiteboard-ai";
import type { Identity } from "./types";

export type ToRecordsResult = { records: { itemId: string; rowId: string; created: boolean }[] };

export function notesToRecords(user: Identity, raw: unknown): ToRecordsResult {
  const b = toRecordsInput.parse(raw);
  const board = requirePage(user, b.pageId, true);
  if (board.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  if (board.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const db = requirePage(user, b.databaseId, true);
  if (db.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  if (db.workspace_id !== board.workspace_id) throw new HttpError(404, "Seite nicht gefunden.");
  if (db.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  requireUnlocked(user, db);
  const fields = database(db.id).fields;
  const title = fields[0];
  if (!title) throw new HttpError(400, "Eigenschaft fehlt.");
  const colorField = b.colorField ? fields.find((f) => f.id === b.colorField && f.type === "select") : undefined;
  if (b.colorField && !colorField) throw new HttpError(400, "Eigenschaft fehlt.");
  const personField = b.personField ? fields.find((f) => f.id === b.personField && f.type === "person") : undefined;
  if (b.personField && !personField) throw new HttpError(400, "Eigenschaft fehlt.");
  const records: ToRecordsResult["records"] = [];
  for (const note of b.records) {
    const existing = one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", note.rowId);
    if (existing?.page_id === db.id) {
      records.push({ itemId: note.itemId, rowId: note.rowId, created: false });
      continue;
    }
    const { title: text, body } = noteTitle(note.text);
    const given: Record<string, unknown> = { ...(note.cells || {}) };
    delete given[title.id];
    if (colorField) {
      const option = note.color ? b.colorOptions?.[note.color] : undefined;
      if (option) given[colorField.id] = option;
    }
    // Authors who are no member of the workspace (any more) stay empty.
    if (personField && note.author && one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", db.workspace_id, note.author))
      given[personField.id] = note.author;
    const checked = Object.keys(given).length ? validateCellPatch(user, db, fields, given) : {};
    command(user, { action: "row.create", pageId: db.id, rowId: note.rowId, cells: { ...checked, [title.id]: text } }, true);
    if (body) replaceRowDocument(note.rowId, body.split(/\n{2,}/).map((p) => `<p>${escaped(p).replace(/\n/g, "<br>")}</p>`).join(""), user.id);
    records.push({ itemId: note.itemId, rowId: note.rowId, created: true });
  }
  return { records };
}
