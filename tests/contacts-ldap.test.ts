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
person(`uid=carol,ou=dev,${PEOPLE}`, "Carol", "Clausen", { homePhone: ["+49 30 999 privat"], employeeNumber: ["E-4711"] });
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

async function user(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  admin = await user("admin", true);
// The owner signs in with LDAP: only people of the organisation reach the
// directory (directoryAccess); the last tests cover everybody else.
const ldapAccount = async (who: Identity) =>
  await run("INSERT INTO ldap_accounts(user_id,dn,username,created_at) VALUES(?,?,?,?)", who.id, `uid=${who.name},${PEOPLE}`, who.name, Date.now());
await ldapAccount(owner);
const wid = await createWorkspace(owner.id, "Team"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, { workspaceId: wid, ...body });
const pageId = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "contacts", title: "Adressbuch" })).id as string;
const rowOf = async (dn: string) => (await one<{ row_id: string }>("SELECT row_id FROM contact_ldap_links WHERE lower(dn)=lower(?)", dn))?.row_id;
const cellsOf = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const versionOf = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;

test("browsing: the units one level below the base, nothing outside it, only for editors of contacts databases", async () => {
  const root = await browseUnits(owner, pageId);
  assert.equal(root.base, PEOPLE);
  assert.deepEqual(root.units.map((u) => u.name), ["Big", "Development", "Sales"]);
  assert.ok(fake.searches.some((s) => s.base === PEOPLE && s.scope === 1));
  const below = await browseUnits(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.deepEqual(below.units, []);
  await assert.rejects(browseUnits(owner, pageId, `ou=services,${BASE}`), /außerhalb/);
  await assert.rejects(browseUnits(viewer, pageId), /Berechtigung/);
  const tasks = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", title: "Aufgaben" })).id;
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
  assert.equal(result.ok, true, result.error || "");
  assert.equal(result.created, 3);
  const alice = await cellsOf((await rowOf(`uid=alice,ou=sales,${PEOPLE}`))!);
  assert.equal(alice.title, "Alice Adler");
  assert.equal(alice.firstName, "Alice");
  assert.equal(alice.lastName, "Adler");
  assert.equal(alice.company, "Example AG");
  assert.equal(alice.position, "Vertrieb");
  assert.equal(alice.phone, "+49 30 1");
  assert.equal(alice.city, "Berlin");
  assert.equal(alice.birthday, "1985-03-14");
  const aliceRow = (await one<{ icon: string; recurrence: string }>("SELECT icon,recurrence FROM rows WHERE id=?", (await rowOf(`uid=alice,ou=sales,${PEOPLE}`))!))!;
  assert.match(aliceRow.icon, /^\/api\/files\//);
  assert.equal(JSON.parse(aliceRow.recurrence).freq, "yearly");
  const dave = await cellsOf((await rowOf(`uid=dave,${PEOPLE}`))!);
  assert.deepEqual([dave.mobile, dave.street, dave.postalCode, dave.country], ["+49 171 4", "Weg 1", "10115", "DE"]);
  const bob = (await one<{ uuid: string; ou: string }>("SELECT uuid,ou FROM contact_ldap_links WHERE row_id=?", (await rowOf(`uid=bob,ou=sales,${PEOPLE}`))!))!;
  assert.equal(bob.uuid, "33221100-5544-7766-8899-aabbccddeeff", "objectGUID in its usual text form");
  assert.equal(bob.ou, `ou=sales,${PEOPLE}`);
  assert.equal((await cellsOf((await rowOf(`uid=bob,ou=sales,${PEOPLE}`))!)).title, "Bob B. Brandt");
  const status = await contactsSourceStatus(pageId);
  assert.deepEqual(status.units, [`ou=sales,${PEOPLE}`]);
  assert.equal(status.records, 3);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='contacts.ldap.import' AND resource_id=?", pageId));
  // Already imported people are marked in the list.
  const sales = await listPeople(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.ok(sales.people.every((p) => p.imported));
  assert.equal(sales.subscribed, true);
  await assert.rejects(importContacts(owner, pageId, { entries: [`uid=x,ou=services,${BASE}`] }), /außerhalb/);
  await assert.rejects(importContacts(viewer, pageId, { entries: [`uid=carol,ou=dev,${PEOPLE}`] }), /Berechtigung/);
});

test("synced properties are read-only, notes, tags and other properties stay editable", async () => {
  const rid = (await rowOf(`uid=alice,ou=sales,${PEOPLE}`))!;
  await assert.rejects(async () => await act({ action: "row.update", pageId, rowId: rid, version: await versionOf(rid), cells: { company: "Other" } }), /LDAP-Verzeichnis/);
  await assert.rejects(async () => await act({ action: "row.update", pageId, rowId: rid, version: await versionOf(rid), cells: { title: "Other" } }), /LDAP-Verzeichnis/);
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    views: db.views,
    fields: [...db.fields.map((f) => (f.id === "tags" ? { ...f, options: ["VIP"] } : f)), { id: "note", name: "Notiz", type: "text" }],
  });
  await act({ action: "row.update", pageId, rowId: rid, version: await versionOf(rid), cells: { tags: ["VIP"], note: "kennt uns" } });
  assert.deepEqual((await cellsOf(rid)).tags, ["VIP"]);
  // Bulk edits obey the same rule.
  await assert.rejects(async () => await act({ action: "rows.bulk", pageId, operation: "update", rows: [{ id: rid, version: await versionOf(rid) }], cells: { city: "Hamburg" } }), /LDAP-Verzeichnis/);
  const data = (await pageData(owner, pageId)) as { contacts: { ldapFields: string[]; synced: Record<string, { missing: boolean }> } };
  assert.ok(data.contacts.ldapFields.includes("company"));
  assert.ok(data.contacts.ldapFields.includes("title"));
  assert.ok(!data.contacts.ldapFields.includes("tags"));
  assert.equal(data.contacts.synced[rid].missing, false);
});

test("sync: changed values, new people of a unit, renamed entries keep their record", async () => {
  const alice = (await rowOf(`uid=alice,ou=sales,${PEOPLE}`))!;
  const bob = (await rowOf(`uid=bob,ou=sales,${PEOPLE}`))!;
  entries.get(`uid=alice,ou=sales,${PEOPLE}`)!.attrs.title = ["Vertriebsleitung"];
  person(`uid=erin,ou=sales,${PEOPLE}`, "Erin", "Eck");
  // Bob moves to development: found again by his objectGUID.
  const bobEntry = entries.get(`uid=bob,ou=sales,${PEOPLE}`)!;
  entries.delete(`uid=bob,ou=sales,${PEOPLE}`);
  entries.set(`uid=bob,ou=dev,${PEOPLE}`, bobEntry);
  const result = await syncContactsNow(owner, pageId);
  assert.equal(result.ok, true, result.error || "");
  assert.equal(result.created, 1);
  assert.equal(result.missing, 0);
  assert.equal((await cellsOf(alice)).position, "Vertriebsleitung");
  assert.deepEqual((await cellsOf(alice)).tags, ["VIP"], "Flowplan-only values stay");
  assert.ok(await rowOf(`uid=erin,ou=sales,${PEOPLE}`));
  assert.equal(await rowOf(`uid=bob,ou=dev,${PEOPLE}`), bob);
  // Nothing changed: no new versions.
  const before = await versionOf(alice);
  assert.equal((await syncContactsNow(owner, pageId)).updated, 0);
  assert.equal(await versionOf(alice), before);
});

test("entries that left the directory are tagged, not deleted, and come back", async () => {
  const carol = (await importContacts(owner, pageId, { entries: [`uid=carol,ou=dev,${PEOPLE}`] })).created;
  assert.equal(carol, 1);
  const rid = (await rowOf(`uid=carol,ou=dev,${PEOPLE}`))!;
  const entry = entries.get(`uid=carol,ou=dev,${PEOPLE}`)!;
  entries.delete(`uid=carol,ou=dev,${PEOPLE}`);
  const gone = await syncContactsSource(pageId, {});
  assert.equal(gone.ok, true, gone.error || "");
  assert.equal(gone.missing, 1);
  assert.ok(await one("SELECT 1 FROM rows WHERE id=?", rid), "the record stays");
  assert.deepEqual((await cellsOf(rid)).tags, ["Nicht mehr im Verzeichnis"]);
  assert.ok((await one<{ missing_at: number }>("SELECT missing_at FROM contact_ldap_links WHERE row_id=?", rid))!.missing_at);
  entries.set(`uid=carol,ou=dev,${PEOPLE}`, entry);
  const back = await syncContactsSource(pageId, {});
  assert.equal(back.back, 1);
  assert.deepEqual((await cellsOf(rid)).tags, []);
});

test("a sync that would mark most contacts as gone stops instead; a vanished unit too", async () => {
  // The big unit: 505 contacts, then all of them vanish at once.
  const imported = await importContacts(owner, pageId, { units: [`ou=big,${PEOPLE}`] });
  assert.equal(imported.ok, true, imported.error || "");
  assert.equal(imported.created, 505);
  const saved = new Map([...entries].filter(([dn]) => dn.endsWith(`ou=big,${PEOPLE}`) && dn.startsWith("uid=")));
  for (const dn of saved.keys()) entries.delete(dn);
  const stopped = await syncContactsSource(pageId, {});
  assert.equal(stopped.ok, false);
  assert.match(stopped.error!, /Sync stopped/);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM contact_ldap_links WHERE page_id=? AND missing_at IS NOT NULL", pageId))!.n), 0);
  for (const [dn, e] of saved) entries.set(dn, e);
  const unit = entries.get(`ou=dev,${PEOPLE}`)!;
  entries.delete(`ou=dev,${PEOPLE}`);
  await run("UPDATE contact_ldap_sources SET ous=? WHERE page_id=?", JSON.stringify([`ou=sales,${PEOPLE}`, `ou=big,${PEOPLE}`, `ou=dev,${PEOPLE}`]), pageId);
  const vanished = await syncContactsSource(pageId, {});
  assert.equal(vanished.ok, false);
  entries.set(`ou=dev,${PEOPLE}`, unit);
  await unsubscribeUnit(owner, pageId, `ou=dev,${PEOPLE}`);
  await unsubscribeUnit(owner, pageId, `ou=big,${PEOPLE}`);
  assert.deepEqual((await contactsSourceStatus(pageId)).units, [`ou=sales,${PEOPLE}`]);
});

test("a directory that does not answer in time leaves everything as it was", async () => {
  process.env.LDAP_TIMEOUT_MS = "1000";
  fake.delayMs = 1500;
  try {
    const versions = await all<{ id: string; version: number }>("SELECT id,version FROM rows WHERE page_id=?", pageId);
    const result = await syncContactsSource(pageId, {});
    assert.equal(result.ok, false);
    assert.deepEqual(await all<{ id: string; version: number }>("SELECT id,version FROM rows WHERE page_id=?", pageId), versions);
    await assert.rejects(browseUnits(owner, pageId), /nicht erreichbar/);
    assert.equal((await contactsSourceStatus(pageId)).lastSync!.ok, false);
  } finally {
    fake.delayMs = 0;
    process.env.LDAP_TIMEOUT_MS = "5000";
  }
});

test("a mapping of its own: only the mapped properties follow the directory", async () => {
  const other = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "contacts", title: "Partner" })).id as string;
  const result = await importContacts(owner, other, { entries: [`uid=dave,${PEOPLE}`], mapping: { title: ["cn"], lastName: ["sn"], city: ["l", "street"], unknown: ["x"] } });
  assert.equal(result.ok, true, result.error || "");
  const rid = (await one<{ row_id: string }>("SELECT row_id FROM contact_ldap_links WHERE page_id=?", other))!.row_id;
  assert.deepEqual(await cellsOf(rid), { title: "Dave Dorn", lastName: "Dorn", city: "Weg 1" });
  const data = (await pageData(owner, other)) as { contacts: { ldapFields: string[] } };
  assert.deepEqual([...data.contacts.ldapFields].sort(), ["city", "lastName", "title"]);
  await act({ action: "row.update", pageId: other, rowId: rid, version: await versionOf(rid), cells: { company: "Dorn & Söhne" } });
  await assert.rejects(importContacts(owner, other, { entries: [`uid=dave,${PEOPLE}`], mapping: { title: ["bad attribute!"] } }));
});

test("administration: base DN and filter, recorded as security events; switched off means no access", async () => {
  await assert.rejects(async () => await saveContactsLdapSettings(owner, { filter: "(objectClass=person)" }), /Administrator/);
  await assert.rejects(async () => await saveContactsLdapSettings(admin, { filter: "(objectClass=person" }), /Filter/);
  await assert.rejects(async () => await saveContactsLdapSettings(admin, { baseDn: "nonsense" }), /Basis-DN/);
  const status = await saveContactsLdapSettings(admin, { filter: "(objectClass=inetOrgPerson)", intervalMinutes: 30 });
  assert.equal(status.filter, "(objectClass=inetOrgPerson)");
  assert.equal(status.filterSource, "admin");
  assert.equal(status.intervalMinutes, 30);
  assert.equal(status.baseDn, PEOPLE);
  assert.equal(status.baseDnSource, "env");
  assert.ok(status.available);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='contacts.ldap.config' AND actor_id=?", admin.id));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='admin.settings' AND detail LIKE 'contacts.ldap.config%'"));
  // The bind password is never stored.
  assert.ok(!(await all<{ value: string }>("SELECT value FROM directory_status")).some((r) => r.value.includes("service-pw")));
  // The stricter filter leaves Bob (objectClass user) out of the list.
  const sales = await listPeople(owner, pageId, `ou=sales,${PEOPLE}`);
  assert.ok(!sales.people.some((p) => p.name.startsWith("Bob")));
  await saveContactsLdapSettings(admin, { enabled: false });
  assert.equal((await contactsLdapStatus()).available, false);
  await assert.rejects(browseUnits(owner, pageId), /kein LDAP-Verzeichnis/);
  await saveContactsLdapSettings(admin, { enabled: true, filter: "" });
});

/* ---------- Who may reach the directory ---------- */

const { directoryAccess } = ldapContacts;
const refused = /nur für Mitglieder der Organisation/;
// A workspace of the person's own with a contacts database.
async function ownContacts(who: Identity) {
  const ws = (await command(who, { action: "workspace.create", name: `${who.name}s Bereich` })) as { id: string };
  const sid = (await bootstrap(who, ws.id)).spaces[0].id;
  const db = (await command(who, { action: "page.create", workspaceId: ws.id, spaceId: sid, kind: "database", databaseKind: "contacts", title: "Kontakte" })) as { id: string };
  return { workspace: ws.id, page: db.id };
}
async function refusedEverywhere(who: Identity, page: string) {
  for (const call of [
    () => browseUnits(who, page),
    () => listPeople(who, page, `ou=dev,${PEOPLE}`),
    () => listPeople(who, page, undefined, "carol"),
    () => importContacts(who, page, { entries: [`uid=carol,ou=dev,${PEOPLE}`] }),
    () => importContacts(who, page, { units: [`ou=dev,${PEOPLE}`], mapping: { phone: ["homePhone"] } }),
    () => syncContactsNow(who, page),
    () => unsubscribeUnit(who, page, `ou=dev,${PEOPLE}`),
  ])
    await assert.rejects(call(), (e: { status?: number; message?: string }) => e.status === 403 && refused.test(e.message || ""));
  assert.equal(await one("SELECT 1 FROM contact_ldap_sources WHERE page_id=?", page), undefined);
  assert.equal((await contactsSourceStatus(page, who)).allowed, false);
}

test("a guest of a company workspace does not reach the directory through a workspace of their own", async () => {
  const guest = await user("guest");
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
  const own = await ownContacts(guest);
  const before = fake.searches.length;
  await refusedEverywhere(guest, own.page);
  assert.equal(fake.searches.length, before, "not a single directory search");
});

test("an account with only workspaces of its own does not reach the directory", async () => {
  const loner = await user("loner");
  const own = await ownContacts(loner);
  await refusedEverywhere(loner, own.page);
});

test("a full member invited to a workspace reaches it – but never as a guest of the database's workspace", async () => {
  const member = await user("member");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  // In the inviting workspace …
  assert.equal((await browseUnits(member, pageId)).base, PEOPLE);
  assert.ok((await listPeople(member, pageId, `ou=dev,${PEOPLE}`)).people.some((p) => p.name === "Carol Clausen"));
  assert.equal((await contactsSourceStatus(pageId, member)).allowed, true);
  // … and in a workspace of their own.
  const own = await ownContacts(member);
  assert.equal((await importContacts(member, own.page, { entries: [`uid=carol,ou=dev,${PEOPLE}`] })).created, 1);
  // A guest with edit rights on a contacts database of another workspace
  // stays out there, member elsewhere or not.
  const stranger = await user("stranger");
  const theirs = await ownContacts(stranger);
  await run("INSERT INTO members VALUES(?,?,?)", theirs.workspace, member.id, "editor");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", theirs.workspace, member.id);
  await run("INSERT INTO grants VALUES(?,?,?,?)", theirs.page, member.id, "", "editor");
  await refusedEverywhere(member, theirs.page);
  // Being a guest in a workspace somebody else created does not count either.
  assert.equal(await directoryAccess(await user("guest-only"), theirs.workspace), false);
});

test("accounts that sign in with LDAP and administrators reach the directory", async () => {
  const directoryPerson = await user("directory-person");
  await ldapAccount(directoryPerson);
  const mine = await ownContacts(directoryPerson);
  assert.equal((await browseUnits(directoryPerson, mine.page)).base, PEOPLE);
  const theirs = await ownContacts(admin);
  assert.ok((await listPeople(admin, theirs.page, `ou=dev,${PEOPLE}`)).people.length > 0);
  assert.equal((await importContacts(admin, theirs.page, { entries: [`uid=carol,ou=dev,${PEOPLE}`] })).created, 1);
  // API tokens never do.
  assert.equal(await directoryAccess({ ...admin, apiScope: "write" }, theirs.workspace), false);
});

test("attributes: only those of the allow-list, which administrators extend", async () => {
  const page = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "contacts", title: "Erlaubt" })).id as string;
  const status = await contactsSourceStatus(page, owner);
  assert.ok(status.allowedAttributes.includes("telephoneNumber") && !status.allowedAttributes.includes("homePhone"));
  await assert.rejects(
    importContacts(owner, page, { entries: [`uid=carol,ou=dev,${PEOPLE}`], mapping: { title: ["cn"], phone: ["homePhone"] } }),
    (e: { status?: number; message?: string }) => e.status === 400 && /nicht freigegeben/.test(e.message || ""),
  );
  await assert.rejects(importContacts(owner, page, { entries: [`uid=carol,ou=dev,${PEOPLE}`], mapping: { company: ["EmployeeNumber"] } }), /nicht freigegeben/);
  assert.equal(await one("SELECT 1 FROM contact_ldap_sources WHERE page_id=?", page), undefined);
  // Attribute names ignore case.
  assert.equal((await importContacts(owner, page, { entries: [`uid=dave,${PEOPLE}`], mapping: { title: ["CN"], phone: ["TelephoneNumber"] } })).ok, true);
  // An administrator allows more: from the environment and in the administration.
  process.env.LDAP_CONTACTS_ATTRIBUTES = "employeeNumber, b@d!";
  try {
    assert.deepEqual((await contactsLdapStatus()).envAttributes, ["employeeNumber"]);
    await assert.rejects(async () => await saveContactsLdapSettings(owner, { attributes: ["homePhone"] }), /Administrator/);
    const saved = await saveContactsLdapSettings(admin, { attributes: ["homePhone", "HOMEPHONE"] });
    assert.deepEqual(saved.attributes, ["homePhone"]);
    assert.ok(saved.allowedAttributes.includes("homePhone") && saved.allowedAttributes.includes("employeeNumber"));
    const result = await importContacts(owner, page, { entries: [`uid=carol,ou=dev,${PEOPLE}`], mapping: { title: ["cn"], phone: ["homePhone"], company: ["employeeNumber"] } });
    assert.equal(result.ok, true, result.error || "");
    const carol = await cellsOf((await one<{ row_id: string }>("SELECT row_id FROM contact_ldap_links WHERE page_id=? AND lower(dn)=lower(?)", page, `uid=carol,ou=dev,${PEOPLE}`))!.row_id);
    assert.equal(carol.phone, "+49 30 999 privat");
    assert.equal(carol.company, "E-4711");
  } finally {
    delete process.env.LDAP_CONTACTS_ATTRIBUTES;
  }
  // Taken off the list again: stored mappings stop reading the attribute.
  await saveContactsLdapSettings(admin, { attributes: [] });
  assert.deepEqual((await contactsSourceStatus(page)).mapping, { title: ["cn"] });
  const before = fake.searches.length;
  assert.equal((await syncContactsNow(owner, page)).ok, true);
  assert.ok(fake.searches.slice(before).every((s) => !s.attributes.some((a) => /homePhone|employeeNumber/i.test(a))));
});
