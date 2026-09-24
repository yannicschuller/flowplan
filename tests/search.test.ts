import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { searchWorkspace, processSearchIndex, htmlText, MARK_START, MARK_END } =
  await import("../lib/search-index");

function account(name: string) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = account("search-owner"),
  member = account("search-member");
const wid = createWorkspace(owner.id, "Suche");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const team = bootstrap(owner, wid).spaces[0];
const act = (input: Record<string, unknown>, as = owner) =>
  command(as, input) as { id: string };
const privateSpace = act({
  action: "space.create",
  workspaceId: wid,
  name: "Privat",
  private: true,
}).id;
const page = (title: string, kind = "document", spaceId = team.id) =>
  act({ action: "page.create", workspaceId: wid, spaceId, title, kind }).id;
const setHtml = (pageId: string, html: string) =>
  run(
    "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html",
    pageId,
    html,
  );
const find = (q: string, as = member, options = {}) =>
  searchWorkspace(as, wid, q, options);

const doc = page("Quartalsbericht");
setHtml(
  doc,
  "<h1>Übersicht</h1><p>Die Projektplanung für den Umzug &amp; die Übergänge.</p>",
);
const db = page("Aufgaben", "database");
command(owner, {
  action: "database.update",
  pageId: db,
  version: database(db).version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "note", name: "Notiz", type: "text" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["Kühlschrank"] },
    { id: "link", name: "Link", type: "relation", relationPage: db },
  ],
  views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
});
const row = act({
  action: "row.create",
  pageId: db,
  cells: {
    title: "Angebot einholen",
    note: "Lieferant anrufen",
    tags: ["Kühlschrank"],
  },
}).id;
const linked = act({
  action: "row.create",
  pageId: db,
  cells: { title: "Folgeaufgabe", link: [row] },
}).id;
const secret = page("Gehaltsliste", "document", privateSpace);
setHtml(secret, "<p>Vertraulicher Projektplanungsstand</p>");

test("html text strips markup and decodes entities", () => {
  assert.equal(
    htmlText("<p>A &amp; B</p><script>alert(1)</script><b>C&nbsp;D</b>"),
    "A & B C D",
  );
});

test("indexed search finds compound parts, ignores case and diacritics and highlights snippets", () => {
  const hits = find("planung");
  assert.deepEqual(
    hits.map((h) => h.title),
    ["Quartalsbericht"],
  );
  assert.equal(hits[0].kind, "document");
  assert.ok(hits[0].snippet.includes(`${MARK_START}planung${MARK_END}`));
  assert.equal(find("UBERGANGE")[0]?.id, doc);
  assert.equal(find("kuhlschrank")[0]?.rowId, row);
  // Titles rank before body matches.
  assert.equal(find("aufgabe")[0]?.id, db);
});

test("record hits carry row ids and database titles; ids of related records are not indexed", () => {
  const [hit] = find("Lieferant");
  assert.equal(hit.id, db);
  assert.equal(hit.rowId, row);
  assert.equal(hit.title, "Angebot einholen");
  assert.equal(hit.pageTitle, "Aufgaben");
  assert.equal(hit.kind, "row");
  assert.deepEqual(
    find(row.slice(0, 13)).map((h) => h.rowId),
    [],
  );
  assert.ok(find("Folgeaufgabe").some((h) => h.rowId === linked));
});

test("results respect permissions, trash, kind and space filters", () => {
  assert.deepEqual(
    find("Projektplanung").map((h) => h.id),
    [doc],
  );
  assert.deepEqual(
    find("Projektplanungsstand", owner).map((h) => h.id),
    [secret],
  );
  assert.deepEqual(
    find("a", member, { kind: "row" }).every((h) => h.kind === "row"),
    true,
  );
  assert.deepEqual(
    find("Aufgaben", member, { kind: "database" }).map((h) => h.id),
    [db],
  );
  assert.deepEqual(
    find("Projektplanung", owner, { spaceId: privateSpace }).map((h) => h.id),
    [secret],
  );
  command(owner, { action: "page.delete", pageId: doc });
  assert.deepEqual(find("Projektplanung"), []);
  command(owner, { action: "page.restore", pageId: doc });
  assert.deepEqual(
    find("Projektplanung").map((h) => h.id),
    [doc],
  );
});

test("edits, deletions and record documents update the index incrementally", () => {
  command(owner, {
    action: "row.update",
    pageId: db,
    rowId: row,
    version: 1,
    cells: { note: "Handwerker beauftragen" },
  });
  assert.deepEqual(find("Lieferant"), []);
  assert.equal(find("Handwerker")[0]?.rowId, row);
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
    row,
    new Uint8Array(),
    "<p>Rückfrage zur Montage</p>",
    "1",
  );
  assert.equal(find("montage")[0]?.rowId, row);
  command(owner, { action: "row.delete", pageId: db, rowId: row });
  assert.deepEqual(find("montage"), []);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM search_dirty")!.n, 0);
});

test("query syntax is literal and short queries still work", () => {
  for (const q of ['"', "AND OR NOT", "*", "planung*", "a:b", "(", "NEAR("])
    assert.doesNotThrow(() => find(q));
  assert.equal(find("Qu")[0]?.id, doc);
  assert.equal(find("%").length, 0);
  // Empty queries list recent accessible pages but no records.
  assert.ok(find("").some((h) => h.id === doc));
  assert.ok(!find("").some((h) => h.id === secret));
  assert.deepEqual(find("", member, { kind: "row" }), []);
});

test("a rebuilt index covers existing data and large backlogs drain in batches", () => {
  run("DELETE FROM search_state");
  assert.ok(processSearchIndex(1) >= 1);
  let rounds = 0;
  while (processSearchIndex(2)) rounds++;
  assert.ok(rounds > 0);
  assert.equal(find("Projektplanung")[0]?.id, doc);
});
