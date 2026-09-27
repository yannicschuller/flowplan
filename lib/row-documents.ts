import * as Y from "yjs";
import { z } from "zod";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { assertRowAccess } from "./row-access";
import { cleanHtml, escaped, htmlState, stateHtml } from "./document-server";
import type { Identity, Row, Field } from "./types";
import { documentChanged } from "./document-live";
type StoredDocument = { state: Uint8Array; html: string; generation: string };
export type RowTemplate = {
  id: string;
  page_id: string;
  name: string;
  cells: string;
  html: string;
  is_default: number;
};
export function requireRow(
  user: Identity,
  pageId: string,
  rowId: string,
  write = false,
) {
  const page = requirePage(user, pageId, write);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  if (write && page.locked)
    throw new HttpError(409, "Diese Seite ist gesperrt.");
  const row = one<Row>(
    "SELECT * FROM rows WHERE id=? AND page_id=?",
    rowId,
    pageId,
  );
  if (!row) throw new HttpError(404, "Datensatz nicht gefunden.");
  assertRowAccess(user, page, row, write);
  return { page, row };
}
export function ensureRowDocument(row: Row): StoredDocument {
  let d = one<StoredDocument>(
    "SELECT * FROM row_documents WHERE row_id=?",
    row.id,
  );
  if (!d) {
    const source = row.content || "";
    const html = source.startsWith("<")
      ? cleanHtml(source)
      : `<p>${escaped(source).replaceAll("\n", "</p><p>")}</p>`;
    d = { state: htmlState(html), html, generation: id() };
    run(
      "INSERT OR IGNORE INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
      row.id,
      d.state,
      d.html,
      d.generation,
    );
    d = one<StoredDocument>(
      "SELECT * FROM row_documents WHERE row_id=?",
      row.id,
    )!;
  }
  return d;
}
export function rowDocumentData(user: Identity, pageId: string, rowId: string) {
  const { row } = requireRow(user, pageId, rowId);
  const d = ensureRowDocument(row);
  return {
    state: Buffer.from(d.state).toString("base64"),
    html: d.html,
    generation: d.generation,
    snapshots: all<{ id: string; created_at: string }>(
      "SELECT id,created_at FROM row_snapshots WHERE row_id=? ORDER BY created_at DESC LIMIT 50",
      rowId,
    ),
  };
}
export function syncRowDocument(
  user: Identity,
  pageId: string,
  rowId: string,
  generation: unknown,
  update: unknown,
) {
  const { row, page } = requireRow(user, pageId, rowId, true);
  const previous = ensureRowDocument(row);
  if (previous.generation !== generation)
    throw new HttpError(
      409,
      "Eine neue Dokumentversion ist verfügbar. Die Seite wird neu geladen.",
    );
  const encoded = z.string().max(8_000_000).parse(update);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, previous.state);
    Y.applyUpdate(doc, Buffer.from(encoded, "base64"));
    const html = stateHtml(doc),
      state = Y.encodeStateAsUpdate(doc);
    if (
      html !== previous.html &&
      !one(
        "SELECT id FROM row_snapshots WHERE row_id=? AND created_at>datetime('now','-5 minutes')",
        row.id,
      )
    )
      snapshotRow(user, pageId, rowId);
    run(
      "UPDATE row_documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE row_id=?",
      state,
      html,
      row.id,
    );
    run(
      "UPDATE rows SET content=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?",
      html,
      user.id,
      row.id,
    );
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
    for (const match of html.matchAll(/data-mention="([^"]+)"/g)) {
      const uid = match[1];
      if (
        uid !== user.id &&
        !previous.html.includes('data-mention="' + uid + '"')
      ) {
        try {
          requireRow({ ...user, id: uid }, pageId, rowId);
          run(
            "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'mention')",
            id(),
            uid,
            `${user.name} hat dich in einem Eintrag von „${page.title}“ erwähnt`,
            pageId,
            rowId,
          );
        } catch {}
      }
    }
    return { state: Buffer.from(state).toString("base64") };
  } finally {
    doc.destroy();
  }
}
export function snapshotRow(user: Identity, pageId: string, rowId: string) {
  const { row } = requireRow(user, pageId, rowId, true),
    d = ensureRowDocument(row);
  const sid = id();
  run(
    "INSERT INTO row_snapshots(id,row_id,state,html,created_by,kind) VALUES(?,?,?,?,?,'manual')",
    sid,
    rowId,
    d.state,
    d.html,
    user.id,
  );
  return { id: sid };
}
export function restoreRow(
  user: Identity,
  pageId: string,
  rowId: string,
  snapshotId: unknown,
) {
  requireRow(user, pageId, rowId, true);
  const sid = z.string().uuid().parse(snapshotId);
  const s = one<{ html: string }>(
    "SELECT html FROM row_snapshots WHERE id=? AND row_id=?",
    sid,
    rowId,
  );
  if (!s) throw new HttpError(404, "Version nicht gefunden.");
  snapshotRow(user, pageId, rowId);
  replaceRowDocument(rowId, s.html, user.id);
}
export function replaceRowDocument(
  rowId: string,
  html: string,
  userId: string,
) {
  const safe = cleanHtml(html);
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html,generation=excluded.generation,updated_at=CURRENT_TIMESTAMP",
    rowId,
    htmlState(safe),
    safe,
    id(),
  );
  run(
    "UPDATE rows SET content=?,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?",
    safe,
    userId,
    rowId,
  );
  const owner = one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", rowId);
  if (owner) documentChanged(owner.page_id, rowId);
}
export function rowTemplates(pageId: string) {
  return all<{ id: string; name: string; is_default: number }>(
    "SELECT id,name,is_default FROM row_templates WHERE page_id=? ORDER BY created_at",
    pageId,
  );
}
export function selectedRowTemplate(
  pageId: string,
  templateId: unknown,
): RowTemplate | undefined {
  if (templateId === null) return undefined;
  const template = templateId
    ? one<RowTemplate>(
        "SELECT * FROM row_templates WHERE id=? AND page_id=?",
        z.string().uuid().parse(templateId),
        pageId,
      )
    : one<RowTemplate>(
        "SELECT * FROM row_templates WHERE page_id=? AND is_default=1",
        pageId,
      );
  if (templateId && !template)
    throw new HttpError(404, "Datensatzvorlage nicht gefunden.");
  return template;
}
export function saveRowTemplate(
  user: Identity,
  pageId: string,
  rowId: string,
  name: unknown,
) {
  const { row } = requireRow(user, pageId, rowId, true),
    d = ensureRowDocument(row);
  const raw = one<{ fields: string }>(
    "SELECT fields FROM databases WHERE page_id=?",
    pageId,
  )!;
  const fields = JSON.parse(raw.fields) as Field[];
  const cells = JSON.parse(String(row.cells));
  for (const f of fields)
    if (
      [
        "formula",
        "rollup",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
      ].includes(f.type)
    )
      delete cells[f.id];
  const tid = id();
  run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,created_by) VALUES(?,?,?,?,?,?)",
    tid,
    pageId,
    z.string().trim().min(1).max(200).parse(name),
    JSON.stringify(cells),
    d.html,
    user.id,
  );
  return { id: tid };
}
export function manageRowTemplate(
  user: Identity,
  pageId: string,
  templateId: unknown,
  operation: "default" | "delete",
  enabled = false,
) {
  const p = requirePage(user, pageId, true);
  if (p.locked) throw new HttpError(409, "Seite ist gesperrt.");
  const t = selectedRowTemplate(pageId, templateId);
  if (!t) throw new HttpError(404, "Vorlage fehlt.");
  if (operation === "delete") run("DELETE FROM row_templates WHERE id=?", t.id);
  else {
    run("UPDATE row_templates SET is_default=0 WHERE page_id=?", pageId);
    if (enabled) run("UPDATE row_templates SET is_default=1 WHERE id=?", t.id);
  }
}
