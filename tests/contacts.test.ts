// Contacts databases (issue #64): setup, display name, birthdays, the AI
// lock, vCard import/export, the mention card and CardDAV (lib/contacts.ts,
// lib/contacts-io.ts, lib/carddav.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-contacts-"));
process.env.APP_URL = "https://flowplan.test";
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace, databaseSetup } = await import("../lib/seed");
const { aiMayRead, setAiBlock } = await import("../lib/ai/access");
const { deriveContactCells, contactsSetup } = await import("../lib/contacts");
const { exportVCards, importVCards, contactCard } = await import("../lib/contacts-io");
const { handleCardDav, createCardDavAccess, createCardDavProfileLink, redeemCardDavProfileLink, hasCardDavAccess, revokeCardDavAccess } = await import("../lib/carddav");
const { parseVCards } = await import("../lib/vcard");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  outsider = await user("outsider");
const wid = await createWorkspace(owner.id, "Team"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, { workspaceId: wid, ...body });
const pageId = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "contacts", title: "Kontakte" })).id as string;
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);

test("a contacts database has the contact properties, views and a profile card layout", async () => {
  const db = await database(pageId);
  const ids = db.fields.map((f) => f.id);
  for (const key of ["title", "firstName", "lastName", "company", "position", "email", "phone", "mobile", "street", "postalCode", "city", "country", "birthday", "tags"])
    assert.ok(ids.includes(key), key);
  assert.equal(db.fields.find((f) => f.id === "email")!.type, "email");
  assert.equal(db.fields.find((f) => f.id === "phone")!.type, "phone");
  assert.equal(db.fields.find((f) => f.id === "birthday")!.type, "date");
  assert.deepEqual(db.views[0].sorts[0], { field: "lastName", direction: "asc" });
  assert.ok(db.views.some((v) => v.type === "table"));
  assert.equal(db.views.find((v) => v.type === "calendar")!.dateField, "birthday");
  assert.equal(db.recordLayout!.open, "full");
  assert.equal(db.recordLayout!.card, "contact");
  assert.deepEqual(databaseSetup("contacts").fields.map((f) => f.id), contactsSetup().fields.map((f) => f.id));
  // Other kinds keep their layout without a card.
  const docs = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", databaseKind: "documents", title: "Docs" })).id;
  assert.equal((await database(docs)).recordLayout!.card, undefined);
});

test("new contacts databases are closed to the AI until a manager opens them", async () => {
  assert.equal(await aiMayRead(owner, pageId), false);
  const tasks = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", title: "Aufgaben" })).id;
  assert.equal(await aiMayRead(owner, tasks), true);
  await setAiBlock(owner, { targetId: pageId, kind: "page", blocked: false });
  assert.equal(await aiMayRead(owner, pageId), true);
  await setAiBlock(owner, { targetId: pageId, kind: "page", blocked: true });
});

test("the title follows first and last name, a typed name fills them, birthdays repeat yearly", async () => {
  const a = (await act({ action: "row.create", pageId, cells: { title: "Neuer Kontakt" } })).id;
  // A full name typed into the title fills the name properties.
  await act({ action: "row.update", pageId, rowId: a, version: 1, cells: { title: "Anna Maria Schmidt" } });
  assert.deepEqual([(await cells(a)).firstName, (await cells(a)).lastName, (await cells(a)).title], ["Anna Maria", "Schmidt", "Anna Maria Schmidt"]);
  // Changing a name updates the derived title.
  await act({ action: "row.update", pageId, rowId: a, version: 2, cells: { lastName: "Weber" } });
  assert.equal((await cells(a)).title, "Anna Maria Weber");
  // A title written by hand stays.
  await act({ action: "row.update", pageId, rowId: a, version: 3, cells: { title: "Dr. A. Weber" } });
  await act({ action: "row.update", pageId, rowId: a, version: 4, cells: { firstName: "Anna" } });
  assert.equal((await cells(a)).title, "Dr. A. Weber");
  // Created with names: the title is the name.
  const b = (await act({ action: "row.create", pageId, cells: { title: "New contact", firstName: "Bo", lastName: "Berg", birthday: "1990-05-17" } })).id;
  assert.equal((await cells(b)).title, "Bo Berg");
  assert.equal(JSON.parse((await one<{ recurrence: string }>("SELECT recurrence FROM rows WHERE id=?", b))!.recurrence).freq, "yearly");
  await act({ action: "row.update", pageId, rowId: b, version: 1, cells: { birthday: "" } });
  assert.equal((await one<{ recurrence: string }>("SELECT recurrence FROM rows WHERE id=?", b))!.recurrence, "");
  // Other databases are untouched by this logic.
  assert.deepEqual(deriveContactCells([{ id: "title", name: "T", type: "text" }], {}, { title: "x" }, ["title"]), { title: "x" });
});

test("vCard import creates contacts with notes, tags and photos; export brings them back", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");
  const file = [
    "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Lindqvist;Sören;;;\r\nFN:Sören Lindqvist\r\nORG:Nordlicht AB\r\nTITLE:CTO\r\nEMAIL;TYPE=INTERNET,WORK:soren@nordlicht.example\r\nTEL;TYPE=WORK:+46 8 123\r\nTEL;TYPE=CELL:+46 70 456\r\nADR;TYPE=WORK:;;Storgatan 5;Stockholm;;111 22;Schweden\r\nBDAY:1975-11-03\r\nCATEGORIES:Partner\r\nNOTE:Trifft man auf der Messe.\\nImmer freundlich.\r\n",
    `PHOTO;ENCODING=b;TYPE=JPEG:${jpeg}\r\nEND:VCARD\r\n`,
    "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Kim Park\r\nEMAIL:kim@example.org\r\nEND:VCARD\r\n",
  ].join("");
  await assert.rejects(async () => await importVCards(viewer, pageId, file), /Berechtigung/);
  const result = await importVCards(owner, pageId, file);
  assert.deepEqual(result, { created: 2, updated: 0, skipped: 0 });
  const soren = (await one<{ id: string; cells: string; icon: string; content: string }>("SELECT * FROM rows WHERE page_id=? AND cells LIKE '%Lindqvist%'", pageId))!;
  const c = JSON.parse(soren.cells);
  assert.equal(c.title, "Sören Lindqvist");
  assert.equal(c.company, "Nordlicht AB");
  assert.equal(c.mobile, "+46 70 456");
  assert.equal(c.city, "Stockholm");
  assert.deepEqual(c.tags, ["Partner"]);
  assert.match(soren.icon, /^\/api\/files\//);
  assert.match(soren.content, /Messe/);
  assert.ok((await database(pageId)).fields.find((f) => f.id === "tags")!.options!.includes("Partner"));
  // Export: the whole database, a selection, one contact.
  const all = await exportVCards(viewer, pageId);
  assert.ok(all.count >= 4);
  const one_ = await exportVCards(viewer, pageId, [soren.id], "4.0");
  assert.equal(one_.count, 1);
  const [back] = parseVCards(one_.text);
  assert.equal(back.uid, soren.id);
  assert.equal(back.note, "Trifft man auf der Messe.\nImmer freundlich.");
  assert.equal(back.photo?.mime, "image/jpeg");
  assert.equal(back.birthday, "1975-11-03");
  await assert.rejects(async () => await exportVCards(outsider, pageId), /Berechtigung|nicht gefunden/);
  // Re-importing an exported card updates its record instead of duplicating it.
  const again = await importVCards(owner, pageId, one_.text.replace("CTO", "CEO"));
  assert.deepEqual(again, { created: 0, updated: 1, skipped: 0 });
  assert.equal((await cells(soren.id)).position, "CEO");
  await assert.rejects(async () => await importVCards(owner, pageId, "nothing here"), /keine Kontakte/);
});

test("the page data and the mention card describe contacts; other databases have no card", async () => {
  const data = (await pageData(owner, pageId)) as { contacts?: { synced: object } };
  assert.ok(data.contacts);
  const soren = (await one<{ id: string }>("SELECT id FROM rows WHERE page_id=? AND cells LIKE '%Lindqvist%'", pageId))!;
  const card = (await contactCard(viewer, pageId, soren.id))!;
  assert.equal(card.name, "Sören Lindqvist");
  assert.equal(card.company, "Nordlicht AB");
  assert.equal(card.email, "soren@nordlicht.example");
  assert.equal(card.ldap, false);
  await assert.rejects(async () => await contactCard(outsider, pageId, soren.id));
  const tasks = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", title: "Liste" })).id;
  const row = (await act({ action: "row.create", pageId: tasks, cells: { title: "x" } })).id;
  assert.equal(await contactCard(owner, tasks, row), null);
});

test("CardDAV: discovery, authentication, permissions and read-only address book", async () => {
  const access = await createCardDavAccess(viewer, pageId);
  assert.ok(await hasCardDavAccess(viewer, pageId));
  const auth = (password = access.password) => `Basic ${Buffer.from(`${access.username}:${password}`).toString("base64")}`;
  const dav = (method: string, path: string, body = "", headers: Record<string, string> = {}, password?: string) =>
    handleCardDav(new Request(`https://flowplan.test${path}`, { method, body: body || undefined, headers: { authorization: auth(password), ...headers } }));
  const book = new URL(access.addressBook).pathname;
  const wellKnown = await handleCardDav(new Request("https://flowplan.test/.well-known/carddav", { method: "PROPFIND" }));
  assert.equal(wellKnown.status, 301);
  assert.equal(wellKnown.headers.get("location"), "https://flowplan.test/api/carddav/");
  assert.equal((await dav("PROPFIND", "/api/carddav/", "", {}, "wrong")).status, 401);
  assert.equal((await handleCardDav(new Request("https://flowplan.test/api/carddav/", { method: "PROPFIND" }))).status, 401);
  const root = await (await dav("PROPFIND", "/api/carddav/")).text();
  assert.match(root, /current-user-principal><d:href>\/api\/carddav\/principal\//);
  const principal = await (await dav("PROPFIND", "/api/carddav/principal/")).text();
  assert.match(principal, /addressbook-home-set><d:href>\/api\/carddav\/addressbooks\//);
  const home = await (await dav("PROPFIND", "/api/carddav/addressbooks/", "", { depth: "1" })).text();
  assert.ok(home.includes(book));
  assert.match(home, /<card:addressbook\/>/);
  const list = await dav("PROPFIND", book, "", { depth: "1" });
  assert.equal(list.status, 207);
  const listText = await list.text();
  const rowCount = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", pageId))!.n);
  assert.equal((listText.match(/\.vcf</g) || []).length, rowCount);
  assert.match(listText, /<d:privilege><d:read\/><\/d:privilege><\/d:current-user-privilege-set>/);
  const soren = (await one<{ id: string }>("SELECT id FROM rows WHERE page_id=? AND cells LIKE '%Lindqvist%'", pageId))!;
  const report = await (
    await dav("REPORT", book, `<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><d:href>${book}${soren.id}.vcf</d:href></card:addressbook-multiget>`)
  ).text();
  assert.match(report, /FN:Sören Lindqvist/);
  assert.equal((report.match(/<d:response>/g) || []).length, 1);
  const query = await (await dav("REPORT", book, `<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/></d:prop></card:addressbook-query>`)).text();
  assert.equal((query.match(/<d:response>/g) || []).length, rowCount);
  assert.doesNotMatch(query, /address-data/);
  const get = await dav("GET", `${book}${soren.id}.vcf`);
  assert.equal(get.status, 200);
  assert.match(get.headers.get("content-type")!, /text\/vcard/);
  assert.match(await get.text(), /ORG:Nordlicht AB/);
  // Read-only: no writing through CardDAV.
  assert.equal((await dav("PUT", `${book}${soren.id}.vcf`, "BEGIN:VCARD\r\nEND:VCARD")).status, 403);
  assert.equal((await dav("DELETE", `${book}${soren.id}.vcf`)).status, 403);
  // Another person's address book path is not reachable with this access.
  assert.equal((await dav("PROPFIND", `/api/carddav/addressbooks/${id()}/`)).status, 404);
  // Private records stay out of the address book.
  await run("UPDATE rows SET access='private' WHERE id=?", soren.id);
  assert.equal((await dav("GET", `${book}${soren.id}.vcf`)).status, 404);
  await run("UPDATE rows SET access='inherit' WHERE id=?", soren.id);
  // Losing access to the database ends the address book.
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, viewer.id);
  assert.equal((await dav("PROPFIND", book)).status, 401);
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  await revokeCardDavAccess(viewer, pageId);
  assert.equal((await dav("PROPFIND", book)).status, 401);
  // Only contacts databases can be subscribed; outsiders cannot at all.
  const tasks = (await act({ action: "page.create", spaceId: boot.spaces[0].id, kind: "database", title: "Nicht Kontakte" })).id;
  await assert.rejects(async () => await createCardDavAccess(owner, tasks), /keine Kontakte/);
  await assert.rejects(async () => await createCardDavAccess(outsider, pageId));
});

test("the iOS configuration profile is downloaded once and holds a CardDAV account", async () => {
  const link = await createCardDavProfileLink(owner, pageId);
  const token = new URL(link.url).searchParams.get("profile")!;
  const profile = (await redeemCardDavProfileLink(token))!;
  assert.match(profile, /com\.apple\.carddav\.account/);
  assert.match(profile, /<key>CardDAVPrincipalURL<\/key><string>https:\/\/flowplan\.test\/api\/carddav\/principal\/<\/string>/);
  assert.match(profile, /<key>CardDAVUseSSL<\/key><true\/>/);
  assert.equal(await redeemCardDavProfileLink(token), null);
  assert.ok(await hasCardDavAccess(owner, pageId));
});
