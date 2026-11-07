// vCard import and export of contacts databases and the contact card of
// mentions (issue #64). Permissions as everywhere: reading needs read access
// to the database and the record, hidden properties stay out (field-level
// permissions); importing needs edit rights and writable properties.
import { toPlain } from "./inline-markdown";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { all, audit, id, one, run, transaction, nowText } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { requireRow, replaceRowDocument } from "./row-documents";
import { requireUnlocked } from "./journal-extras";
import { assertFieldsWritable, visibleFields } from "./field-access";
import { cellText } from "./cell-text";
import { rowCreated } from "./automations";
import { autoDatabaseSnapshot } from "./database-operations";
import {
  CONTACT_FIELDS,
  MISSING_TAGS,
  afterContactWrite,
  cellsToContact,
  contactToCells,
  deriveContactCells,
  ensureOptions,
  isContactsDatabase,
  noteHtml,
  requireContactsDatabase,
  rowNoteText,
} from "./contacts";
import { storeContactPhoto } from "./contacts-ldap";
import { MAX_VCARD_BYTES, parseVCards, serializeVCards, type VCardContact } from "./vcard";
import type { Field, Identity, Page, Row } from "./types";
import { mapAsync } from "./each-async";

const MAX_PHOTO = 256 * 1024;
const fieldsOf = async (pageId: string) => JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))!.fields) as Field[];

// The photo behind a record's symbol, when it is a small image of the database.
export async function rowPhoto(pageId: string, icon: string | null | undefined): Promise<VCardContact["photo"]> {
  const fid = /^\/api\/files\/([\w-]+)$/.exec(icon || "")?.[1];
  if (!fid) return null;
  const file = await one<{ mime: string; size: number }>("SELECT mime,size FROM files WHERE id=? AND page_id=?", fid, pageId);
  if (!file || !["image/jpeg", "image/png"].includes(file.mime) || file.size > MAX_PHOTO) return null;
  const path = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", fid);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_PHOTO) return null;
    return { mime: file.mime, base64: readFileSync(path).toString("base64") };
  } catch {
    return null;
  }
}
// Records as vCards (contacts of a database the person may read).
export async function contactsAsVCards(user: Identity, page: Page, rows: Row[], options: { photos?: boolean } = {}) {
  const fields = await visibleFields(user, page, await fieldsOf(page.id));
  const notes = new Map(
    (await all<{ row_id: string; html: string }>("SELECT d.row_id,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?", page.id)).map((d) => [d.row_id, d.html]),
  );
  return await mapAsync(rows, async (row) => {
    const contact = cellsToContact(row.id, row.cells, fields, rowNoteText(notes.get(row.id) ?? row.content ?? ""));
    if (options.photos !== false) contact.photo = await rowPhoto(page.id, row.icon);
    return contact;
  });
}
export async function readableContactRows(user: Identity, page: Page, rowIds?: string[]) {
  const wanted = rowIds ? new Set(rowIds) : null;
  const rows = (await all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position", page.id))
    .filter((r) => !wanted || wanted.has(r.id))
    .map((r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row);
  return await visibleRows(user, page, rows);
}

// One contact, a selection or the whole database as a .vcf text.
export async function exportVCards(user: Identity, pageId: string, rowIds?: string[], version: "3.0" | "4.0" = "3.0") {
  const page = await requirePage(user, pageId);
  await requireUnlocked(user, page);
  await requireContactsDatabase(page.id);
  if (rowIds && rowIds.length > 5000) throw new HttpError(400, "Zu viele Einträge ausgewählt.");
  const rows = await readableContactRows(user, page, rowIds);
  if (rowIds && !rows.length) throw new HttpError(404, "Datensatz nicht gefunden.");
  await audit(user.id, "contacts.vcard.export", page.id, String(rows.length));
  return { text: serializeVCards(await contactsAsVCards(user, page, rows), version), count: rows.length, title: page.title };
}

// A .vcf file with one or more cards: new records, or – for cards exported
// from this database (UID = record id) – updates of those records.
export async function importVCards(user: Identity, pageId: string, text: string) {
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (text.length > MAX_VCARD_BYTES) throw new HttpError(413, "Die Datei ist zu groß (höchstens 5 MB).");
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  await requireContactsDatabase(page.id);
  let contacts: VCardContact[];
  try {
    contacts = parseVCards(text);
  } catch {
    throw new HttpError(400, "Die vCard-Datei kann nicht gelesen werden.");
  }
  if (!contacts.length) throw new HttpError(400, "Die Datei enthält keine Kontakte (vCard).");
  return await transaction(async () => {
    await autoDatabaseSnapshot(user, page);
    const categories = [...new Set(contacts.flatMap((c) => c.categories))];
    await ensureOptions(page.id, CONTACT_FIELDS.tags, categories.filter((c) => !MISSING_TAGS.includes(c)).slice(0, 200));
    const fields = await fieldsOf(page.id);
    const result = { created: 0, updated: 0, skipped: 0 };
    let position = Date.now();
    for (const contact of contacts) {
      const cells = contactToCells({ ...contact, categories: contact.categories.filter((c) => !MISSING_TAGS.includes(c)) }, fields);
      await assertFieldsWritable(user, page, fields, Object.keys(cells));
      const existing = contact.uid ? (await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", contact.uid, page.id)) : undefined;
      if (existing) {
        // Records the directory keeps are left alone.
        if (await one("SELECT 1 FROM contact_ldap_links WHERE row_id=?", existing.id)) {
          result.skipped++;
          continue;
        }
        const { row } = await requireRow(user, page.id, existing.id, true);
        const before = JSON.parse(row.cells as unknown as string);
        const after = deriveContactCells(fields, before, { ...before, ...cells }, Object.keys(cells));
        await run("UPDATE rows SET cells=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?", JSON.stringify(after), nowText(), user.id, row.id);
        if (contact.note && contact.note !== rowNoteText((await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id))?.html ?? row.content ?? ""))
          await replaceRowDocument(row.id, noteHtml(contact.note), user.id);
        await afterContactWrite(page.id, row.id);
        result.updated++;
        continue;
      }
      const rid = id();
      await run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
        rid,
        page.id,
        JSON.stringify(deriveContactCells(fields, {}, cells, Object.keys(cells))),
        position++,
        user.id,
        user.id,
      );
      if (contact.note) await replaceRowDocument(rid, noteHtml(contact.note), user.id);
      if (contact.photo) {
        const bytes = Buffer.from(contact.photo.base64, "base64");
        const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.subarray(0, 4).toString("hex") === "89504e47" ? "image/png" : "";
        if (kind && bytes.length <= MAX_PHOTO) await storeContactPhoto(page, rid, bytes, kind, user.id);
      }
      await afterContactWrite(page.id, rid);
      await rowCreated(user, page, rid);
      result.created++;
    }
    await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), page.id);
    await audit(user.id, "contacts.vcard.import", page.id, JSON.stringify(result));
    return result;
  }, user);
}

// The card of a mentioned contact (hover or tap on a link to the record).
// Null for records of other databases: the client shows the page preview.
export async function contactCard(user: Identity, pageId: string, rowId: string) {
  const { page, row } = await requireRow(user, pageId, rowId);
  if (!(await isContactsDatabase(page.id))) return null;
  const fields = await visibleFields(user, page, await fieldsOf(page.id));
  const cells = JSON.parse(row.cells as unknown as string) as Record<string, unknown>;
  // Formatted text (#126) as plain text.
  const value = (key: string) => (fields.some((f) => f.id === key) ? toPlain(cellText(cells[key])).trim() : "");
  const link = await one<{ missing_at: number | null }>("SELECT missing_at FROM contact_ldap_links WHERE row_id=?", row.id);
  return {
    pageId: page.id,
    rowId: row.id,
    database: page.title,
    name: cellText(cells[fields[0]?.id || CONTACT_FIELDS.title]).trim() || [value(CONTACT_FIELDS.firstName), value(CONTACT_FIELDS.lastName)].filter(Boolean).join(" "),
    firstName: value(CONTACT_FIELDS.firstName),
    lastName: value(CONTACT_FIELDS.lastName),
    company: value(CONTACT_FIELDS.company),
    position: value(CONTACT_FIELDS.position),
    email: value(CONTACT_FIELDS.email),
    phone: value(CONTACT_FIELDS.phone),
    mobile: value(CONTACT_FIELDS.mobile),
    city: value(CONTACT_FIELDS.city),
    photo: /^\/api\/files\/[\w-]+$/.test(row.icon || "") ? row.icon : "",
    ldap: !!link,
    missing: !!link?.missing_at,
  };
}
export type ContactCardData = NonNullable<Awaited<ReturnType<typeof contactCard>>>;
