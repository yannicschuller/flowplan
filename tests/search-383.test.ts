import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteOnly } from "./helpers/backend";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-383-"));
const { all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { searchWorkspace, refreshSearchIndex, drainSearchIndex, SEARCH_LIMIT, MARK_START, MARK_END } = await import("../lib/search-index");

// The search (#383): candidates without snippets and page columns, the
// snippets of the returned hits only, the record icons in one query – the
// same results as before.
const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Sucher", "sucher@example.test");
const owner = { id: uid, name: "Sucher", email: "sucher@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Suche 383");
const space = (await bootstrap(owner, wid)).spaces[0];
const act = async (input: Record<string, unknown>) => (await command(owner, input)) as { id: string };
const pages: string[] = [];
for (let i = 0; i < 70; i++) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space.id, title: `Bericht ${String(i).padStart(2, "0")}`, kind: "document" })).id;
  await run(
    "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html",
    pageId,
    `<p>Einleitung ${"Text ".repeat(i)} und dann die Lieferkette im Absatz ${i}.</p>`,
  );
  pages.push(pageId);
}
const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: space.id, title: "Lieferungen", kind: "database" })).id;
const withIcon = (await act({ action: "row.create", pageId: dbId, cells: { title: "Lieferkette Nord" } })).id;
const plain = (await act({ action: "row.create", pageId: dbId, cells: { title: "Lieferkette Süd" } })).id;
await run("UPDATE rows SET icon=? WHERE id=?", "🚚", withIcon);
await refreshSearchIndex();
await drainSearchIndex();

test("at most SEARCH_LIMIT hits with their snippets, records with their icons", { skip: sqliteOnly }, async () => {
  const hits = await searchWorkspace(owner, wid, "Lieferkette");
  assert.equal(hits.length, SEARCH_LIMIT);
  const records = hits.filter((h) => h.kind === "row");
  assert.deepEqual(
    records.map((r) => [r.rowId, r.icon]).sort(),
    [
      [withIcon, "🚚"],
      [plain, ""],
    ].sort(),
  );
  // Every document hit has the snippet FTS5 gives its entry.
  const documents = hits.filter((h) => h.kind === "document");
  assert.ok(documents.length >= SEARCH_LIMIT - 2);
  const expected = new Map(
    (await all<{ page_id: string; snippet: string }>(
      "SELECT page_id,snippet(search_index,3,?,?,'…',40) snippet FROM search_index WHERE search_index MATCH ? AND row_id=''",
      MARK_START,
      MARK_END,
      '"Lieferkette"',
    )).map((r) => [r.page_id, r.snippet]),
  );
  for (const hit of documents) {
    assert.ok(hit.snippet.includes(MARK_START), hit.snippet);
    assert.equal(hit.snippet, expected.get(hit.id));
  }
  // Ranked as before: the records' titles start with the query.
  assert.deepEqual(hits.slice(0, 2).map((h) => h.kind), ["row", "row"]);
});

test("a title hit without the term in the text has no snippet", async () => {
  const hits = await searchWorkspace(owner, wid, "Bericht 07");
  assert.equal(hits[0]?.title, "Bericht 07");
  assert.equal(hits[0]?.snippet, "");
});

test("short queries and the kind filter still work", async () => {
  const short = await searchWorkspace(owner, wid, "Li");
  assert.ok(short.length > 0 && short.every((h) => h.snippet === ""));
  const rows = await searchWorkspace(owner, wid, "Lieferkette", { kind: "row" });
  assert.deepEqual(rows.map((r) => r.icon).sort(), ["", "🚚"]);
});
