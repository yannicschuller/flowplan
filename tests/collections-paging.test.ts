// Collections with more than one page of results (#270): `offset` and
// `nextOffset` reach every match exactly once, in a stable order, after the
// reader's own permissions are applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-collections-paging-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database: schemaOf } = await import("../lib/api");
const { runCollection, previewQuery, COLLECTION_RESULTS } = await import("../lib/collections");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Anna"),
  viewer = await account("Vera");
const wid = await createWorkspace(owner.id, "Archiv");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
type Result = { id: string } & Record<string, unknown>;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const team = (await bootstrap(owner, wid)).spaces[0].id;
const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Belege", kind: "database" })).id;
const titleField = (await schemaOf(dbId)).fields[0].id;

// 1,234 records; groups of 40 share one change time (ties), so the order
// has to be broken by something stable.
const COUNT = 1234;
const rowIds: string[] = [];
for (let n = 0; n < COUNT; n++) {
  const rid = id();
  rowIds.push(rid);
  const at = new Date(Date.UTC(2026, 0, 1) + Math.floor(n / 40) * 60_000).toISOString().replace("T", " ").slice(0, 19);
  await run(
    "INSERT INTO rows(id,page_id,cells,position,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)",
    rid,
    dbId,
    JSON.stringify({ [titleField]: `Beleg ${n}` }),
    n,
    at,
    at,
    owner.id,
    owner.id,
  );
}
// 37 of them private: the viewer must not see them, nor count them.
const hidden = rowIds.filter((_, n) => n % 33 === 5);
for (const rowId of hidden) await act({ action: "row.access", pageId: dbId, rowId, access: "private", grants: [] });
const collectionId = (await act({ action: "collection.create", workspaceId: wid, name: "Alle Belege", query: "type:record" })).id;
await act({ action: "collection.update", collectionId, shared: true });

type Page = Awaited<ReturnType<typeof runCollection>>;
const keyOf = (i: Page["items"][number]) => `${i.pageId}:${i.rowId ?? ""}`;
async function everyPage(as: Identity, limit?: number) {
  const pages: Page[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: Page = await runCollection(as, collectionId, { offset, ...(limit ? { limit } : {}) });
    pages.push(page);
    offset = page.nextOffset;
    assert.ok(pages.length < 100, "paging ends");
  }
  return pages;
}

test("the first page stays at 500 and says how to get the rest", async () => {
  const first = await runCollection(owner, collectionId);
  assert.equal(COLLECTION_RESULTS, 500);
  assert.equal(first.items.length, 500);
  assert.equal(first.total, COUNT);
  assert.equal(first.offset, 0);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 500);
});

test("following nextOffset reaches every match once, in the order of one big request", async () => {
  const pages = await everyPage(owner);
  assert.deepEqual(
    pages.map((p) => p.items.length),
    [500, 500, COUNT - 1000],
  );
  assert.deepEqual(
    pages.map((p) => [p.offset, p.truncated, p.nextOffset]),
    [
      [0, true, 500],
      [500, true, 1000],
      [1000, false, null],
    ],
  );
  const keys = pages.flatMap((p) => p.items.map(keyOf));
  assert.equal(new Set(keys).size, COUNT, "no duplicates");
  assert.deepEqual(new Set(keys), new Set(rowIds.map((r) => `${dbId}:${r}`)), "no gaps");
  const all = await runCollection(owner, collectionId, { limit: 5000 });
  assert.equal(all.truncated, false);
  assert.deepEqual(keys, all.items.map(keyOf), "same order as at once");
  // Latest change first.
  const times = all.items.map((i) => i.updatedAt ?? "");
  assert.deepEqual(times, [...times].sort().reverse());
});

test("the order is stable across requests, also for equal change times", async () => {
  const a = (await everyPage(owner, 77)).flatMap((p) => p.items.map(keyOf));
  const b = (await everyPage(owner, 500)).flatMap((p) => p.items.map(keyOf));
  assert.equal(a.length, COUNT);
  assert.deepEqual(a, b);
});

test("permissions are applied before paging: counts and pages agree", async () => {
  const pages = await everyPage(viewer);
  const visible = COUNT - hidden.length;
  for (const p of pages) assert.equal(p.total, visible);
  assert.deepEqual(
    pages.map((p) => p.items.length),
    [500, 500, visible - 1000],
  );
  const keys = pages.flatMap((p) => p.items.map(keyOf));
  assert.equal(new Set(keys).size, visible);
  for (const rowId of hidden) assert.ok(!keys.includes(`${dbId}:${rowId}`), "a private record stays hidden");
});

test("an offset past the end is an empty last page; the preview stays at 50", async () => {
  const past = await runCollection(owner, collectionId, { offset: 5000 });
  assert.deepEqual([past.items.length, past.total, past.truncated, past.nextOffset], [0, COUNT, false, null]);
  const preview = await previewQuery(owner, wid, "type:record", { offset: 900 });
  assert.equal(preview.items.length, 50);
  assert.equal(preview.offset, 0);
  assert.equal(preview.nextOffset, 50);
});
