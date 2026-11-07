import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-drain-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { searchWorkspace, refreshSearchIndex, drainSearchIndex } = await import("../lib/search-index");

// A large backlog (an import) is indexed in batches between other work;
// a search refreshes only part of it itself (lib/search-index.ts).

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Drain", "drain@example.test");
const owner = { id: uid, name: "Drain", email: "drain@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = createWorkspace(owner.id, "Index");
const space = bootstrap(owner, wid).spaces[0];
const db = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Import", kind: "database" }) as { id: string }).id;
command(owner, {
  action: "database.update",
  pageId: db,
  version: database(db).version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "note", name: "Notiz", type: "text" },
  ],
  views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
});
const backlog = () => Number(one<{ n: number }>("SELECT count(*) n FROM search_dirty")?.n);
const entries = (rowId: string) => Number(one<{ n: number }>("SELECT count(*) n FROM search_index WHERE row_id=?", rowId)?.n);

test("the index finds its entries by page and key through the content table", () => {
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='index' AND name='search_index_key'"));
  const plan = all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT id FROM search_index_content WHERE c0=? AND c1=?",
    "a",
    "b",
  ).map((p) => p.detail);
  assert.ok(plan.some((d) => d.includes("search_index_key")), plan.join("; "));
});

test("a search refreshes a large backlog in part and the drain finishes it", async () => {
  refreshSearchIndex();
  await drainSearchIndex();
  assert.equal(backlog(), 0);
  command(owner, {
    action: "rows.import",
    pageId: db,
    rows: Array.from({ length: 1500 }, (_, i) => ({ title: `Lieferung ${i}`, note: i === 1499 ? "Zollpapiere" : "" })),
  });
  assert.equal(backlog(), 1500);
  // Up to 1000 entries right away; the rest follows in the background.
  searchWorkspace(owner, wid, "Lieferung");
  assert.equal(backlog(), 500);
  await drainSearchIndex();
  assert.equal(backlog(), 0);
  assert.equal(Number(one<{ n: number }>("SELECT count(*) n FROM search_index WHERE page_id=? AND row_id<>''", db)?.n), 1500);
  assert.equal(searchWorkspace(owner, wid, "Zollpapiere")[0]?.title, "Lieferung 1499");
});

test("an edited record keeps one entry with the new text", async () => {
  const row = one<{ id: string; version: number }>("SELECT id,version FROM rows WHERE page_id=? ORDER BY number LIMIT 1", db)!;
  command(owner, { action: "row.update", pageId: db, rowId: row.id, version: row.version, cells: { note: "Frachtbrief" } });
  assert.equal(searchWorkspace(owner, wid, "Frachtbrief")[0]?.rowId, row.id);
  assert.equal(entries(row.id), 1);
  command(owner, { action: "row.delete", pageId: db, rowId: row.id });
  refreshSearchIndex();
  assert.equal(entries(row.id), 0);
  assert.deepEqual(searchWorkspace(owner, wid, "Frachtbrief"), []);
});

test("drains running at the same time share one pass", async () => {
  command(owner, { action: "rows.import", pageId: db, rows: Array.from({ length: 300 }, (_, i) => ({ title: `Nachschub ${i}` })) });
  const first = drainSearchIndex(),
    second = drainSearchIndex();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(backlog(), 0);
  assert.equal(Number(one<{ n: number }>("SELECT count(*) n FROM search_index WHERE title LIKE 'Nachschub %'")?.n), 300);
});
