// vCard import and export of contacts databases and the contact card of
// mentions (issue #64). Permissions as everywhere: reading needs read access
// to the database and the record, hidden properties stay out (field-level
// permissions); importing needs edit rights and writable properties.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { all, audit, id, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { requireRow, replaceRowDocument } from "./row-documents";
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

const MAX_PHOTO = 256 * 1024;
const fieldsOf = (pageId: string) => JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];

// The photo behind a record's symbol, when it is a small image of the database.
export function rowPhoto(pageId: string, icon: string | null | undefined): VCardContact["photo"] {
  const fid = /^\/api\/files\/([\w-]+)$/.exec(icon || "")?.[1];
  if (!fid) return null;
  const file = one<{ mime: string; size: number }>("SELECT mime,size FROM files WHERE id=? AND page_id=?", fid, pageId);
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
export function contactsAsVCards(user: Identity, page: Page, rows: Row[], options: { photos?: boolean } = {}) {
  const fields = visibleFields(user, page, fieldsOf(page.id));
  const notes = new Map(
    all<{ row_id: string; html: string }>("SELECT d.row_id,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?", page.id).map((d) => [d.row_id, d.html]),
  );
  return rows.map((row) => {
    const contact = cellsToContact(row.id, row.cells, fields, rowNoteText(notes.get(row.id) ?? row.content ?? ""));
    if (options.photos !== false) contact.photo = rowPhoto(page.id, row.icon);
    return contact;
  });
}
export function readableContactRows(user: Identity, page: Page, rowIds?: string[]) {
  const wanted = rowIds ? new Set(rowIds) : null;
  const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position", page.id)
    .filter((r) => !wanted || wanted.has(r.id))
    .map((r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row);
  return visibleRows(user, page, rows);
}

// One contact, a selection or the whole database as a .vcf text.
export function exportVCards(user: Identity, pageId: string, rowIds?: string[], version: "3.0" | "4.0" = "3.0") {
  const page = requirePage(user, pageId);
  requireContactsDatabase(page.id);
  if (rowIds && rowIds.length > 5000) throw new HttpError(400, "Zu viele Einträge ausgewählt.");
  const rows = readableContactRows(user, page, rowIds);
  if (rowIds && !rows.length) throw new HttpError(404, "Datensatz nicht gefunden.");
  audit(user.id, "contacts.vcard.export", page.id, String(rows.length));
  return { text: serializeVCards(contactsAsVCards(user, page, rows), version), count: rows.length, title: page.title };
}

// A .vcf file with one or more cards: new records, or – for cards exported
// from this database (UID = record id) – updates of those records.
export function importVCards(user: Identity, pageId: string, text: string) {
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (text.length > MAX_VCARD_BYTES) throw new HttpError(413, "Die Datei ist zu groß (höchstens 5 MB).");
  const page = requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  requireContactsDatabase(page.id);
  let contacts: VCardContact[];
  try {
    contacts = parseVCards(text);
  } catch {
    throw new HttpError(400, "Die vCard-Datei kann nicht gelesen werden.");
  }
  if (!contacts.length) throw new HttpError(400, "Die Datei enthält keine Kontakte (vCard).");
  return transaction(() => {
    autoDatabaseSnapshot(user, page);
    const categories = [...new Set(contacts.flatMap((c) => c.categories))];
    ensureOptions(page.id, CONTACT_FIELDS.tags, categories.filter((c) => !MISSING_TAGS.includes(c)).slice(0, 200));
    const fields = fieldsOf(page.id);
    const result = { created: 0, updated: 0, skipped: 0 };
    let position = Date.now();
    for (const contact of contacts) {
      const cells = contactToCells({ ...contact, categories: contact.categories.filter((c) => !MISSING_TAGS.includes(c)) }, fields);
      assertFieldsWritable(user, page, fields, Object.keys(cells));
      const existing = contact.uid ? one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", contact.uid, page.id) : undefined;
      if (existing) {
        // Records the directory keeps are left alone.
        if (one("SELECT 1 FROM contact_ldap_links WHERE row_id=?", existing.id)) {
          result.skipped++;
          continue;
        }
        const { row } = requireRow(user, page.id, existing.id, true);
        const before = JSON.parse(row.cells as unknown as string);
        const after = deriveContactCells(fields, before, { ...before, ...cells }, Object.keys(cells));
        run("UPDATE rows SET cells=?,updated_at=CURRENT_TIMESTAMP,updated_by=?,version=version+1 WHERE id=?", JSON.stringify(after), user.id, row.id);
        if (contact.note && contact.note !== rowNoteText(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id)?.html ?? row.content ?? ""))
          replaceRowDocument(row.id, noteHtml(contact.note), user.id);
        afterContactWrite(page.id, row.id);
        result.updated++;
        continue;
      }
      const rid = id();
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
        rid,
        page.id,
        JSON.stringify(deriveContactCells(fields, {}, cells, Object.keys(cells))),
        position++,
        user.id,
        user.id,
      );
      if (contact.note) replaceRowDocument(rid, noteHtml(contact.note), user.id);
      if (contact.photo) {
        const bytes = Buffer.from(contact.photo.base64, "base64");
        const kind = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.subarray(0, 4).toString("hex") === "89504e47" ? "image/png" : "";
        if (kind && bytes.length <= MAX_PHOTO) storeContactPhoto(page, rid, bytes, kind, user.id);
      }
      afterContactWrite(page.id, rid);
      rowCreated(user, page, rid);
      result.created++;
    }
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
    audit(user.id, "contacts.vcard.import", page.id, JSON.stringify(result));
    return result;
  }, user);
}

// The card of a mentioned contact (hover or tap on a link to the record).
// Null for records of other databases: the client shows the page preview.
export function contactCard(user: Identity, pageId: string, rowId: string) {
  const { page, row } = requireRow(user, pageId, rowId);
  if (!isContactsDatabase(page.id)) return null;
  const fields = visibleFields(user, page, fieldsOf(page.id));
  const cells = JSON.parse(row.cells as unknown as string) as Record<string, unknown>;
  const value = (key: string) => (fields.some((f) => f.id === key) ? cellText(cells[key]).trim() : "");
  const link = one<{ missing_at: number | null }>("SELECT missing_at FROM contact_ldap_links WHERE row_id=?", row.id);
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
export type ContactCardData = NonNullable<ReturnType<typeof contactCard>>;
