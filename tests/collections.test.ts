// Collections (#86): storage, sharing and edit rights, guests, limits, the
// results with each reader's own permissions, the migration of saved
// searches and the extended search syntax in the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-collections-"));
const { one, run, id, db: database, migrateSavedSearches } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database: schemaOf } = await import("../lib/api");
const { searchWorkspace } = await import("../lib/search-index");
const { runCollection, previewQuery, evaluateQuery, MAX_COLLECTIONS } = await import("../lib/collections");
const { normalizeQuery } = await import("../lib/collection-query");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Anna"),
  editor = account("Ben"),
  viewer = account("Vera"),
  guest = account("Gustav"),
  stranger = account("Fremd");
const wid = createWorkspace(owner.id, "Agentur");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const other = createWorkspace(stranger.id, "Anderswo");
type Result = { id: string } & Record<string, unknown>;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Result;
const team = bootstrap(owner, wid).spaces[0].id;
const secretSpace = act({ action: "space.create", workspaceId: wid, name: "Leitung", private: true }).id;

const page = (title: string, as = owner, spaceId = team, kind = "document") => act({ action: "page.create", workspaceId: wid, spaceId, title, kind }, as).id;
const tag = (pageId: string, tags: string[], as = owner) => act({ action: "page.properties", pageId, addTags: tags }, as);
// Pages: by Anna and Ben, tagged.
const angebot = page("Angebot Müller");
tag(angebot, ["Kunde", "Offen"]);
const rechnung = page("Rechnung Müller");
tag(rechnung, ["Kunde", "Erledigt"]);
const notiz = page("Notiz von Ben", editor);
tag(notiz, ["Kunde"], editor);
const board = page("Planung", owner, team, "whiteboard");
const geheim = page("Gehaltsliste", owner, secretSpace);
tag(geheim, ["Kunde"]);
// A database with a private record and a tag-backed property.
const dbId = page("Aufgaben", owner, team, "database");
const fields = () => schemaOf(dbId).fields;
act({
  action: "database.update",
  pageId: dbId,
  version: schemaOf(dbId).version,
  fields: [...fields(), { id: "themen", name: "Themen", type: "multiselect", options: [], tagOptions: true }, { id: "prio", name: "Dringlichkeit", type: "select", options: ["Hoch", "Niedrig"] }],
  views: schemaOf(dbId).views,
});
const record = (title: string, cells: Record<string, unknown>, as = owner) => act({ action: "row.create", pageId: dbId, cells: { [fields()[0].id]: title, ...cells } }, as).id;
const offenRow = record("Kunde anrufen", { themen: ["Kunde", "Offen"], prio: "Hoch" });
const privateRow = record("Privat: Kunde kündigt", { themen: ["Kunde"], prio: "Hoch" });
act({ action: "row.access", pageId: dbId, rowId: privateRow, access: "private", grants: [] });
const benRow = record("Bens Aufgabe", { prio: "Niedrig" }, editor);

const titles = (items: { title: string; rowId?: string }[]) => items.map((i) => (i.rowId ? `row:${i.title}` : i.title)).sort();
const results = (query: string, as = owner, now?: Date) => titles(evaluateQuery(as, wid, query, { now }).items);

test("boolean logic over tags, creators, types and spaces", () => {
  assert.deepEqual(results("#Kunde -#Erledigt"), ["Angebot Müller", "Gehaltsliste", "Notiz von Ben", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(results("#Offen OR #Erledigt type:document"), ["Angebot Müller", "Rechnung Müller", "row:Kunde anrufen"]);
  assert.deepEqual(results("(#Offen OR #Erledigt) type:document"), ["Angebot Müller", "Rechnung Müller"]);
  // The issue's example: by Anna, tagged Kunde, but not Erledigt.
  assert.deepEqual(results("created_by:Anna #Kunde -#Erledigt type:document"), ["Angebot Müller", "Gehaltsliste"]);
  assert.deepEqual(results("creator:me type:document", editor), ["Notiz von Ben"]);
  assert.deepEqual(results("type:record"), ["row:Bens Aufgabe", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(results("type:whiteboard|database"), ["Aufgaben", "Planung"]);
  assert.deepEqual(results('in:"Leitung"'), ["Gehaltsliste"]);
  assert.deepEqual(results("title:müller"), ["Angebot Müller", "Rechnung Müller"]);
  assert.deepEqual(results("Müller -Rechnung"), ["Angebot Müller"]);
  // A record's own property by name.
  assert.deepEqual(results("Dringlichkeit:Hoch"), ["row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(results("Dringlichkeit:Niedrig updated_by:Ben"), ["row:Bens Aufgabe"]);
});

test("dates: relative ranges with a fixed now", () => {
  run("UPDATE pages SET created_at='2026-01-10 09:00:00',updated_at='2026-01-10 09:00:00' WHERE id=?", rechnung);
  const now = new Date("2026-01-15T12:00:00Z");
  assert.ok(results("created:-7d", owner, now).includes("Rechnung Müller"));
  assert.ok(!results("created:-3d", owner, now).includes("Rechnung Müller"));
  assert.deepEqual(results("#Erledigt created:2026-01", owner, now), ["Rechnung Müller"]);
  assert.deepEqual(results("#Erledigt updated:<2026-01-10", owner, now), []);
  assert.deepEqual(results("#Erledigt updated:last-week", owner, now), ["Rechnung Müller"]);
});

test("results follow each reader's permissions", () => {
  // Ben neither reads the private space nor Anna's private record.
  assert.deepEqual(results("#Kunde", editor), ["Angebot Müller", "Notiz von Ben", "Rechnung Müller", "row:Kunde anrufen"]);
  // A guest without shares sees nothing.
  assert.deepEqual(results("#Kunde", guest), []);
  // Pages in the trash are gone.
  act({ action: "page.delete", pageId: notiz }, editor);
  assert.ok(!results("#Kunde").includes("Notiz von Ben"));
  act({ action: "page.restore", pageId: notiz }, editor);
});

test("shared collections: everyone sees them, the creator and owners edit, guests see none", () => {
  const mine = act({ action: "collection.create", workspaceId: wid, name: "Offene Kunden", query: "#Kunde  -#Erledigt", icon: "📌" }, editor);
  assert.equal(mine.query, "#Kunde -#Erledigt");
  // Private: only Ben sees it.
  assert.deepEqual(bootstrap(editor, wid).collections!.map((c) => c.name), ["Offene Kunden"]);
  assert.deepEqual(bootstrap(owner, wid).collections, []);
  assert.throws(() => runCollection(owner, mine.id), /nicht gefunden/);
  // Shared with the workspace.
  act({ action: "collection.update", collectionId: mine.id, shared: true }, editor);
  const seen = bootstrap(viewer, wid).collections!;
  assert.deepEqual(
    seen.map((c) => [c.name, c.shared, c.mine, c.canEdit, c.ownerName]),
    [["Offene Kunden", true, false, false, "Ben"]],
  );
  assert.equal(bootstrap(owner, wid).collections![0].canEdit, true);
  assert.deepEqual(bootstrap(guest, wid).collections, []);
  assert.throws(() => runCollection(guest, mine.id), /nicht gefunden/);
  assert.throws(() => runCollection(stranger, mine.id), /nicht gefunden/);
  // The results are each reader's own.
  assert.deepEqual(titles(runCollection(editor, mine.id).items), ["Angebot Müller", "Notiz von Ben", "row:Kunde anrufen"]);
  assert.deepEqual(titles(runCollection(owner, mine.id).items), ["Angebot Müller", "Gehaltsliste", "Notiz von Ben", "row:Kunde anrufen", "row:Privat: Kunde kündigt"]);
  assert.deepEqual(titles(runCollection(viewer, mine.id).items), ["Angebot Müller", "Notiz von Ben", "row:Kunde anrufen"]);
  // Viewer may not edit or delete, but duplicate.
  assert.throws(() => act({ action: "collection.update", collectionId: mine.id, name: "Meins" }, viewer), /ändern nur/);
  assert.throws(() => act({ action: "collection.delete", collectionId: mine.id }, viewer), /ändern nur/);
  const copy = act({ action: "collection.duplicate", collectionId: mine.id }, viewer);
  const viewerList = bootstrap(viewer, wid).collections!;
  assert.deepEqual(
    viewerList.map((c) => [c.name, c.mine, c.shared]),
    [
      ["Offene Kunden", true, false],
      ["Offene Kunden", false, true],
    ],
  );
  // The workspace owner may change it, but only Ben shares or unshares it.
  act({ action: "collection.update", collectionId: mine.id, name: "Kunden offen" });
  assert.throws(() => act({ action: "collection.update", collectionId: mine.id, shared: false }), /Nur die Person/);
  // Guests keep queries private.
  assert.throws(() => act({ action: "collection.create", workspaceId: wid, name: "G", query: "#Kunde", shared: true }, guest), /Gäste/);
  act({ action: "collection.create", workspaceId: wid, name: "G", query: "#Kunde" }, guest);
  // Reorder: each person's own order.
  act({ action: "collection.reorder", workspaceId: wid, order: [copy.id, mine.id] }, viewer);
  assert.deepEqual(bootstrap(viewer, wid).collections!.map((c) => c.id), [copy.id, mine.id]);
  assert.deepEqual(bootstrap(owner, wid).collections!.map((c) => c.id), [mine.id]);
  // Delete and restore (undo).
  act({ action: "collection.delete", collectionId: mine.id }, editor);
  assert.deepEqual(bootstrap(viewer, wid).collections!.map((c) => c.id), [copy.id]);
  assert.throws(() => act({ action: "collection.restore", collectionId: mine.id }, viewer), /nicht gefunden|ändern nur/);
  act({ action: "collection.restore", collectionId: mine.id }, editor);
  assert.deepEqual(bootstrap(viewer, wid).collections!.map((c) => c.id), [copy.id, mine.id]);
  // Other workspaces: nothing.
  assert.throws(() => act({ action: "collection.create", workspaceId: wid, name: "x", query: "x" }, stranger), /Mitglied|Berechtigung|Zugriff|nicht gefunden/i);
  assert.deepEqual(bootstrap(stranger, other).collections, []);
});

test("validation and limits", () => {
  for (const bad of [
    { name: " ", query: "x" },
    { name: "x", query: "" },
    { name: "x", query: "created:" },
    { name: "x".repeat(121), query: "x" },
    { name: "x", query: "x".repeat(1001) },
  ])
    assert.throws(() => act({ action: "collection.create", workspaceId: wid, ...bad }));
  const user = account("Viel");
  run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  for (let i = 0; i < MAX_COLLECTIONS; i++) act({ action: "collection.create", workspaceId: wid, name: `S${i}`, query: `q${i}` }, user);
  assert.throws(() => act({ action: "collection.create", workspaceId: wid, name: "zu viel", query: "x" }, user), /Höchstens/);
});

test("live: a new matching page appears, the preview runs unsaved queries", () => {
  const c = act({ action: "collection.create", workspaceId: wid, name: "Neu", query: "#Neuigkeit OR title:Frisch" });
  assert.equal(runCollection(owner, c.id).total, 0);
  page("Frisch gepresst");
  const fresh = page("Etwas");
  tag(fresh, ["Neuigkeit"]);
  assert.deepEqual(titles(runCollection(owner, c.id).items), ["Etwas", "Frisch gepresst"]);
  const preview = previewQuery(owner, wid, "type:whiteboard  OR #Neuigkeit");
  assert.equal(preview.query, "type:whiteboard OR #Neuigkeit");
  assert.deepEqual(titles(preview.items), ["Etwas", "Planung"]);
});

test("the search understands the new syntax and keeps the old", () => {
  const hits = (query: string, as = owner) => searchWorkspace(as, wid, query).map((h) => (h.rowId ? `row:${h.title}` : h.title)).sort();
  // Old: tags and a phrase, ranked with snippets as before.
  assert.deepEqual(hits("#Kunde Müller"), ["Angebot Müller", "Rechnung Müller"]);
  assert.deepEqual(hits("#Kunde -#Erledigt Müller"), ["Angebot Müller"]);
  // New.
  assert.deepEqual(hits("#Offen OR #Erledigt type:document"), ["Angebot Müller", "Rechnung Müller", "row:Kunde anrufen"]);
  assert.deepEqual(hits("type:record creator:Ben"), ["row:Bens Aufgabe"]);
  assert.deepEqual(hits("#Kunde -Müller", editor), ["Notiz von Ben", "row:Kunde anrufen"]);
  const kinds = searchWorkspace(owner, wid, "#Offen OR #Erledigt").map((h) => h.kind).sort();
  assert.deepEqual(kinds, ["document", "document", "row"]);
  assert.deepEqual(searchWorkspace(owner, wid, "#Offen OR #Erledigt", { kind: "row" }).map((h) => h.title), ["Kunde anrufen"]);
  assert.deepEqual(searchWorkspace(owner, wid, "#Offen OR #Erledigt", { kind: "comment" }), []);
});

test("search.save and search.delete keep working on collections", () => {
  const saved = act({ action: "search.save", workspaceId: wid, name: "Alte Suche", query: "Müller", kind: "document", spaceId: team });
  const c = bootstrap(owner, wid).collections!.find((x) => x.id === saved.id)!;
  assert.equal(c.query, normalizeQuery(`Müller type:document in:"${bootstrap(owner, wid).spaces.find((s) => s.id === team)!.name}"`));
  act({ action: "search.delete", searchId: saved.id });
  assert.ok(!bootstrap(owner, wid).collections!.some((x) => x.id === saved.id));
});

test("saved searches from before #86 become collections once", () => {
  const user = account("Alt");
  run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  const spaceName = bootstrap(owner, wid).spaces.find((s) => s.id === team)!.name;
  const a = id(),
    b = id(),
    c = id();
  run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", a, user.id, wid, "Erste", "Müller", "all", null, "2026-01-01 10:00:00");
  run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", b, user.id, wid, "Zweite", "#Kunde", "row", team, "2026-01-02 10:00:00");
  run("INSERT INTO saved_searches(id,user_id,workspace_id,name,query,kind,space_id,created_at) VALUES(?,?,?,?,?,?,?,?)", c, user.id, wid, "Dritte", "x", "comment", id(), "2026-01-03 10:00:00");
  migrateSavedSearches(database() as DatabaseSync);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM saved_searches")!.n, 0);
  assert.deepEqual(
    bootstrap(user, wid).collections!.filter((x) => x.mine).map((x) => [x.id, x.name, x.query, x.shared]),
    [
      [a, "Erste", "Müller", false],
      [b, "Zweite", `#Kunde type:record in:"${spaceName}"`, false],
      [c, "Dritte", "x", false],
    ],
  );
  assert.deepEqual(titles(runCollection(user, b).items), ["row:Kunde anrufen"]);
  // Running it again changes nothing.
  migrateSavedSearches(database() as DatabaseSync);
  assert.equal(bootstrap(user, wid).collections!.filter((x) => x.mine).length, 3);
});
