// Collections (#86): storage, sharing and edit rights, guests, limits, the
// results with each reader's own permissions, the migration of saved
// searches and the extended search syntax in the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-collections-"));
const { one, run, id } = await import("../lib/db");
const { runDataSteps, SAVED_SEARCHES_STEP } = await import("../lib/data-steps");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database: schemaOf } = await import("../lib/api");
const { searchWorkspace } = await import("../lib/search-index");
const { runCollection, previewQuery, evaluateQuery, MAX_COLLECTIONS } = await import("../lib/collections");
const { normalizeQuery } = await import("../lib/collection-query");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Anna"),
  editor = await account("Ben"),
  viewer = await account("Vera"),
  guest = await account("Gustav"),
  stranger = await account("Fremd");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const other = await createWorkspace(stranger.id, "Anderswo");
type Result = { id: string } & Record<string, unknown>;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const team = (await bootstrap(owner, wid)).spaces[0].id;
const secretSpace = (await act({ action: "space.create", workspaceId: wid, name: "Leitung", private: true })).id;

const page = async (title: string, as = owner, spaceId = team, kind = "document") => (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind }, as)).id;
const tag = async (pageId: string, tags: string[], as = owner) => await act({ action: "page.properties", pageId, addTags: tags }, as);
// Pages: by Anna and Ben, tagged.
const angebot = await page("Angebot Müller");
await tag(angebot, ["Kunde", "Offen"]);
const rechnung = await page("Rechnung Müller");
await tag(rechnung, ["Kunde", "Erledigt"]);
const notiz = await page("Notiz von Ben", editor);
await tag(notiz, ["Kunde"], editor);
const board = await page("Planung", owner, team, "whiteboard");
const geheim = await page("Gehaltsliste", owner, secretSpace);
await tag(geheim, ["Kunde"]);
// A database with a private record and a tag-backed property.
const dbId = await page("Aufgaben", owner, team, "database");
const fields = async () => (await schemaOf(dbId)).fields;
await act({
  action: "database.update",
  pageId: dbId,
  version: (await schemaOf(dbId)).version,
  fields: [...await fields(), { id: "themen", name: "Themen", type: "multiselect", options: [], tagOptions: true }, { id: "prio", name: "Dringlichkeit", type: "select", options: ["Hoch", "Niedrig"] }],
  views: (await schemaOf(dbId)).views,
});
const record = async (title: string, cells: Record<string, unknown>, as = owner) => (await act({ action: "row.create", pageId: dbId, cells: { [(await fields())[0].id]: title, ...cells } }, as)).id;
const offenRow = await record("Kunde anrufen", { themen: ["Kunde", "Offen"], prio: "Hoch" });
const privateRow = await record("Privat: Kunde kündigt", { themen: ["Kunde"], prio: "Hoch" });
await act({ action: "row.access", pageId: dbId, rowId: privateRow, access: "private", grants: [] });
const benRow = await record("Bens Aufgabe", { prio: "Niedrig" }, editor);

const titles = (items: { title: string; rowId?: string }[]) => items.map((i) => (i.rowId ? `row:${i.title}` : i.title)).sort();
const results = async (query: string, as = owner, now?: Date) => titles((await evaluateQuery(as, wid, query, { now })).items);

test("boolean logic over tags, creators, types and spaces", async () => {
  assert.deepEqual(await results("#Kunde -#Erledigt"), ["Angebot Müller", "Gehaltsliste", "Notiz von Ben", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(await results("#Offen OR #Erledigt type:document"), ["Angebot Müller", "Rechnung Müller", "row:Kunde anrufen"]);
  assert.deepEqual(await results("(#Offen OR #Erledigt) type:document"), ["Angebot Müller", "Rechnung Müller"]);
  // The issue's example: by Anna, tagged Kunde, but not Erledigt.
  assert.deepEqual(await results("created_by:Anna #Kunde -#Erledigt type:document"), ["Angebot Müller", "Gehaltsliste"]);
  assert.deepEqual(await results("creator:me type:document", editor), ["Notiz von Ben"]);
  assert.deepEqual(await results("type:record"), ["row:Bens Aufgabe", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(await results("type:whiteboard|database"), ["Aufgaben", "Planung"]);
  assert.deepEqual(await results('in:"Leitung"'), ["Gehaltsliste"]);
  assert.deepEqual(await results("title:müller"), ["Angebot Müller", "Rechnung Müller"]);
  assert.deepEqual(await results("Müller -Rechnung"), ["Angebot Müller"]);
  // A record's own property by name.
  assert.deepEqual(await results("Dringlichkeit:Hoch"), ["row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(await results("Dringlichkeit:Niedrig updated_by:Ben"), ["row:Bens Aufgabe"]);
});

test("dates: relative ranges with a fixed now", async () => {
  await run("UPDATE pages SET created_at='2026-01-10 09:00:00',updated_at='2026-01-10 09:00:00' WHERE id=?", rechnung);
  const now = new Date("2026-01-15T12:00:00Z");
  assert.ok((await results("created:-7d", owner, now)).includes("Rechnung Müller"));
  assert.ok(!(await results("created:-3d", owner, now)).includes("Rechnung Müller"));
  assert.deepEqual(await results("#Erledigt created:2026-01", owner, now), ["Rechnung Müller"]);
  assert.deepEqual(await results("#Erledigt updated:<2026-01-10", owner, now), []);
  assert.deepEqual(await results("#Erledigt updated:last-week", owner, now), ["Rechnung Müller"]);
});

test("results follow each reader's permissions", async () => {
  // Ben neither reads the private space nor Anna's private record.
  assert.deepEqual(await results("#Kunde", editor), ["Angebot Müller", "Notiz von Ben", "Rechnung Müller", "row:Kunde anrufen"]);
  // A guest without shares sees nothing.
  assert.deepEqual(await results("#Kunde", guest), []);
  // Pages in the trash are gone.
  await act({ action: "page.delete", pageId: notiz }, editor);
  assert.ok(!(await results("#Kunde")).includes("Notiz von Ben"));
  await act({ action: "page.restore", pageId: notiz }, editor);
});

test("shared collections: everyone sees them, the creator and owners edit, guests see none", async () => {
  const mine = await act({ action: "collection.create", workspaceId: wid, name: "Offene Kunden", query: "#Kunde  -#Erledigt", icon: "📌" }, editor);
  assert.equal(mine.query, "#Kunde -#Erledigt");
  // Private: only Ben sees it.
  assert.deepEqual((await bootstrap(editor, wid)).collections!.map((c) => c.name), ["Offene Kunden"]);
  assert.deepEqual((await bootstrap(owner, wid)).collections, []);
  await assert.rejects(async () => await runCollection(owner, mine.id), /nicht gefunden/);
  // Shared with the workspace.
  await act({ action: "collection.update", collectionId: mine.id, shared: true }, editor);
  const seen = (await bootstrap(viewer, wid)).collections!;
  assert.deepEqual(
    seen.map((c) => [c.name, c.shared, c.mine, c.canEdit, c.ownerName]),
    [["Offene Kunden", true, false, false, "Ben"]],
  );
  assert.equal((await bootstrap(owner, wid)).collections![0].canEdit, true);
  assert.deepEqual((await bootstrap(guest, wid)).collections, []);
  await assert.rejects(async () => await runCollection(guest, mine.id), /nicht gefunden/);
  await assert.rejects(async () => await runCollection(stranger, mine.id), /nicht gefunden/);
  // The results are each reader's own.
  assert.deepEqual(titles((await runCollection(editor, mine.id)).items), ["Angebot Müller", "Notiz von Ben", "row:Kunde anrufen"]);
  assert.deepEqual(titles((await runCollection(owner, mine.id)).items), ["Angebot Müller", "Gehaltsliste", "Notiz von Ben", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(titles((await runCollection(viewer, mine.id)).items), ["Angebot Müller", "Notiz von Ben", "row:Kunde anrufen"]);
  // Viewer may not edit or delete, but duplicate.
  await assert.rejects(async () => await act({ action: "collection.update", collectionId: mine.id, name: "Meins" }, viewer), /ändern nur/);
  await assert.rejects(async () => await act({ action: "collection.delete", collectionId: mine.id }, viewer), /ändern nur/);
  const copy = await act({ action: "collection.duplicate", collectionId: mine.id }, viewer);
  const viewerList = (await bootstrap(viewer, wid)).collections!;
  assert.deepEqual(
    viewerList.map((c) => [c.name, c.mine, c.shared]),
    [
      ["Offene Kunden", true, false],
      ["Offene Kunden", false, true],
    ],
  );
  // The workspace owner may change it, but only Ben shares or unshares it.
  await act({ action: "collection.update", collectionId: mine.id, name: "Kunden offen" });
  await assert.rejects(async () => await act({ action: "collection.update", collectionId: mine.id, shared: false }), /Nur die Person/);
  // Guests keep queries private.
  await assert.rejects(async () => await act({ action: "collection.create", workspaceId: wid, name: "G", query: "#Kunde", shared: true }, guest), /Gäste/);
  await act({ action: "collection.create", workspaceId: wid, name: "G", query: "#Kunde" }, guest);
  // Reorder: each person's own order.
  await act({ action: "collection.reorder", workspaceId: wid, order: [copy.id, mine.id] }, viewer);
  assert.deepEqual((await bootstrap(viewer, wid)).collections!.map((c) => c.id), [copy.id, mine.id]);
  assert.deepEqual((await bootstrap(owner, wid)).collections!.map((c) => c.id), [mine.id]);
  // Delete and restore (undo).
  await act({ action: "collection.delete", collectionId: mine.id }, editor);
  assert.deepEqual((await bootstrap(viewer, wid)).collections!.map((c) => c.id), [copy.id]);
  await assert.rejects(async () => await act({ action: "collection.restore", collectionId: mine.id }, viewer), /nicht gefunden|ändern nur/);
  await act({ action: "collection.restore", collectionId: mine.id }, editor);
  assert.deepEqual((await bootstrap(viewer, wid)).collections!.map((c) => c.id), [copy.id, mine.id]);
  // Other workspaces: nothing.
  await assert.rejects(async () => await act({ action: "collection.create", workspaceId: wid, name: "x", query: "x" }, stranger), /Mitglied|Berechtigung|Zugriff|nicht gefunden/i);
  assert.deepEqual((await bootstrap(stranger, other)).collections, []);
});

test("validation and limits", async () => {
  for (const bad of [
    { name: " ", query: "x" },
    { name: "x", query: "" },
    { name: "x", query: "created:" },
    { name: "x".repeat(121), query: "x" },
    { name: "x", query: "x".repeat(1001) },
  ])
    await assert.rejects(async () => await act({ action: "collection.create", workspaceId: wid, ...bad }));
  const user = await account("Viel");
  await run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  for (let i = 0; i < MAX_COLLECTIONS; i++) await act({ action: "collection.create", workspaceId: wid, name: `S${i}`, query: `q${i}` }, user);
  await assert.rejects(async () => await act({ action: "collection.create", workspaceId: wid, name: "zu viel", query: "x" }, user), /Höchstens/);
});

test("live: a new matching page appears, the preview runs unsaved queries", async () => {
  const c = await act({ action: "collection.create", workspaceId: wid, name: "Neu", query: "#Neuigkeit OR title:Frisch" });
  assert.equal((await runCollection(owner, c.id)).total, 0);
  await page("Frisch gepresst");
  const fresh = await page("Etwas");
  await tag(fresh, ["Neuigkeit"]);
  assert.deepEqual(titles((await runCollection(owner, c.id)).items), ["Etwas", "Frisch gepresst"]);
  const preview = await previewQuery(owner, wid, "type:whiteboard  OR #Neuigkeit");
  assert.equal(preview.query, "type:whiteboard OR #Neuigkeit");
  assert.deepEqual(titles(preview.items), ["Etwas", "Planung"]);
});

test("the search understands the new syntax and keeps the old", async () => {
  const hits = async (query: string, as = owner) => (await searchWorkspace(as, wid, query)).map((h) => (h.rowId ? `row:${h.title}` : h.title)).sort();
  // Old: tags and a phrase, ranked with snippets as before.
  assert.deepEqual(await hits("#Kunde Müller"), ["Angebot Müller", "Rechnung Müller"]);
  assert.deepEqual(await hits("#Kunde -#Erledigt Müller"), ["Angebot Müller"]);
  // New.
  assert.deepEqual(await hits("#Offen OR #Erledigt type:document"), ["Angebot Müller", "Rechnung Müller", "row:Kunde anrufen"]);
  assert.deepEqual(await hits("type:record creator:Ben"), ["row:Bens Aufgabe"]);
  assert.deepEqual(await hits("#Kunde -Müller", editor), ["Notiz von Ben", "row:Kunde anrufen"]);
  const kinds = (await searchWorkspace(owner, wid, "#Offen OR #Erledigt")).map((h) => h.kind).sort();
  assert.deepEqual(kinds, ["document", "document", "row"]);
  assert.deepEqual((await searchWorkspace(owner, wid, "#Offen OR #Erledigt", { kind: "row" })).map((h) => h.title), ["Kunde anrufen"]);
  assert.deepEqual(await searchWorkspace(owner, wid, "#Offen OR #Erledigt", { kind: "comment" }), []);
});

test("search.save and search.delete keep working on collections", async () => {
  const saved = await act({ action: "search.save", workspaceId: wid, name: "Alte Suche", query: "Müller", kind: "document", spaceId: team });
  const c = (await bootstrap(owner, wid)).collections!.find((x) => x.id === saved.id)!;
  assert.equal(c.query, normalizeQuery(`Müller type:document in:"${(await bootstrap(owner, wid)).spaces.find((s) => s.id === team)!.name}"`));
  await act({ action: "search.delete", searchId: saved.id });
  assert.ok(!(await bootstrap(owner, wid)).collections!.some((x) => x.id === saved.id));
});

test("saved searches from before #86 become collections once", async () => {
  const user = await account("Alt");
  await run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  const spaceName = (await bootstrap(owner, wid)).spaces.find((s) => s.id === team)!.name;
  const a = id(),
    b = id(),
    c = id();
  await run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", a, user.id, wid, "Erste", "Müller", "all", null, "2026-01-01 10:00:00");
  await run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", b, user.id, wid, "Zweite", "#Kunde", "row", team, "2026-01-02 10:00:00");
  await run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", c, user.id, wid, "Dritte", "x", "comment", id(), "2026-01-03 10:00:00");
  // The step runs again as on a server that has not had it yet.
  await run("DELETE FROM data_migrations WHERE name=?", SAVED_SEARCHES_STEP);
  await runDataSteps([SAVED_SEARCHES_STEP]);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM saved_searches"))!.n), 0);
  assert.deepEqual(
    (await bootstrap(user, wid)).collections!.filter((x) => x.mine).map((x) => [x.id, x.name, x.query, x.shared]),
    [
      [a, "Erste", "Müller", false],
      [b, "Zweite", `#Kunde type:record in:"${spaceName}"`, false],
      [c, "Dritte", "x", false],
    ],
  );
  assert.deepEqual(titles((await runCollection(user, b)).items), ["row:Kunde anrufen"]);
  // Running it again changes nothing.
  await run("DELETE FROM data_migrations WHERE name=?", SAVED_SEARCHES_STEP);
  await runDataSteps([SAVED_SEARCHES_STEP]);
  assert.equal((await bootstrap(user, wid)).collections!.filter((x) => x.mine).length, 3);
});
