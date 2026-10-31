// Contacts from the LDAP directory (lib/contacts-ldap.ts) against an
// in-process fake directory (tests/helpers/fake-ldap.ts): browsing units,
// importing, the one-way sync, read-only synced properties, entries that
// left the directory, renames, limits and timeouts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { startFakeLdap, type FakeEntry } from "./helpers/fake-ldap";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-contacts-ldap-"));
const BASE = "dc=example,dc=org";
const PEOPLE = `ou=people,${BASE}`;
const SERVICE = `cn=flowplan,ou=services,${BASE}`;
const entries = new Map<string, FakeEntry>();
const ou = (dn: string, name: string) => entries.set(dn, { attrs: { objectClass: ["top", "organizationalUnit"], ou: [name] } });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const guid = Buffer.from("00112233445566778899aabbccddeeff", "hex");
let serial = 0;
function person(dn: string, given: string, sn: string, extra: Record<string, (string | Buffer)[]> = {}) {
  entries.set(dn, {
    attrs: {
      objectClass: ["top", "person", "organizationalPerson", "inetOrgPerson"],
      cn: [`${given} ${sn}`],
      givenName: [given],
      sn: [sn],
      mail: [`${given.toLowerCase()}@example.org`],
      entryUUID: [`0000000${serial++}-aaaa-bbbb-cccc-000000000000`],
      ...extra,
    },
  });
}
entries.set(BASE, { attrs: { objectClass: ["domain"], dc: ["example"] } });
entries.set(SERVICE, { password: "service-pw", attrs: { objectClass: ["person"], cn: ["flowplan"] } });
ou(PEOPLE, "people");
ou(`ou=sales,${PEOPLE}`, "Sales");
ou(`ou=dev,${PEOPLE}`, "Development");
ou(`ou=big,${PEOPLE}`, "Big");
person(`uid=alice,ou=sales,${PEOPLE}`, "Alice", "Adler", { title: ["Vertrieb"], o: ["Example AG"], telephoneNumber: ["+49 30 1"], l: ["Berlin"], birthDate: ["1985-03-14"], jpegPhoto: [jpeg] });
person(`uid=bob,ou=sales,${PEOPLE}`, "Bob", "Brandt", { objectClass: ["top", "user"], entryUUID: [], objectGUID: [guid], displayName: ["Bob B. Brandt"] });
person(`uid=carol,ou=dev,${PEOPLE}`, "Carol", "Clausen");
person(`uid=dave,${PEOPLE}`, "Dave", "Dorn", { mobile: ["+49 171 4"], street: ["Weg 1"], postalCode: ["10115"], c: ["DE"] });
entries.set(`cn=pc01,ou=dev,${PEOPLE}`, { attrs: { objectClass: ["top", "user", "computer"], cn: ["pc01"] } });
for (let i = 0; i < 505; i++) person(`uid=p${i},ou=big,${PEOPLE}`, `P${i}`, "Big");
const fake = await startFakeLdap(entries);
after(() => fake.close());
process.env.LDAP_URL = fake.url;
process.env.LDAP_BIND_DN = SERVICE;
process.env.LDAP_BIND_PASSWORD = "service-pw";
process.env.LDAP_CONTACTS_BASE_DN = PEOPLE;
process.env.LDAP_TIMEOUT_MS = "5000";

const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap, pageData, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const ldapContacts = await import("../lib/contacts-ldap");
const { browseUnits, listPeople, importContacts, syncContactsNow, syncContactsSource, saveContactsLdapSettings, contactsLdapStatus, contactsSourceStatus, unsubscribeUnit } = ldapContacts;

function user(name: string, isAdmin = false): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  viewer = user("viewer"),
  admin = user("admin", true);
const wid = createWorkspace(owner.id, "Team"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, who = owner): any => command(who, { workspaceId: wid, ...body });
const pageId = act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "contacts", title: "Adressbuch" }).id as string;
const rowOf = (dn: string) => one<{ row_id: string }>("SELECT row_id FROM contact_ldap_links WHERE lower(dn)=lower(?)", dn)?.row_id;
const cellsOf = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const versionOf = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;

test("browsing: the units one level below the base, nothing outside it, only for editors of contacts databases", async () => {
  const root = await browseUnits(owner, pageId);
  assert.equal(root.base, PEOPLE);
  assert.deepEqual(root.units.map((u) => u.name), ["Big", "Development", "Sales"]);
  assert.ok(fake.searches.some((s) => s.base === PEOPLE && s.scope === 1));
  const below = await browseUnits(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.deepEqual(below.units, []);
  await assert.rejects(browseUnits(owner, pageId, `ou=services,${BASE}`), /außerhalb/);
  await assert.rejects(browseUnits(viewer, pageId), /Berechtigung/);
  const tasks = act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", title: "Aufgaben" }).id;
  await assert.rejects(browseUnits(owner, tasks), /keine Kontakte/);
});

test("people of a unit: persons only, search below the unit, result size bounded", async () => {
  const sales = await listPeople(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.deepEqual(sales.people.map((p) => p.name), ["Alice Adler", "Bob B. Brandt"]);
  assert.equal(sales.people[0].email, "alice@example.org");
  const dev = await listPeople(owner, pageId, `ou=dev,${PEOPLE}`);
  assert.deepEqual(dev.people.map((p) => p.name), ["Carol Clausen"], "computers are no contacts");
  const found = await listPeople(owner, pageId, undefined, "carol");
  assert.deepEqual(found.people.map((p) => p.name), ["Carol Clausen"]);
  // An injection attempt stays a value.
  const odd = await listPeople(owner, pageId, undefined, "*)(objectClass=*");
  assert.equal(odd.people.length, 0);
  const big = await listPeople(owner, pageId, `ou=big,${PEOPLE}`);
  assert.equal(big.people.length, 500);
  assert.equal(big.truncated, true);
});

test("import: chosen entries and a whole unit become contacts with directory values and photo", async () => {
  const result = await importContacts(owner, pageId, { entries: [`uid=dave,${PEOPLE}`], units: [`ou=sales,${PEOPLE}`] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.created, 3);
  const alice = cellsOf(rowOf(`uid=alice,ou=sales,${PEOPLE}`)!);
  assert.equal(alice.title, "Alice Adler");
  assert.equal(alice.firstName, "Alice");
  assert.equal(alice.lastName, "Adler");
  assert.equal(alice.company, "Example AG");
  assert.equal(alice.position, "Vertrieb");
  assert.equal(alice.phone, "+49 30 1");
  assert.equal(alice.city, "Berlin");
  assert.equal(alice.birthday, "1985-03-14");
  const aliceRow = one<{ icon: string; recurrence: string }>("SELECT icon,recurrence FROM rows WHERE id=?", rowOf(`uid=alice,ou=sales,${PEOPLE}`)!)!;
  assert.match(aliceRow.icon, /^\/api\/files\//);
  assert.equal(JSON.parse(aliceRow.recurrence).freq, "yearly");
  const dave = cellsOf(rowOf(`uid=dave,${PEOPLE}`)!);
  assert.deepEqual([dave.mobile, dave.street, dave.postalCode, dave.country], ["+49 171 4", "Weg 1", "10115", "DE"]);
  const bob = one<{ uuid: string; ou: string }>("SELECT uuid,ou FROM contact_ldap_links WHERE row_id=?", rowOf(`uid=bob,ou=sales,${PEOPLE}`)!)!;
  assert.equal(bob.uuid, "33221100-5544-7766-8899-aabbccddeeff", "objectGUID in its usual text form");
  assert.equal(bob.ou, `ou=sales,${PEOPLE}`);
  assert.equal(cellsOf(rowOf(`uid=bob,ou=sales,${PEOPLE}`)!).title, "Bob B. Brandt");
  const status = contactsSourceStatus(pageId);
  assert.deepEqual(status.units, [`ou=sales,${PEOPLE}`]);
  assert.equal(status.records, 3);
  assert.ok(one("SELECT 1 FROM audit WHERE action='contacts.ldap.import' AND resource_id=?", pageId));
  // Already imported people are marked in the list.
  const sales = await listPeople(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.ok(sales.people.every((p) => p.imported));
  assert.equal(sales.subscribed, true);
  await assert.rejects(importContacts(owner, pageId, { entries: [`uid=x,ou=services,${BASE}`] }), /außerhalb/);
  await assert.rejects(importContacts(viewer, pageId, { entries: [`uid=carol,ou=dev,${PEOPLE}`] }), /Berechtigung/);
});

test("synced properties are read-only, notes, tags and other properties stay editable", () => {
  const rid = rowOf(`uid=alice,ou=sales,${PEOPLE}`)!;
  assert.throws(() => act({ action: "row.update", pageId, rowId: rid, version: versionOf(rid), cells: { company: "Other" } }), /LDAP-Verzeichnis/);
  assert.throws(() => act({ action: "row.update", pageId, rowId: rid, version: versionOf(rid), cells: { title: "Other" } }), /LDAP-Verzeichnis/);
  const db = database(pageId);
  act({
    action: "database.update",
    pageId,
    version: db.version,
    views: db.views,
    fields: [...db.fields.map((f) => (f.id === "tags" ? { ...f, options: ["VIP"] } : f)), { id: "note", name: "Notiz", type: "text" }],
  });
  act({ action: "row.update", pageId, rowId: rid, version: versionOf(rid), cells: { tags: ["VIP"], note: "kennt uns" } });
  assert.deepEqual(cellsOf(rid).tags, ["VIP"]);
  // Bulk edits obey the same rule.
  assert.throws(() => act({ action: "rows.bulk", pageId, operation: "update", rows: [{ id: rid, version: versionOf(rid) }], cells: { city: "Hamburg" } }), /LDAP-Verzeichnis/);
  const data = pageData(owner, pageId) as { contacts: { ldapFields: string[]; synced: Record<string, { missing: boolean }> } };
  assert.ok(data.contacts.ldapFields.includes("company"));
  assert.ok(data.contacts.ldapFields.includes("title"));
  assert.ok(!data.contacts.ldapFields.includes("tags"));
  assert.equal(data.contacts.synced[rid].missing, false);
});

test("sync: changed values, new people of a unit, renamed entries keep their record", async () => {
  const alice = rowOf(`uid=alice,ou=sales,${PEOPLE}`)!;
  const bob = rowOf(`uid=bob,ou=sales,${PEOPLE}`)!;
  entries.get(`uid=alice,ou=sales,${PEOPLE}`)!.attrs.title = ["Vertriebsleitung"];
  person(`uid=erin,ou=sales,${PEOPLE}`, "Erin", "Eck");
  // Bob moves to development: found again by his objectGUID.
  const bobEntry = entries.get(`uid=bob,ou=sales,${PEOPLE}`)!;
  entries.delete(`uid=bob,ou=sales,${PEOPLE}`);
  entries.set(`uid=bob,ou=dev,${PEOPLE}`, bobEntry);
  const result = await syncContactsNow(owner, pageId);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.created, 1);
  assert.equal(result.missing, 0);
  assert.equal(cellsOf(alice).position, "Vertriebsleitung");
  assert.deepEqual(cellsOf(alice).tags, ["VIP"], "Flowplan-only values stay");
  assert.ok(rowOf(`uid=erin,ou=sales,${PEOPLE}`));
  assert.equal(rowOf(`uid=bob,ou=dev,${PEOPLE}`), bob);
  // Nothing changed: no new versions.
  const before = versionOf(alice);
  assert.equal((await syncContactsNow(owner, pageId)).updated, 0);
  assert.equal(versionOf(alice), before);
});

test("entries that left the directory are tagged, not deleted, and come back", async () => {
  const carol = (await importContacts(owner, pageId, { entries: [`uid=carol,ou=dev,${PEOPLE}`] })).created;
  assert.equal(carol, 1);
  const rid = rowOf(`uid=carol,ou=dev,${PEOPLE}`)!;
  const entry = entries.get(`uid=carol,ou=dev,${PEOPLE}`)!;
  entries.delete(`uid=carol,ou=dev,${PEOPLE}`);
  const gone = await syncContactsSource(pageId, {});
  assert.equal(gone.ok, true, gone.error);
  assert.equal(gone.missing, 1);
  assert.ok(one("SELECT 1 FROM rows WHERE id=?", rid), "the record stays");
  assert.deepEqual(cellsOf(rid).tags, ["Nicht mehr im Verzeichnis"]);
  assert.ok(one<{ missing_at: number }>("SELECT missing_at FROM contact_ldap_links WHERE row_id=?", rid)!.missing_at);
  entries.set(`uid=carol,ou=dev,${PEOPLE}`, entry);
  const back = await syncContactsSource(pageId, {});
  assert.equal(back.back, 1);
  assert.deepEqual(cellsOf(rid).tags, []);
});

test("a sync that would mark most contacts as gone stops instead; a vanished unit too", async () => {
  // The big unit: 505 contacts, then all of them vanish at once.
  const imported = await importContacts(owner, pageId, { units: [`ou=big,${PEOPLE}`] });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.created, 505);
  const saved = new Map([...entries].filter(([dn]) => dn.endsWith(`ou=big,${PEOPLE}`) && dn.startsWith("uid=")));
  for (const dn of saved.keys()) entries.delete(dn);
  const stopped = await syncContactsSource(pageId, {});
  assert.equal(stopped.ok, false);
  assert.match(stopped.error!, /Sync stopped/);
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_links WHERE page_id=? AND missing_at IS NOT NULL", pageId)!.n), 0);
  for (const [dn, e] of saved) entries.set(dn, e);
  const unit = entries.get(`ou=dev,${PEOPLE}`)!;
  entries.delete(`ou=dev,${PEOPLE}`);
  run("UPDATE contact_ldap_sources SET ous=? WHERE page_id=?", JSON.stringify([`ou=sales,${PEOPLE}`, `ou=big,${PEOPLE}`, `ou=dev,${PEOPLE}`]), pageId);
  const vanished = await syncContactsSource(pageId, {});
  assert.equal(vanished.ok, false);
  entries.set(`ou=dev,${PEOPLE}`, unit);
  unsubscribeUnit(owner, pageId, `ou=dev,${PEOPLE}`);
  unsubscribeUnit(owner, pageId, `ou=big,${PEOPLE}`);
  assert.deepEqual(contactsSourceStatus(pageId).units, [`ou=sales,${PEOPLE}`]);
});

test("a directory that does not answer in time leaves everything as it was", async () => {
  process.env.LDAP_TIMEOUT_MS = "1000";
  fake.delayMs = 1500;
  try {
    const versions = all<{ id: string; version: number }>("SELECT id,version FROM rows WHERE page_id=?", pageId);
    const result = await syncContactsSource(pageId, {});
    assert.equal(result.ok, false);
    assert.deepEqual(all<{ id: string; version: number }>("SELECT id,version FROM rows WHERE page_id=?", pageId), versions);
    await assert.rejects(browseUnits(owner, pageId), /nicht erreichbar/);
    assert.equal(contactsSourceStatus(pageId).lastSync!.ok, false);
  } finally {
    fake.delayMs = 0;
    process.env.LDAP_TIMEOUT_MS = "5000";
  }
});

test("administration: base DN and filter, recorded as security events; switched off means no access", async () => {
  assert.throws(() => saveContactsLdapSettings(owner, { filter: "(objectClass=person)" }), /Administrator/);
  assert.throws(() => saveContactsLdapSettings(admin, { filter: "(objectClass=person" }), /Filter/);
  assert.throws(() => saveContactsLdapSettings(admin, { baseDn: "nonsense" }), /Basis-DN/);
  const status = saveContactsLdapSettings(admin, { filter: "(objectClass=inetOrgPerson)", intervalMinutes: 30 });
  assert.equal(status.filter, "(objectClass=inetOrgPerson)");
  assert.equal(status.filterSource, "admin");
  assert.equal(status.intervalMinutes, 30);
  assert.equal(status.baseDn, PEOPLE);
  assert.equal(status.baseDnSource, "env");
  assert.ok(status.available);
  assert.ok(one("SELECT 1 FROM audit WHERE action='contacts.ldap.config' AND actor_id=?", admin.id));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(one("SELECT 1 FROM security_events WHERE kind='admin.settings' AND detail LIKE 'contacts.ldap.config%'"));
  // The bind password is never stored.
  assert.ok(!all<{ value: string }>("SELECT value FROM directory_status").some((r) => r.value.includes("service-pw")));
  // The stricter filter leaves Bob (objectClass user) out of the list.
  const sales = await listPeople(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.ok(!sales.people.some((p) => p.name.startsWith("Bob")));
  saveContactsLdapSettings(admin, { enabled: false });
  assert.equal(contactsLdapStatus().available, false);
  await assert.rejects(browseUnits(owner, pageId), /kein LDAP-Verzeichnis/);
  saveContactsLdapSettings(admin, { enabled: true, filter: "" });
});
