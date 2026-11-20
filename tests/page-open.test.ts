// Opening a database in a worker thread (#383 wave 3, lib/page-open.ts):
// the answer is byte for byte the request thread's own (so its ETag is the
// same), presence and the visit stay with the request thread, and
// anything that is not the plain answer of a database is built as before.
// SQLite and PostgreSQL (DATABASE_URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-open-"));
process.env.FLOWPLAN_WORKERS = "2";
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database, pageData } = await import("../lib/api");
const { replaceRowDocument } = await import("../lib/row-documents");
const { withActivity } = await import("../lib/page-activity");
const { notePresence } = await import("../lib/page-presence");
const { withReadMemo } = await import("../lib/read-memo");
const { openDatabase } = await import("../lib/page-open");
const { contentTag } = await import("../lib/etag");
const { HttpError } = await import("../lib/auth");
const pool = await import("../lib/worker-pool");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await person("Inhaberin"),
  colleague = await person("Kollege"),
  stranger = await person("Fremd");
const wid = await createWorkspace(owner.id, "Büro");
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, colleague.id, "editor");
const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Team" })) as { id: string }).id;
const page = async (title: string, kind = "document") => ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind })) as { id: string }).id;
const table = await page("Aufgaben", "database"),
  doc = await page("Notizen");
const schema = await database(table);
await command(owner, { action: "database.update", pageId: table, version: schema.version, fields: [...schema.fields, { id: "amount", name: "Betrag", type: "number" }], views: schema.views });
await command(owner, { action: "rows.import", pageId: table, rows: Array.from({ length: 40 }, (_, i) => ({ [schema.fields[0].id]: `Aufgabe ${i} „Anführung“   ${"x".repeat(i)}`, amount: i })) });
const records = await (await import("../lib/db")).all<{ id: string }>("SELECT id FROM rows WHERE page_id=? ORDER BY position", table);
// A record document (its preview), a private record, a comment.
await replaceRowDocument(records[0].id, "<h2>Plan</h2><p>Mit Text.</p>", owner.id);
await run("UPDATE rows SET access='private' WHERE id=?", records[1].id);
await command(owner, { action: "comment.create", pageId: table, body: "Bitte prüfen" });
// A visit of the colleague (readers), someone present.
await withReadMemo(async () => await withActivity(colleague, await pageData(colleague, table), true));
await notePresence(table, colleague.id);
// The owner was there just before (so each answer below shows the same people).
await notePresence(table, owner.id);

// The answer as the route builds it on the request thread.
const here = async (person: Identity) => await withReadMemo(async () => JSON.stringify(await withActivity(person, await pageData(person, table, { presence: true }), true)));
// A started thread, as on a running server.
await pool.offThread("page.database", [owner, table, [], {}], async () => null);

const text = (opened: { body: Uint8Array }) => Buffer.from(opened.body).toString("utf8");
const ranInWorker = async <T>(fn: () => Promise<T>) => {
  const before = pool.workerPoolState().completed;
  const value = await fn();
  assert.equal(pool.workerPoolState().completed, before + 1, "built in a worker thread");
  return value;
};

test("the answer from the worker is byte for byte the request thread's", async () => {
  // An API token records no visit: both answers are of the same state.
  const reader = { ...owner, apiScope: "write" } as Identity;
  const expected = await here(reader);
  const opened = (await ranInWorker(() => withReadMemo(() => openDatabase(reader, table, true))))!;
  assert.equal(text(opened), expected);
  assert.equal(opened.etag, contentTag(expected));
  const data = JSON.parse(text(opened));
  assert.deepEqual(data.present.map((p: { id: string }) => p.id).sort(), [colleague.id, owner.id].sort());
  assert.equal(data.rows.length, 40);
  assert.ok(data.rows.some((r: { preview: { text?: string } }) => JSON.stringify(r.preview).includes("Mit Text")));
  assert.ok(data.readers.some((r: { id: string }) => r.id === colleague.id));
});

test("a person's visit is recorded and the rest equals the request thread's", async () => {
  // The visit changes what the next answer says about visits: compared without those.
  const strip = (json: string) => {
    const { sinceVisit: _s, readers, ...rest } = JSON.parse(json);
    return { ...rest, readers: readers.map(({ seenAt: _t, current: _c, ...r }: Record<string, unknown>) => r) };
  };
  const expected = strip(await here(colleague));
  const before = (await one<{ seen_at: number }>("SELECT seen_at FROM page_visits WHERE user_id=? AND page_id=?", colleague.id, table))!.seen_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const opened = (await ranInWorker(() => withReadMemo(() => openDatabase(colleague, table, true))))!;
  assert.deepEqual(strip(text(opened)), expected);
  assert.ok((await one<{ seen_at: number }>("SELECT seen_at FROM page_visits WHERE user_id=? AND page_id=?", colleague.id, table))!.seen_at > before);
  // Key order as on the request thread.
  assert.deepEqual(Object.keys(JSON.parse(text(opened))), Object.keys(JSON.parse(await here(colleague))));
});

test("a record preview to be made anew (a write): built on the request thread, then in the worker again", async () => {
  await replaceRowDocument(records[2].id, "<p>Neuer Text</p>", owner.id);
  const reader = { ...owner, apiScope: "write" } as Identity;
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  let first;
  try {
    first = (await withReadMemo(() => openDatabase(reader, table, true)))!;
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
  assert.ok(text(first).includes("Neuer Text"));
  // The preview is kept now: the next opening is the worker's again, the same bytes.
  const opened = (await ranInWorker(() => withReadMemo(() => openDatabase(reader, table, true))))!;
  assert.equal(text(opened), text(first));
});

test("backlinks written meanwhile: the request thread brings their table up to date, the worker builds the answer", async () => {
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><a href="/#page=${table}">Aufgaben</a></p>`, doc);
  assert.ok(await one("SELECT 1 FROM text_link_dirty LIMIT 1"), "the change is marked");
  const reader = { ...owner, apiScope: "write" } as Identity;
  // The worker's part never writes for it (it would run again here).
  await pool.offThread("page.database", [reader, table, [], {}], async () => {
    throw new Error("ran on the request thread");
  });
  assert.ok(await one("SELECT 1 FROM text_link_dirty LIMIT 1"), "still marked");
  const opened = (await ranInWorker(() => withReadMemo(() => openDatabase(reader, table, true))))!;
  assert.equal(await one("SELECT 1 FROM text_link_dirty LIMIT 1"), undefined);
  assert.ok(JSON.parse(text(opened)).backlinks.some((b: { id: string }) => b.id === doc));
  assert.equal(text(opened), await here(reader));
});

test("not a database or no access: as before; without workers on the request thread", async () => {
  assert.equal(await withReadMemo(() => openDatabase(owner, doc, true)), null);
  await assert.rejects(
    withReadMemo(() => openDatabase(stranger, table, true)),
    (e: unknown) => e instanceof HttpError && [403, 404].includes(e.status),
  );
  process.env.FLOWPLAN_WORKERS = "0";
  try {
    // Without workers: the same function on the request thread.
    const reader = { ...owner, apiScope: "write" } as Identity;
    const before = pool.workerPoolState().completed;
    assert.equal(text((await withReadMemo(() => openDatabase(reader, table, true)))!), await here(reader));
    assert.equal(pool.workerPoolState().completed, before);
  } finally {
    process.env.FLOWPLAN_WORKERS = "2";
  }
});

test.after(async () => {
  await pool.stopWorkers(Date.now() + 1000);
});
