// Contacts databases (issue #64): a database kind whose records are people
// with a profile page – a contact card above the free text.
//
// - A contacts database is a database whose record layout says
//   card: "contact" (lib/record-layout.ts). New ones come from
//   databaseSetup("contacts") (lib/seed.ts) with fixed property ids
//   (CONTACT_FIELDS), so imports, the LDAP sync and CardDAV find their
//   properties whatever they are called; renamed or deleted properties are
//   simply skipped.
// - The title is the display name "Vorname Nachname": it follows the name
//   properties as long as nobody wrote another title, and a title typed
//   into a contact without names fills them (last word = last name).
// - A birthday repeats yearly (the record's recurrence), so the calendar
//   view "Geburtstage" shows it every year.
// - Records that came from the LDAP directory (lib/contacts-ldap.ts) keep
//   the directory's values: those properties are read-only here.
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { cellText } from "./cell-text";
import { parseRecordLayout } from "./record-layout";
import { emptyContact, type VCardContact } from "./vcard";
import type { Field, View } from "./types";

export const CONTACT_FIELDS = {
  title: "title",
  firstName: "firstName",
  lastName: "lastName",
  company: "company",
  position: "position",
  email: "email",
  phone: "phone",
  mobile: "mobile",
  street: "street",
  postalCode: "postalCode",
  city: "city",
  country: "country",
  birthday: "birthday",
  tags: "tags",
} as const;
export type ContactKey = keyof typeof CONTACT_FIELDS;
const F = CONTACT_FIELDS;
// Tags the LDAP sync sets on records whose entry left the directory.
export const MISSING_TAGS = ["Nicht mehr im Verzeichnis", "No longer in directory"];
// What a new contact is called before it has a name (components/database-view.tsx).
export const NEW_CONTACT_TITLES = ["Neuer Kontakt", "New contact"];

export function contactsSetup(): { fields: Field[]; views: View[]; recordLayout: object } {
  return {
    fields: [
      { id: F.title, name: "Name", type: "text" },
      { id: F.firstName, name: ct("Vorname", "First name"), type: "text" },
      { id: F.lastName, name: ct("Nachname", "Last name"), type: "text" },
      { id: F.company, name: ct("Firma", "Company"), type: "text" },
      { id: F.position, name: "Position", type: "text" },
      { id: F.email, name: ct("E-Mail", "E-mail"), type: "email" },
      { id: F.phone, name: ct("Telefon", "Phone"), type: "phone" },
      { id: F.mobile, name: ct("Mobil", "Mobile"), type: "phone" },
      { id: F.street, name: ct("Straße", "Street"), type: "text" },
      { id: F.postalCode, name: ct("PLZ", "Postal code"), type: "text" },
      { id: F.city, name: ct("Ort", "City"), type: "text" },
      { id: F.country, name: ct("Land", "Country"), type: "text" },
      { id: F.birthday, name: ct("Geburtstag", "Birthday"), type: "date" },
      { id: F.tags, name: "Tags", type: "multiselect", options: [] },
    ],
    views: [
      {
        id: "list",
        name: ct("Alle Kontakte", "All contacts"),
        type: "list",
        filters: [],
        sorts: [
          { field: F.lastName, direction: "asc" },
          { field: F.firstName, direction: "asc" },
        ],
      },
      {
        id: "table",
        name: ct("Tabelle", "Table"),
        type: "table",
        filters: [],
        sorts: [{ field: F.lastName, direction: "asc" }],
        hiddenFields: [F.street, F.postalCode, F.country, F.birthday],
      },
      {
        id: "birthdays",
        name: ct("Geburtstage", "Birthdays"),
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: F.birthday,
      },
      { id: "gallery", name: ct("Galerie", "Gallery"), type: "gallery", filters: [], sorts: [{ field: F.lastName, direction: "asc" }] },
    ],
    recordLayout: { open: "full", properties: "top", hideEmpty: true, hidden: [], card: "contact" },
  };
}

export function isContactsLayout(raw: unknown) {
  return parseRecordLayout(raw).card === "contact";
}
export function isContactsDatabase(pageId: string) {
  const row = one<{ record_layout: string | null }>("SELECT record_layout FROM databases WHERE page_id=?", pageId);
  return !!row && isContactsLayout(row.record_layout);
}
export function requireContactsDatabase(pageId: string) {
  if (!isContactsDatabase(pageId)) throw new HttpError(400, "Das ist keine Kontakte-Datenbank.");
}

type Cells = Record<string, unknown>;
const text = (cells: Cells, key: string) => cellText(cells[key]).trim();
export const contactName = (cells: Cells) => [text(cells, F.firstName), text(cells, F.lastName)].filter(Boolean).join(" ");

// The title and name properties after a change (also for new records: before
// is then empty). `changed` are the properties the change named.
export function deriveContactCells(fields: Field[], before: Cells, after: Cells, changed: string[]): Cells {
  const has = (id: string) => fields.some((f) => f.id === id);
  const titleField = fields[0]?.id;
  if (!titleField || !has(F.firstName) || !has(F.lastName)) return after;
  const next = { ...after };
  const oldTitle = text(before, titleField),
    newTitle = text(after, titleField),
    oldName = contactName(before),
    newName = contactName(after);
  const namesChanged = changed.includes(F.firstName) || changed.includes(F.lastName);
  const titleChanged = changed.includes(titleField) && newTitle !== oldTitle;
  if (namesChanged && !titleChanged) {
    // The title follows the names until someone writes another one.
    const derived = !oldTitle || oldTitle === oldName || NEW_CONTACT_TITLES.includes(oldTitle) || (oldTitle === newTitle && NEW_CONTACT_TITLES.includes(newTitle));
    if (derived && newName) next[titleField] = newName;
  } else if (titleChanged && !namesChanged && !oldName && newTitle && !NEW_CONTACT_TITLES.includes(newTitle)) {
    // A name typed into the title of a contact without names fills them.
    const words = newTitle.split(/\s+/);
    if (words.length > 1) {
      next[F.lastName] = words.pop()!;
      next[F.firstName] = words.join(" ");
    } else next[F.lastName] = newTitle;
  } else if (!Object.keys(before).length && newName && (!newTitle || NEW_CONTACT_TITLES.includes(newTitle))) {
    next[titleField] = newName;
  }
  return next;
}

// Before a record of a contacts database is written: the derived title and
// names. Returns the cells unchanged for every other database.
export function contactCellsFor(pageId: string, fields: Field[], before: Cells, after: Cells, changed: string[]) {
  if (!isContactsDatabase(pageId)) return after;
  return deriveContactCells(fields, before, after, changed);
}
// After a record was written: a birthday repeats every year (the calendar
// shows it each year), without one there is no series.
export function afterContactWrite(pageId: string, rowId: string) {
  if (!isContactsDatabase(pageId)) return;
  syncBirthdaySeries(rowId);
}
const YEARLY = JSON.stringify({ freq: "yearly", interval: 1 });
export function syncBirthdaySeries(rowId: string) {
  const row = one<{ cells: string; recurrence: string | null }>("SELECT cells,recurrence FROM rows WHERE id=?", rowId);
  if (!row) return;
  const birthday = cellText(JSON.parse(row.cells)[F.birthday]);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(birthday.slice(0, 10)) ? YEARLY : "";
  // A series someone set up by hand stays.
  if (wanted && !row.recurrence) run("UPDATE rows SET recurrence=? WHERE id=?", wanted, rowId);
  else if (!wanted && row.recurrence === YEARLY) run("UPDATE rows SET recurrence='' WHERE id=?", rowId);
}

// Adds options a multiselect needs (imported categories, the missing tag).
export function ensureOptions(pageId: string, fieldId: string, values: string[]) {
  if (!values.length) return;
  const raw = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  if (!raw) return;
  const fields = JSON.parse(raw.fields) as Field[];
  const field = fields.find((f) => f.id === fieldId);
  if (!field || (field.type !== "multiselect" && field.type !== "select")) return;
  const options = field.options || [];
  const missing = [...new Set(values)].filter((v) => v && !options.includes(v));
  if (!missing.length) return;
  field.options = [...options, ...missing].slice(0, 500);
  run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(fields), pageId);
}

/* ---------- Records ↔ vCards ---------- */

export function contactToCells(contact: VCardContact, fields: Field[]): Cells {
  const has = new Set(fields.map((f) => f.id));
  const cells: Cells = {};
  const set = (key: string, value: unknown) => {
    if (has.has(key) && value !== "" && value !== undefined && !(Array.isArray(value) && !value.length)) cells[key] = value;
  };
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  set(fields[0]?.id || F.title, (contact.fn || name || contact.org || contact.emails[0]?.value || "").slice(0, 500));
  set(F.firstName, contact.firstName);
  set(F.lastName, contact.lastName);
  set(F.company, contact.org);
  set(F.position, contact.title);
  set(F.email, contact.emails[0]?.value);
  const mobile = contact.phones.find((p) => /cell|mobile|iphone/i.test(p.type));
  const phone = contact.phones.find((p) => p !== mobile);
  set(F.phone, phone?.value);
  set(F.mobile, mobile?.value);
  const address = contact.addresses.find((a) => /work/i.test(a.type)) || contact.addresses[0];
  if (address) {
    set(F.street, address.street);
    set(F.postalCode, address.postalCode);
    set(F.city, address.city);
    set(F.country, address.country);
  }
  // Without a year a date property has no value: the birthday is left out.
  if (/^\d{4}-\d{2}-\d{2}$/.test(contact.birthday)) set(F.birthday, contact.birthday);
  set(F.tags, contact.categories);
  return cells;
}
export function cellsToContact(rowId: string, cells: Cells, fields: Field[], note = ""): VCardContact {
  const c = emptyContact();
  const get = (key: string) => (fields.some((f) => f.id === key) ? text(cells, key) : "");
  c.uid = rowId;
  c.firstName = get(F.firstName);
  c.lastName = get(F.lastName);
  c.fn = text(cells, fields[0]?.id || F.title) || [c.firstName, c.lastName].filter(Boolean).join(" ");
  c.org = get(F.company);
  c.title = get(F.position);
  if (get(F.email)) c.emails.push({ value: get(F.email), type: "work" });
  if (get(F.phone)) c.phones.push({ value: get(F.phone), type: "work,voice" });
  if (get(F.mobile)) c.phones.push({ value: get(F.mobile), type: "cell" });
  if (get(F.street) || get(F.city) || get(F.postalCode) || get(F.country))
    c.addresses.push({ street: get(F.street), city: get(F.city), region: "", postalCode: get(F.postalCode), country: get(F.country), type: "work" });
  const birthday = get(F.birthday).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(birthday)) c.birthday = birthday;
  const tags = cells[F.tags];
  if (Array.isArray(tags) && fields.some((f) => f.id === F.tags)) c.categories = tags.map(String).filter((t) => !MISSING_TAGS.includes(t));
  c.note = note.slice(0, 20_000);
  return c;
}

// The free text of a record as plain text (the vCard note).
export function rowNoteText(html: string) {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// A vCard note as the record's free text.
export function noteHtml(note: string) {
  return note
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/* ---------- What the record pages need ---------- */

// Which records came from the directory and which of their properties it
// keeps (read-only here), for the record pages (lib/api.ts pageData).
export function contactsPageData(pageId: string) {
  if (!isContactsDatabase(pageId)) return undefined;
  const source = one<{ fields: string; last_sync_at: number | null; last_result: string | null; ous: string }>(
    "SELECT fields,last_sync_at,last_result,ous FROM contact_ldap_sources WHERE page_id=?",
    pageId,
  );
  const synced: Record<string, { missing: boolean }> = {};
  for (const link of all<{ row_id: string; missing_at: number | null }>("SELECT row_id,missing_at FROM contact_ldap_links WHERE page_id=?", pageId))
    synced[link.row_id] = { missing: !!link.missing_at };
  let fields: string[] = [];
  try {
    fields = source ? (JSON.parse(source.fields) as string[]) : [];
  } catch {}
  return { ldapFields: fields, synced, lastSync: source?.last_sync_at || null };
}
// Refuses changes to properties the directory keeps (records linked to an
// LDAP entry). The sync itself writes without this check.
export function assertContactWritable(pageId: string, rowId: string, before: Cells, after: Cells) {
  const link = one<{ row_id: string }>("SELECT row_id FROM contact_ldap_links WHERE row_id=? AND page_id=?", rowId, pageId);
  if (!link) return;
  const source = one<{ fields: string }>("SELECT fields FROM contact_ldap_sources WHERE page_id=?", pageId);
  let fields: string[] = [];
  try {
    fields = source ? (JSON.parse(source.fields) as string[]) : [];
  } catch {}
  for (const key of fields)
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
      throw new HttpError(409, "Diese Eigenschaft kommt aus dem LDAP-Verzeichnis und kann nur dort geändert werden.");
}
