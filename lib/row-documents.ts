import { requireDocumentSize } from "./document-size";
import * as Y from "yjs";
import { z } from "zod";
import { all, one, run, id, nowText, inSavepoint, sql } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { assertRowAccess } from "./row-access";
import { hiddenFieldsFor, stripCells, unwritableFieldIds } from "./field-access";
import { requireUnlocked } from "./journal-extras";
import { cleanHtml, escaped, htmlState, stateHtml } from "./document-server";
import type { Identity, Page, Row, Field } from "./types";
import { documentChanged } from "./document-live";
import { recordDocumentAuthors } from "./document-authors";
import { mentionWebhook } from "./webhooks";
import { mapHtmlPlaceholders, mapPlaceholders, mapTextCells, storeKey } from "./record-placeholders";
type StoredDocument = { state: Uint8Array; html: string; generation: string };
export type RowTemplate = {
  id: string;
  page_id: string;
  name: string;
  cells: string;
  html: string;
  is_default: number;
};
export async function requireRow(
  user: Identity,
  pageId: string,
  rowId: string,
  write = false,
) {
  const page = await requirePage(user, pageId, write);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  // Records of a database below a journal stay behind its PIN.
  await requireUnlocked(user, page);
  if (write && page.locked)
    throw new HttpError(409, "Diese Seite ist gesperrt.");
  const row = await one<Row>(
    "SELECT * FROM rows WHERE id=? AND page_id=?",
    rowId,
    pageId,
  );
  if (!row) throw new HttpError(404, "Datensatz nicht gefunden.");
  await assertRowAccess(user, page, row, write);
  return { page, row };
}
// `forUpdate`: the row stays locked until the commit (PostgreSQL), for a
// merge that writes the state back (syncRowDocument).
export async function ensureRowDocument(row: Row, forUpdate = false): Promise<StoredDocument> {
  const lock = forUpdate ? sql.forUpdate() : "";
  let d = await one<StoredDocument>(
    `SELECT * FROM row_documents WHERE row_id=?${lock}`,
    row.id,
  );
  if (!d) {
    const source = row.content || "";
    const html = source.startsWith("<")
      ? cleanHtml(source)
      : `<p>${escaped(source).replaceAll("\n", "</p><p>")}</p>`;
    d = { state: htmlState(html), html, generation: id() };
    await run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      row.id,
      d.state,
      d.html,
      d.generation,
    );
    d = (await one<StoredDocument>(
      `SELECT * FROM row_documents WHERE row_id=?${lock}`,
      row.id,
    ))!;
  }
  return d;
}
export async function rowDocumentData(user: Identity, pageId: string, rowId: string) {
  const { row } = await requireRow(user, pageId, rowId);
  const d = await ensureRowDocument(row);
  return {
    state: Buffer.from(d.state).toString("base64"),
    html: d.html,
    generation: d.generation,
    snapshots: await all<{ id: string; created_at: string }>(
      "SELECT id,created_at FROM row_snapshots WHERE row_id=? ORDER BY created_at DESC,seq DESC LIMIT 50",
      rowId,
    ),
  };
}
export async function syncRowDocument(
  user: Identity,
  pageId: string,
  rowId: string,
  generation: unknown,
  update: unknown,
) {
  const { row, page } = await requireRow(user, pageId, rowId, true);
  const previous = await ensureRowDocument(row, true);
  if (previous.generation !== generation)
    throw new HttpError(
      409,
      "Eine neue Dokumentversion ist verfügbar. Die Seite wird neu geladen.",
    );
  const encoded = z.string().max(8_000_000).parse(update);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, previous.state);
    const before = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, Buffer.from(encoded, "base64"));
    const state = Y.encodeStateAsUpdate(doc);
    // Refused above the size cap (lib/document-size.ts) before anything is written.
    requireDocumentSize(state, previous.state.byteLength);
    await recordDocumentAuthors(pageId, rowId, previous.generation, user.id, before, Y.encodeStateVector(doc));
    const html = stateHtml(doc);
    if (
      html !== previous.html &&
      !(await one(
        "SELECT id FROM row_snapshots WHERE row_id=? AND created_at>?",
        row.id, nowText(Date.now() - 300_000),
      ))
    )
      await snapshotRow(user, pageId, rowId);
    await run(
      "UPDATE row_documents SET state=?,html=?,updated_at=? WHERE row_id=?",
      state,
      html, nowText(),
      row.id,
    );
    await run(
      "UPDATE rows SET content=?,updated_at=?,updated_by=? WHERE id=?",
      html, nowText(),
      user.id,
      row.id,
    );
    await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), pageId);
    for (const match of html.matchAll(/data-mention="([^"]+)"/g)) {
      const uid = match[1];
      if (
        uid !== user.id &&
        !previous.html.includes('data-mention="' + uid + '"')
      ) {
        try {
          await requireRow({ ...user, id: uid }, pageId, rowId);
          await inSavepoint(async () =>
            await run(
              "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'mention')",
              id(),
              uid,
              `${user.name} hat dich in einem Eintrag von „${page.title}“ erwähnt`,
              pageId,
              rowId,
            ),
          );
          await mentionWebhook(page.workspace_id, pageId, rowId, uid, user.name, user.id);
        } catch {}
      }
    }
    return { state: Buffer.from(state).toString("base64") };
  } finally {
    doc.destroy();
  }
}
export async function snapshotRow(user: Identity, pageId: string, rowId: string) {
  const { row } = await requireRow(user, pageId, rowId, true),
    d = await ensureRowDocument(row);
  const sid = id();
  await run(
    "INSERT INTO row_snapshots(id,row_id,state,html,created_by,kind) VALUES(?,?,?,?,?,'manual')",
    sid,
    rowId,
    d.state,
    d.html,
    user.id,
  );
  return { id: sid };
}
export async function restoreRow(
  user: Identity,
  pageId: string,
  rowId: string,
  snapshotId: unknown,
) {
  await requireRow(user, pageId, rowId, true);
  const sid = z.string().uuid().parse(snapshotId);
  const s = await one<{ html: string }>(
    "SELECT html FROM row_snapshots WHERE id=? AND row_id=?",
    sid,
    rowId,
  );
  if (!s) throw new HttpError(404, "Version nicht gefunden.");
  await snapshotRow(user, pageId, rowId);
  await replaceRowDocument(rowId, s.html, user.id);
}
export async function replaceRowDocument(
  rowId: string,
  html: string,
  userId: string,
) {
  const safe = cleanHtml(html);
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html,generation=excluded.generation,updated_at=?",
    rowId,
    htmlState(safe),
    safe,
    id(), nowText(),
  );
  await run(
    "UPDATE rows SET content=?,updated_at=?,updated_by=? WHERE id=?",
    safe, nowText(),
    userId,
    rowId,
  );
  const owner = await one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", rowId);
  if (owner) documentChanged(owner.page_id, rowId);
}
export async function rowTemplates(pageId: string) {
  return await all<{ id: string; name: string; is_default: number }>(
    "SELECT id,name,is_default FROM row_templates WHERE page_id=? ORDER BY created_at",
    pageId,
  );
}
export async function selectedRowTemplate(
  pageId: string,
  templateId: unknown,
): Promise<RowTemplate | undefined> {
  if (templateId === null) return undefined;
  const template = templateId
    ? (await one<RowTemplate>(
        "SELECT * FROM row_templates WHERE id=? AND page_id=?",
        z.string().uuid().parse(templateId),
        pageId,
      ))
    : (await one<RowTemplate>(
        "SELECT * FROM row_templates WHERE page_id=? AND is_default=1",
        pageId,
      ));
  if (templateId && !template)
    throw new HttpError(404, "Datensatzvorlage nicht gefunden.");
  return template;
}
// A stored template's cells without the properties hidden from a reader
// (archives, page templates, copies).
export async function readableTemplateCells(user: Identity, page: Page, cells: string, hidden?: Awaited<ReturnType<typeof hiddenFieldsFor>>) {
  if (hidden === undefined) hidden = await hiddenFieldsFor(user, page);
  return stripCells(JSON.parse(cells) as Record<string, unknown>, hidden);
}
export async function saveRowTemplate(
  user: Identity,
  pageId: string,
  rowId: string,
  name: unknown,
  replaceId?: unknown,
) {
  const { page, row } = await requireRow(user, pageId, rowId, true),
    d = await ensureRowDocument(row);
  const raw = (await one<{ fields: string }>(
    "SELECT fields FROM databases WHERE page_id=?",
    pageId,
  ))!;
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
        "id",
        "progress",
        "time",
      ].includes(f.type)
    )
      delete cells[f.id];
  // Only values this person may read and change go into the template: a
  // template must not carry a hidden value out of someone's record
  // (lib/field-access.ts).
  const unwritable = await unwritableFieldIds(user, page, fields);
  for (const key of unwritable) delete cells[key];
  // Placeholders name properties by id from now on, so renaming a
  // property keeps the template working (lib/record-placeholders.ts).
  const store = (key: string) => storeKey(key, fields);
  const html = mapHtmlPlaceholders(d.html, store);
  const stored = mapTextCells(cells, fields, (text) => mapPlaceholders(text, store));
  const title = z.string().trim().min(1).max(200).parse(name);
  // An edited template replaces the one it came from (same id: default
  // template and automations keep pointing at it).
  if (replaceId) {
    const old = await selectedRowTemplate(pageId, replaceId);
    if (!old) throw new HttpError(404, "Datensatzvorlage nicht gefunden.");
    // Values of the old template this person may not change stay as they were.
    const previous = JSON.parse(old.cells) as Record<string, unknown>;
    for (const key of unwritable) if (key in previous) stored[key] = previous[key];
    await run(
      "UPDATE row_templates SET name=?,cells=?,html=? WHERE id=?",
      title,
      JSON.stringify(stored),
      html,
      old.id,
    );
    return { id: old.id };
  }
  const tid = id();
  await run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,created_by) VALUES(?,?,?,?,?,?)",
    tid,
    pageId,
    title,
    JSON.stringify(stored),
    html,
    user.id,
  );
  return { id: tid };
}
export async function manageRowTemplate(
  user: Identity,
  pageId: string,
  templateId: unknown,
  operation: "default" | "delete",
  enabled = false,
) {
  const p = await requirePage(user, pageId, true);
  if (p.locked) throw new HttpError(409, "Seite ist gesperrt.");
  const t = await selectedRowTemplate(pageId, templateId);
  if (!t) throw new HttpError(404, "Vorlage fehlt.");
  if (operation === "delete") await run("DELETE FROM row_templates WHERE id=?", t.id);
  else {
    await run("UPDATE row_templates SET is_default=0 WHERE page_id=?", pageId);
    if (enabled) await run("UPDATE row_templates SET is_default=1 WHERE id=?", t.id);
  }
}
