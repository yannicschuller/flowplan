// Contacts from the LDAP directory (issue #64): import people of an
// organizational unit into a contacts database and keep them in step,
// one way – the directory is the source, Flowplan follows.
//
// - The server, the search account and TLS are those of the LDAP sign-in
//   (lib/ldap.ts: LDAP_URL, LDAP_BIND_DN/PASSWORD, LDAP_TLS_CA,
//   LDAP_STARTTLS, LDAP_TIMEOUT_MS). Contacts may use another base and
//   filter: LDAP_CONTACTS_BASE_DN / LDAP_CONTACTS_FILTER, or the values an
//   administrator sets in Administration → Anmeldung & SSO (stored values
//   win; the bind password is never stored, it stays in the environment).
//   LDAP_CONTACTS=off or the switch there turns the feature off.
// - Editors of a contacts database browse the OUs below the base (one level
//   at a time), see the people of an OU and import some of them, or the
//   whole OU including later arrivals ("ganze OU übernehmen").
// - The sync (every LDAP_CONTACTS_SYNC_MINUTES, default 60, and "Jetzt
//   abgleichen") writes the mapped properties: they are read-only in
//   Flowplan (lib/contacts.ts). The free text and every other property stay
//   editable. Entries that left the directory are tagged "Nicht mehr im
//   Verzeichnis" and kept; a run that would mark more than half of the
//   records (at least five) stops instead – more likely a wrong
//   configuration than a mass departure.
// - Records are matched by entryUUID / objectGUID / nsUniqueId, else by DN,
//   so renamed or moved entries keep their record.
// - Every search is bounded (entries, buffered bytes, operation timeout of
//   the client) and runs outside the database transaction.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, audit, id, one, run, transaction, onTransactionRollback } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { ct } from "./content-locale";
import { enforceQuota } from "./instance-ops";
import {
  LdapError,
  attr,
  escapeFilterValue,
  first,
  firstRdnValue,
  ldapServerConfig,
  parseLdapFilter,
  serviceBind,
  withConnection,
  type LdapConfig,
  type LdapConnection,
  type LdapEntry,
  type LdapFilter,
} from "./ldap";
import { CONTACT_FIELDS, MISSING_TAGS, ensureOptions, requireContactsDatabase, syncBirthdaySeries, type ContactKey } from "./contacts";
import type { Field, Identity } from "./types";

export const DEFAULT_PERSON_FILTER = "(&(|(objectClass=inetOrgPerson)(objectClass=user)(objectClass=contact))(!(objectClass=computer)))";
const OU_FILTER = "(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=organization)(objectClass=domain))";
// Contact property → directory attributes, the first one with a value wins.
export const DEFAULT_MAPPING: Partial<Record<ContactKey, string[]>> = {
  title: ["displayName", "cn"],
  firstName: ["givenName"],
  lastName: ["sn"],
  company: ["company", "o"],
  position: ["title"],
  email: ["mail"],
  phone: ["telephoneNumber"],
  mobile: ["mobile"],
  street: ["street", "streetAddress"],
  postalCode: ["postalCode"],
  city: ["l"],
  country: ["co", "c"],
  birthday: ["birthDate", "dateOfBirth"],
};
const UUID_ATTRIBUTES = ["entryUUID", "objectGUID", "nsUniqueId"];
const PHOTO_ATTRIBUTES = ["thumbnailPhoto", "jpegPhoto"];
const MAX_PHOTO = 256 * 1024;
const MAX_IMPORT = 500;
const MAX_OUS = 20;
const MAX_LINKS = 2000;

/* ---------- Settings ---------- */

const settingsSchema = z.object({
  enabled: z.boolean(),
  baseDn: z.string().trim().max(1000),
  filter: z.string().trim().max(2000),
  intervalMinutes: z.number().int().min(15).max(1440),
});
export type ContactsLdapSettings = z.infer<typeof settingsSchema>;
const SETTINGS_KEY = "contacts.ldap.settings";

function storedSettings(): Partial<ContactsLdapSettings> {
  const row = one<{ value: string }>("SELECT value FROM directory_status WHERE key=?", SETTINGS_KEY);
  try {
    const parsed = settingsSchema.partial().safeParse(row ? JSON.parse(row.value) : {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
// The effective settings and where each comes from.
export function contactsLdapSettings() {
  const stored = storedSettings();
  const envBase = process.env.LDAP_CONTACTS_BASE_DN?.trim() || "";
  const signInBase = process.env.LDAP_BASE_DN?.trim() || "";
  const baseDn = stored.baseDn || envBase || signInBase;
  const filter = stored.filter || process.env.LDAP_CONTACTS_FILTER?.trim() || DEFAULT_PERSON_FILTER;
  const envMinutes = Number(process.env.LDAP_CONTACTS_SYNC_MINUTES);
  return {
    server: !!process.env.LDAP_URL?.trim(),
    enabled: stored.enabled ?? process.env.LDAP_CONTACTS?.trim().toLowerCase() !== "off",
    baseDn,
    baseDnSource: stored.baseDn ? "admin" : envBase ? "env" : signInBase ? "sign-in" : "none",
    filter,
    filterSource: stored.filter ? "admin" : process.env.LDAP_CONTACTS_FILTER?.trim() ? "env" : "default",
    intervalMinutes: stored.intervalMinutes || (Number.isFinite(envMinutes) && envMinutes >= 15 ? Math.min(1440, Math.round(envMinutes)) : 60),
  };
}
export function contactsLdapConfig(): LdapConfig | null {
  const settings = contactsLdapSettings();
  if (!settings.enabled) return null;
  return ldapServerConfig(settings.baseDn);
}
export const contactsLdapAvailable = () => !!contactsLdapConfig();
function personFilter(): LdapFilter {
  try {
    return parseLdapFilter(contactsLdapSettings().filter);
  } catch {
    return parseLdapFilter(DEFAULT_PERSON_FILTER);
  }
}

// Administration: changes are recorded (audit → security event).
export function saveContactsLdapSettings(user: Identity, input: unknown) {
  if (!user.isAdmin) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  const next = settingsSchema.partial().parse(input);
  if (next.baseDn && !/^[^=,]+=[^=]/.test(next.baseDn)) throw new HttpError(400, "Bitte einen gültigen Basis-DN angeben.");
  if (next.filter)
    try {
      parseLdapFilter(next.filter);
    } catch {
      throw new HttpError(400, "Der LDAP-Filter ist ungültig.");
    }
  const merged = { ...storedSettings(), ...next };
  run(
    "INSERT INTO directory_status(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    SETTINGS_KEY,
    JSON.stringify(merged),
    Date.now(),
  );
  audit(user.id, "contacts.ldap.config", "", JSON.stringify(next).slice(0, 500));
  return contactsLdapStatus();
}
export function contactsLdapStatus() {
  const settings = contactsLdapSettings();
  const last = one<{ last_sync_at: number; last_result: string }>(
    "SELECT last_sync_at,last_result FROM contact_ldap_sources WHERE last_sync_at IS NOT NULL ORDER BY last_sync_at DESC LIMIT 1",
  );
  let lastResult: SyncResult | null = null;
  try {
    lastResult = last ? (JSON.parse(last.last_result) as SyncResult) : null;
  } catch {}
  return {
    ...settings,
    available: !!contactsLdapConfig(),
    databases: Number(one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_sources s JOIN pages p ON p.id=s.page_id WHERE p.deleted_at IS NULL")?.n || 0),
    records: Number(one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_links")?.n || 0),
    lastSync: lastResult,
  };
}
export type ContactsLdapStatus = ReturnType<typeof contactsLdapStatus>;

/* ---------- DNs ---------- */

// Compares DNs without case and spaces around separators.
export function normalizeDn(dn: string) {
  return dn
    .trim()
    .replace(/\s*([,=+])\s*/g, "$1")
    .toLowerCase();
}
export function withinBase(dn: string, base: string) {
  const d = normalizeDn(dn),
    b = normalizeDn(base);
  return !!b && (d === b || d.endsWith(`,${b}`));
}
const dnSchema = z.string().trim().min(3).max(1000);
function requireInBase(dn: string, config: LdapConfig) {
  if (!withinBase(dn, config.baseDn)) throw new HttpError(400, "Dieser Eintrag liegt außerhalb des Verzeichnisbereichs für Kontakte.");
  return dn.trim();
}

/* ---------- Directory entries → contact properties ---------- */

function uuidOf(entry: LdapEntry) {
  const entryUuid = first(entry, "entryUUID") || first(entry, "nsUniqueId");
  if (entryUuid) return entryUuid.toLowerCase();
  const guid = first(entry, "objectGUID");
  if (!guid) return "";
  const bytes = Buffer.from(guid, "base64");
  if (bytes.length !== 16) return "";
  // objectGUID is stored little-endian in the first three groups.
  const hex = (b: Buffer) => b.toString("hex");
  return `${hex(Buffer.from(bytes.subarray(0, 4)).reverse())}-${hex(Buffer.from(bytes.subarray(4, 6)).reverse())}-${hex(Buffer.from(bytes.subarray(6, 8)).reverse())}-${hex(bytes.subarray(8, 10))}-${hex(bytes.subarray(10, 16))}`;
}
// A filter that finds an entry by its UUID again (after a rename or move).
function uuidFilter(uuid: string): LdapFilter {
  const guid = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/.exec(uuid);
  const filters: LdapFilter[] = [
    { type: "equal", attr: "entryUUID", value: Buffer.from(uuid) },
    { type: "equal", attr: "nsUniqueId", value: Buffer.from(uuid) },
  ];
  if (guid) {
    const le = (h: string) => Buffer.from(h, "hex").reverse();
    filters.push({ type: "equal", attr: "objectGUID", value: Buffer.concat([le(guid[1]), le(guid[2]), le(guid[3]), Buffer.from(guid[4] + guid[5], "hex")]) });
  }
  return { type: "or", filters };
}
function dateOf(value: string) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}
function photoOf(entry: LdapEntry) {
  for (const name of PHOTO_ATTRIBUTES) {
    const value = first(entry, name);
    if (!value) continue;
    const bytes = Buffer.from(value, "base64");
    if (!bytes.length || bytes.length > MAX_PHOTO) continue;
    const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.subarray(0, 4).toString("hex") === "89504e47" ? "image/png" : "";
    if (mime) return { bytes, mime };
  }
  return null;
}
export type Mapping = Partial<Record<ContactKey, string[]>>;
const attributeName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
export const mappingSchema = z.record(z.enum(Object.keys(CONTACT_FIELDS) as [ContactKey, ...ContactKey[]]), z.array(attributeName).max(5));
function parseMapping(raw: string | null | undefined): Mapping {
  try {
    const parsed = mappingSchema.safeParse(JSON.parse(raw || "{}"));
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : DEFAULT_MAPPING;
  } catch {
    return DEFAULT_MAPPING;
  }
}
const mappedAttributes = (mapping: Mapping) => [...new Set(Object.values(mapping).flat())];
const searchAttributes = (mapping: Mapping) => [...mappedAttributes(mapping), "cn", "givenName", "sn", ...UUID_ATTRIBUTES, ...PHOTO_ATTRIBUTES];
const BINARY = ["objectGUID", ...PHOTO_ATTRIBUTES];

// The properties a directory entry sets (only those the database has).
export function entryCells(entry: LdapEntry, mapping: Mapping, fields: Field[]) {
  const has = new Set(fields.map((f) => f.id));
  const titleField = fields[0]?.id || CONTACT_FIELDS.title;
  const cells: Record<string, string> = {};
  for (const [key, names] of Object.entries(mapping) as [ContactKey, string[]][]) {
    const fieldId = key === "title" ? titleField : CONTACT_FIELDS[key];
    if (!has.has(fieldId)) continue;
    let value = "";
    for (const name of names) {
      value = attr(entry, name).find((v) => v.trim())?.trim() || "";
      if (value) break;
    }
    if (key === "birthday") value = dateOf(value);
    cells[fieldId] = value.slice(0, key === "street" ? 1000 : 500);
  }
  if (has.has(titleField) && !cells[titleField])
    cells[titleField] = [first(entry, "givenName"), first(entry, "sn")].filter(Boolean).join(" ") || first(entry, "cn") || firstRdnValue(entry.dn) || "";
  return cells;
}
// The properties the directory keeps for a database (read-only there).
export function syncedFieldIds(mapping: Mapping, fields: Field[]) {
  const has = new Set(fields.map((f) => f.id));
  const ids = Object.keys(mapping).map((key) => (key === "title" ? fields[0]?.id : CONTACT_FIELDS[key as ContactKey]));
  return [...new Set([fields[0]?.id, ...ids])].filter((x): x is string => !!x && has.has(x));
}

/* ---------- Browsing ---------- */

function directoryContext(user: Identity, pageId: string) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  const page = requirePage(user, pageId, true);
  requireContactsDatabase(page.id);
  const config = contactsLdapConfig();
  if (!config) throw new HttpError(409, "Für Kontakte ist kein LDAP-Verzeichnis eingerichtet.");
  return { page, config };
}
async function directory<T>(config: LdapConfig, fn: (conn: LdapConnection) => Promise<T>) {
  try {
    return await withConnection(config, async (conn) => {
      await serviceBind(conn, config);
      return fn(conn);
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("LDAP contacts", e instanceof Error ? e.message : e);
    throw new HttpError(503, "Der Verzeichnisdienst (LDAP) ist gerade nicht erreichbar.");
  }
}
const nameOf = (entry: LdapEntry) =>
  first(entry, "ou") || first(entry, "displayName") || first(entry, "cn") || first(entry, "o") || first(entry, "dc") || firstRdnValue(entry.dn) || entry.dn;

// The organizational units directly below a DN (the base when empty).
export async function browseUnits(user: Identity, pageId: string, parent?: string) {
  const { config } = directoryContext(user, pageId);
  const base = parent ? requireInBase(dnSchema.parse(parent), config) : config.baseDn;
  const units = await directory(config, (conn) =>
    conn.search({ base, scope: 1, filter: parseLdapFilter(OU_FILTER), attributes: ["ou", "cn", "o", "dc", "description"], sizeLimit: 500 }),
  );
  return {
    base: config.baseDn,
    parent: base,
    units: units
      .map((u) => ({ dn: u.dn, name: nameOf(u), description: first(u, "description").slice(0, 200) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  };
}
// The people of a unit (directly in it), or – with a search text – of the
// unit and everything below it.
export async function listPeople(user: Identity, pageId: string, unit?: string, query = "") {
  const { page, config } = directoryContext(user, pageId);
  const base = unit ? requireInBase(dnSchema.parse(unit), config) : config.baseDn;
  const q = z.string().trim().max(100).parse(query);
  const filter: LdapFilter = q
    ? {
        type: "and",
        filters: [
          personFilter(),
          parseLdapFilter(`(|${["cn", "displayName", "givenName", "sn", "mail"].map((a) => `(${a}=*${escapeFilterValue(q)}*)`).join("")})`),
        ],
      }
    : personFilter();
  const mapping = parseMapping(one<{ mapping: string }>("SELECT mapping FROM contact_ldap_sources WHERE page_id=?", page.id)?.mapping);
  const people = await directory(config, (conn) =>
    conn.search({
      base,
      scope: q ? 2 : 1,
      filter,
      attributes: ["cn", "displayName", "givenName", "sn", "mail", "title", "company", "o", ...UUID_ATTRIBUTES, ...mappedAttributes(mapping)],
      binary: ["objectGUID"],
      sizeLimit: 500,
    }),
  );
  const linked = new Set(all<{ dn: string }>("SELECT dn FROM contact_ldap_links WHERE page_id=?", page.id).map((l) => normalizeDn(l.dn)));
  const uuids = new Set(all<{ uuid: string }>("SELECT uuid FROM contact_ldap_links WHERE page_id=? AND uuid<>''", page.id).map((l) => l.uuid));
  const source = one<{ ous: string }>("SELECT ous FROM contact_ldap_sources WHERE page_id=?", page.id);
  const ous = parseOus(source?.ous);
  return {
    unit: base,
    subscribed: ous.some((ou) => normalizeDn(ou) === normalizeDn(base)),
    truncated: people.length >= 500,
    people: people
      .map((p) => ({
        dn: p.dn,
        name: first(p, "displayName") || first(p, "cn") || [first(p, "givenName"), first(p, "sn")].filter(Boolean).join(" ") || nameOf(p),
        email: first(p, "mail"),
        position: first(p, "title"),
        company: first(p, "company") || first(p, "o"),
        imported: linked.has(normalizeDn(p.dn)) || (!!uuidOf(p) && uuids.has(uuidOf(p))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  };
}
function parseOus(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_OUS) : [];
  } catch {
    return [];
  }
}

/* ---------- Import and sync ---------- */

export type SyncResult = { at: number; ok: boolean; created: number; updated: number; missing: number; back: number; error?: string };
const running = new Set<string>();

const importSchema = z.object({
  entries: z.array(dnSchema).max(MAX_IMPORT).default([]),
  units: z.array(dnSchema).max(MAX_OUS).default([]),
  mapping: mappingSchema.optional(),
});
// Imports chosen entries and subscribes whole units, then syncs at once.
export async function importContacts(user: Identity, pageId: string, input: unknown) {
  const { page, config } = directoryContext(user, pageId);
  const b = importSchema.parse(input);
  const entries = b.entries.map((dn) => requireInBase(dn, config));
  const units = b.units.map((dn) => requireInBase(dn, config));
  if (!entries.length && !units.length) throw new HttpError(400, "Bitte Einträge oder eine OU auswählen.");
  const now = Date.now();
  transaction(() => {
    const source = one<{ ous: string }>("SELECT ous FROM contact_ldap_sources WHERE page_id=?", page.id);
    const ous = parseOus(source?.ous);
    for (const unit of units) if (!ous.some((o) => normalizeDn(o) === normalizeDn(unit))) ous.push(unit);
    if (ous.length > MAX_OUS) throw new HttpError(400, "Höchstens 20 OUs je Datenbank.");
    if (!source)
      run(
        "INSERT INTO contact_ldap_sources(page_id,ous,mapping,created_by,created_at) VALUES(?,?,?,?,?)",
        page.id,
        JSON.stringify(ous),
        JSON.stringify(b.mapping || DEFAULT_MAPPING),
        user.id,
        now,
      );
    else {
      run("UPDATE contact_ldap_sources SET ous=? WHERE page_id=?", JSON.stringify(ous), page.id);
      if (b.mapping) run("UPDATE contact_ldap_sources SET mapping=? WHERE page_id=?", JSON.stringify(b.mapping), page.id);
    }
    audit(user.id, "contacts.ldap.import", page.id, JSON.stringify({ entries: entries.length, units }).slice(0, 1000));
  });
  return syncContactsSource(page.id, { extra: entries, actor: user.id, config });
}
// Stops following a unit (its records stay, as individual imports).
export function unsubscribeUnit(user: Identity, pageId: string, unit: string) {
  const { page } = directoryContext(user, pageId);
  const source = one<{ ous: string }>("SELECT ous FROM contact_ldap_sources WHERE page_id=?", page.id);
  const ous = parseOus(source?.ous).filter((o) => normalizeDn(o) !== normalizeDn(unit));
  run("UPDATE contact_ldap_sources SET ous=? WHERE page_id=?", JSON.stringify(ous), page.id);
  run("UPDATE contact_ldap_links SET ou='' WHERE page_id=? AND lower(ou)=lower(?)", page.id, unit);
  audit(user.id, "contacts.ldap.unsubscribe", page.id, unit.slice(0, 500));
  return contactsSourceStatus(page.id);
}
// "Jetzt abgleichen" in the database.
export async function syncContactsNow(user: Identity, pageId: string) {
  const { page, config } = directoryContext(user, pageId);
  if (!one("SELECT 1 FROM contact_ldap_sources WHERE page_id=?", page.id)) throw new HttpError(409, "Diese Datenbank hat noch keine Kontakte aus dem Verzeichnis.");
  return syncContactsSource(page.id, { actor: user.id, config });
}
export function contactsSourceStatus(pageId: string) {
  const source = one<{ ous: string; last_sync_at: number | null; last_result: string | null; mapping: string }>(
    "SELECT ous,last_sync_at,last_result,mapping FROM contact_ldap_sources WHERE page_id=?",
    pageId,
  );
  let last: SyncResult | null = null;
  try {
    last = source?.last_result ? (JSON.parse(source.last_result) as SyncResult) : null;
  } catch {}
  return {
    available: contactsLdapAvailable(),
    connected: !!source,
    units: parseOus(source?.ous),
    mapping: parseMapping(source?.mapping),
    defaultMapping: DEFAULT_MAPPING,
    records: Number(one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_links WHERE page_id=?", pageId)?.n || 0),
    missing: Number(one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_links WHERE page_id=? AND missing_at IS NOT NULL", pageId)?.n || 0),
    lastSync: last,
  };
}

type Link = { row_id: string; dn: string; uuid: string; ou: string; hash: string; photo_hash: string; missing_at: number | null };
type Found = { entry: LdapEntry; ou: string };

// One sync of a database: reads the subscribed units and every linked entry,
// then writes in one transaction.
export async function syncContactsSource(
  pageId: string,
  options: { extra?: string[]; actor?: string | null; config?: LdapConfig | null; now?: number } = {},
): Promise<SyncResult> {
  const now = options.now ?? Date.now();
  const result: SyncResult = { at: now, ok: true, created: 0, updated: 0, missing: 0, back: 0 };
  const config = options.config ?? contactsLdapConfig();
  const source = one<{ ous: string; mapping: string; created_by: string | null }>("SELECT ous,mapping,created_by FROM contact_ldap_sources WHERE page_id=?", pageId);
  const page = one<{ id: string; workspace_id: string; deleted_at: string | null }>("SELECT id,workspace_id,deleted_at FROM pages WHERE id=?", pageId);
  if (!source || !page || page.deleted_at) return { ...result, ok: false, error: "No LDAP source" };
  if (running.has(pageId)) throw new HttpError(409, "Der Abgleich läuft bereits.");
  running.add(pageId);
  try {
    if (!config) throw new LdapError("LDAP for contacts is not configured");
    const mapping = parseMapping(source.mapping);
    const units = parseOus(source.ous).filter((u) => withinBase(u, config.baseDn));
    const links = all<Link>("SELECT row_id,dn,uuid,ou,hash,photo_hash,missing_at FROM contact_ldap_links WHERE page_id=? LIMIT ?", pageId, MAX_LINKS);
    const attributes = searchAttributes(mapping);
    const filter = personFilter();
    const found = new Map<string, Found>(); // by normalized DN
    let unitOk = true;
    await directory(config, async (conn) => {
      const base = await conn.search({ base: config.baseDn, scope: 0, filter: { type: "present", attr: "objectClass" }, attributes: ["1.1"] });
      if (!base.length) throw new LdapError("Contacts base DN not found");
      for (const unit of units) {
        const people = await conn.search({ base: unit, scope: 2, filter, attributes, binary: BINARY, sizeLimit: MAX_LINKS });
        if (!people.length && !(await conn.search({ base: unit, scope: 0, filter: { type: "present", attr: "objectClass" }, attributes: ["1.1"] })).length) unitOk = false;
        for (const entry of people) if (!found.has(normalizeDn(entry.dn))) found.set(normalizeDn(entry.dn), { entry, ou: unit });
        if (found.size > MAX_LINKS) throw new LdapError("Too many entries");
      }
      // Entries imported one by one (and the ones to import now).
      const single = [...new Set([...links.filter((l) => !found.has(normalizeDn(l.dn))).map((l) => l.dn), ...(options.extra || [])])];
      for (const dn of single.slice(0, MAX_LINKS)) {
        if (found.has(normalizeDn(dn)) || !withinBase(dn, config.baseDn)) continue;
        const [entry] = await conn.search({ base: dn, scope: 0, filter, attributes, binary: BINARY, sizeLimit: 1 });
        if (entry) found.set(normalizeDn(entry.dn), { entry, ou: "" });
      }
      // Linked entries not found by DN: renamed or moved? Look them up by UUID.
      const byUuid = new Set([...found.values()].map((f) => uuidOf(f.entry)).filter(Boolean));
      let lookups = 0;
      for (const link of links) {
        if (!link.uuid || byUuid.has(link.uuid) || found.has(normalizeDn(link.dn)) || lookups++ >= 50) continue;
        const [entry] = await conn.search({ base: config.baseDn, scope: 2, filter: { type: "and", filters: [filter, uuidFilter(link.uuid)] }, attributes, binary: BINARY, sizeLimit: 1 });
        if (entry) found.set(normalizeDn(entry.dn), { entry, ou: "" });
      }
    });
    if (!unitOk) throw new LdapError("A subscribed organizational unit no longer exists");
    // Match links to entries: UUID first, then DN.
    const entriesByUuid = new Map<string, Found>();
    for (const f of found.values()) {
      const uuid = uuidOf(f.entry);
      if (uuid) entriesByUuid.set(uuid, f);
    }
    const used = new Set<Found>();
    const plan = links.map((link) => {
      const match = (link.uuid && entriesByUuid.get(link.uuid)) || found.get(normalizeDn(link.dn)) || null;
      if (match) used.add(match);
      return { link, match };
    });
    const vanished = plan.filter((p) => !p.match && !p.link.missing_at).length;
    if (vanished >= 5 && vanished * 2 > links.length) throw new LdapError(`Sync stopped: ${vanished} of ${links.length} contacts would be marked as gone`);
    const fresh = [...found.values()].filter((f) => !used.has(f));
    transaction(() => {
      const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];
      const synced = syncedFieldIds(mapping, fields);
      run("UPDATE contact_ldap_sources SET fields=? WHERE page_id=?", JSON.stringify(synced), pageId);
      const actor = options.actor ?? source.created_by;
      const author = actor && one("SELECT 1 FROM users WHERE id=?", actor) ? actor : null;
      const tags = fields.find((f) => f.id === CONTACT_FIELDS.tags && f.type === "multiselect");
      const missingTag = tags?.options?.find((o) => MISSING_TAGS.includes(o)) || ct("Nicht mehr im Verzeichnis", "No longer in directory");
      for (const { link, match } of plan) {
        const row = one<{ cells: string; icon: string | null }>("SELECT cells,icon FROM rows WHERE id=?", link.row_id);
        if (!row) continue;
        const cells = JSON.parse(row.cells) as Record<string, unknown>;
        if (!match) {
          if (link.missing_at) continue;
          run("UPDATE contact_ldap_links SET missing_at=?,synced_at=? WHERE row_id=?", now, now, link.row_id);
          if (tags) {
            ensureOptions(pageId, tags.id, [missingTag]);
            const list = Array.isArray(cells[tags.id]) ? (cells[tags.id] as string[]) : [];
            if (!list.includes(missingTag)) writeCells(link.row_id, { ...cells, [tags.id]: [...list, missingTag] }, author);
          }
          result.missing++;
          continue;
        }
        const values = entryCells(match.entry, mapping, fields);
        const hash = createHash("sha256").update(JSON.stringify(values)).digest("hex");
        let next: Record<string, unknown> = { ...cells };
        for (const [key, value] of Object.entries(values)) {
          if (value) next[key] = value;
          else delete next[key];
        }
        if (tags && Array.isArray(next[tags.id])) next[tags.id] = (next[tags.id] as string[]).filter((t) => !MISSING_TAGS.includes(t));
        if (link.missing_at) result.back++;
        if (JSON.stringify(next) !== JSON.stringify(cells)) {
          writeCells(link.row_id, next, author);
          result.updated++;
        } else next = cells;
        const photoHash = storePhoto(page, link.row_id, match.entry, link.photo_hash, row.icon, author);
        run(
          "UPDATE contact_ldap_links SET dn=?,uuid=?,ou=?,hash=?,photo_hash=?,missing_at=NULL,synced_at=? WHERE row_id=?",
          match.entry.dn,
          uuidOf(match.entry),
          match.ou,
          hash,
          photoHash,
          now,
          link.row_id,
        );
        syncBirthdaySeries(link.row_id);
      }
      let position = Date.now();
      for (const f of fresh) {
        const values = entryCells(f.entry, mapping, fields);
        const rid = id();
        run(
          "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
          rid,
          pageId,
          JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, v]) => v))),
          position++,
          author,
          author,
        );
        const photoHash = storePhoto(page, rid, f.entry, "", "", author);
        run(
          "INSERT INTO contact_ldap_links(row_id,page_id,dn,uuid,ou,hash,photo_hash,synced_at) VALUES(?,?,?,?,?,?,?,?)",
          rid,
          pageId,
          f.entry.dn,
          uuidOf(f.entry),
          f.ou,
          createHash("sha256").update(JSON.stringify(values)).digest("hex"),
          photoHash,
          now,
        );
        syncBirthdaySeries(rid);
        result.created++;
      }
      if (result.created || result.updated || result.missing) run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
    });
  } catch (e) {
    result.ok = false;
    result.error = e instanceof HttpError || e instanceof LdapError ? e.message : e instanceof Error ? e.message : "LDAP error";
    if (!(e instanceof HttpError || e instanceof LdapError)) console.error("LDAP contacts sync", e);
  } finally {
    running.delete(pageId);
  }
  run("UPDATE contact_ldap_sources SET last_sync_at=?,last_result=? WHERE page_id=?", now, JSON.stringify(result), pageId);
  return result;
}
function writeCells(rowId: string, cells: Record<string, unknown>, author: string | null) {
  run("UPDATE rows SET cells=?,updated_at=CURRENT_TIMESTAMP,updated_by=?,version=version+1 WHERE id=?", JSON.stringify(cells), author, rowId);
}
// The directory's photo as the record's symbol – only when it changed and
// the symbol is empty or the previous photo.
function storePhoto(page: { id: string; workspace_id: string }, rowId: string, entry: LdapEntry, previousHash: string, icon: string | null, author: string | null) {
  const photo = photoOf(entry);
  const hash = photo ? createHash("sha256").update(photo.bytes).digest("hex").slice(0, 32) : "";
  if (hash === previousHash) return hash;
  const previous = /^\/api\/files\/([\w-]+)$/.exec(icon || "")?.[1];
  if (icon && !previous) return hash;
  if (previous && previousHash) {
    run("DELETE FROM files WHERE id=? AND page_id=?", previous, page.id);
    run("INSERT OR IGNORE INTO pending_file_deletions(id) VALUES(?)", previous);
  }
  if (!photo) {
    if (previous && previousHash) run("UPDATE rows SET icon='' WHERE id=?", rowId);
    return "";
  }
  return storeContactPhoto(page, rowId, photo.bytes, photo.mime, author) ? hash : "";
}
// Stores a photo (JPEG/PNG, small) as a file of the database and makes it
// the record's symbol. False when the quota is used up.
export function storeContactPhoto(page: { id: string; workspace_id: string }, rowId: string, bytes: Buffer, mime: string, author: string | null) {
  try {
    enforceQuota(page.workspace_id, bytes.length);
  } catch {
    return false;
  }
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  const fid = id();
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fid), bytes);
  onTransactionRollback(() => {
    try {
      unlinkSync(resolve(dir, fid));
    } catch {}
  });
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page.id,
    mime === "image/png" ? "foto.png" : "foto.jpg",
    mime,
    bytes.length,
    author,
  );
  run("UPDATE rows SET icon=? WHERE id=?", `/api/files/${fid}`, rowId);
  return true;
}

/* ---------- Worker ---------- */

export async function syncAllContactSources(now = Date.now()) {
  const config = contactsLdapConfig();
  if (!config) return [];
  const results: SyncResult[] = [];
  for (const source of all<{ page_id: string }>(
    "SELECT s.page_id FROM contact_ldap_sources s JOIN pages p ON p.id=s.page_id WHERE p.deleted_at IS NULL ORDER BY s.last_sync_at IS NOT NULL,s.last_sync_at LIMIT 200",
  )) {
    if (running.has(source.page_id)) continue;
    results.push(await syncContactsSource(source.page_id, { config, now }));
  }
  return results;
}
const runtime = globalThis as unknown as { flowplanContactsLdapTimer?: ReturnType<typeof setInterval> };
export function startContactsSyncWorker() {
  if (runtime.flowplanContactsLdapTimer || !process.env.LDAP_URL?.trim()) return;
  const tick = () => void syncAllContactSources().catch((error) => console.error("LDAP contacts sync failed", error instanceof Error ? error.message : error));
  // Checked every 15 minutes; each run waits for the configured interval.
  let last = 0;
  const due = () => {
    const minutes = contactsLdapSettings().intervalMinutes;
    if (Date.now() - last < minutes * 60_000 - 30_000) return;
    last = Date.now();
    tick();
  };
  setTimeout(due, 90_000).unref?.();
  runtime.flowplanContactsLdapTimer = setInterval(due, 15 * 60_000);
  runtime.flowplanContactsLdapTimer.unref?.();
}
