// Long CPU work in worker threads (lib/worker-pool.ts, #383 #14): every
// moved job gives what it gives on the request thread, the event loop
// keeps turning meanwhile, audit entries are written by the request
// thread, errors keep their HTTP status, and the queue, timeouts and the
// shutdown are bounded. SQLite and PostgreSQL (DATABASE_URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-worker-pool-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_WORKERS = "2";
const { run, id, one, all, transaction } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { writeWhiteboard } = await import("../lib/whiteboard");
const { exportDocx } = await import("../lib/export-docx");
const { exportEpub } = await import("../lib/export-epub");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { exportJira } = await import("../lib/export-jira");
const { exportConfluence } = await import("../lib/export-confluence");
const { exportMarkdown } = await import("../lib/markdown-export");
const { parseImportOffThread } = await import("../lib/importers/parse-transfer");
const { HttpError } = await import("../lib/auth");
const { z } = await import("zod");
const pool = await import("../lib/worker-pool");
const { readExportZip } = await import("./helpers/read-export-zip");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await person("Autorin"),
  stranger = await person("Fremd");
const wid = await createWorkspace(owner.id, "Werkstatt");
const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Handbuch" })) as { id: string }).id;
const page = async (title: string, kind = "document", parentId?: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind, parentId })) as { id: string }).id;
const write = async (pageId: string, html: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 40, 0, 0, 0, 20, 8, 6, 0, 0, 0]), Buffer.from("pixels")]);
const fid = id();
const root = await page("Wurzel"),
  child = await page("Kapitel", "document", root),
  table = await page("Tabelle", "database", root),
  board = await page("Skizze", "whiteboard", root),
  unopened = await page("Leer", "whiteboard", root);
mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), png);
await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, root, "bild.png", "image/png", png.length, owner.id);
const long = Array.from({ length: 400 }, (_, i) => `<p>Absatz ${i} mit <strong>fett</strong> und <a href="https://example.org/${i}">Link</a>.</p>`).join("");
await write(
  root,
  `<h2>Einführung</h2><p>Siehe <a href="/#page=${child}">Kapitel</a><sup data-footnote="Notiz"></sup></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt</p></li></ul>` +
    `<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table><img src="/api/files/${fid}" alt="Bild">` +
    `<pre><code class="language-js">const x = 1;</code></pre><div data-whiteboard="${board}" data-whiteboard-height="300"></div><div data-whiteboard="${unopened}" data-whiteboard-height="300"></div>` +
    long,
);
await write(child, `<p>Kapiteltext mit <mark>Markierung</mark>.</p>`);
const schema = await database(table);
await command(owner, { action: "database.update", pageId: table, version: schema.version, fields: [...schema.fields, { id: "amount", name: "Betrag", type: "number" }], views: schema.views });
await command(owner, { action: "rows.import", pageId: table, rows: Array.from({ length: 50 }, (_, i) => ({ [schema.fields[0].id]: `Eintrag ${i}`, amount: i })) });
{
  const doc = new Y.Doc();
  const items = doc.getMap<Y.Map<unknown>>("items");
  const note = new Y.Map<unknown>();
  for (const [key, value] of Object.entries({ type: "note", x: 10, y: 20, w: 160, h: 90, text: "Idee", color: "yellow" })) note.set(key, value);
  items.set("n1", note);
  await writeWhiteboard(board, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

// Timestamps of the moment of the export (ZIP metadata, EPUB/Word properties).
const stamp = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
async function zipText(bytes: Buffer) {
  const entries = await readExportZip(bytes);
  return Object.fromEntries([...entries].map(([name, data]) => [name, /\.(png|jpe?g|gif|webp|pdf)$/.test(name) ? data.toString("base64") : stamp(data.toString("utf8"))]));
}
async function inThread<T>(fn: () => Promise<T>): Promise<T> {
  process.env.FLOWPLAN_WORKERS = "0";
  try {
    return await fn();
  } finally {
    process.env.FLOWPLAN_WORKERS = "2";
  }
}
async function inWorker<T>(fn: () => Promise<T>): Promise<T> {
  const before = pool.workerPoolState().completed;
  const value = await fn();
  assert.equal(pool.workerPoolState().completed, before + 1, "the job ran in a worker thread");
  return value;
}
const audits = async (action: string) => (await all<{ actor_id: string }>("SELECT actor_id FROM audit WHERE action=?", action)).length;

test("the number of threads follows FLOWPLAN_WORKERS, else the cores minus one", () => {
  assert.equal(pool.workerCount({}, 8), 7);
  assert.equal(pool.workerCount({}, 2), 1);
  assert.equal(pool.workerCount({}, 1), 1);
  assert.equal(pool.workerCount({ FLOWPLAN_WORKERS: "3" }, 8), 3);
  assert.equal(pool.workerCount({ FLOWPLAN_WORKERS: "0" }, 8), 0);
  assert.equal(pool.workerCount({ FLOWPLAN_WORKERS: "1000" }, 8), 32);
  assert.equal(pool.workerCount({ FLOWPLAN_WORKERS: "zwei" }, 4), 3);
  assert.equal(pool.workerCount({ FLOWPLAN_WORKERS: "-1" }, 4), 3);
});

test("every moved export gives in the worker what it gives on the request thread", async () => {
  const markdownZip = { spaceId: space, format: "zip" as const, includeSubpages: true, history: true };
  const markdownFile = { pageId: root, format: "markdown" as const, includeSubpages: false };
  const record = (await all<{ id: string }>("SELECT id FROM rows WHERE page_id=? ORDER BY position LIMIT 1", table))[0].id;
  const cases: [string, () => Promise<unknown>, (value: unknown) => Promise<unknown>][] = [
    ["markdown zip", () => exportMarkdown(owner, markdownZip), async (r) => ({ ...(r as object), bytes: await zipText((r as { bytes: Buffer }).bytes) })],
    ["markdown file", () => exportMarkdown(owner, markdownFile), async (r) => ({ ...(r as object), bytes: (r as { bytes: Buffer }).bytes.toString("utf8") })],
    ["docx", () => exportDocx(owner, { pageId: root }), async (r) => ({ ...(r as object), bytes: await zipText((r as { bytes: Buffer }).bytes) })],
    ["docx record", () => exportDocx(owner, { pageId: table, rowId: record }), async (r) => ({ ...(r as object), bytes: await zipText((r as { bytes: Buffer }).bytes) })],
    ["epub", () => exportEpub(owner, { spaceId: space }), async (r) => ({ ...(r as object), bytes: await zipText((r as { bytes: Buffer }).bytes) })],
    ["print", () => exportPrintHtml(owner, { pageId: root, children: true }), async (r) => ({ ...(r as object), html: stamp((r as { html: string }).html) })],
    ["jira", () => exportJira(owner, { pageId: root }), async (r) => ({ ...(r as object), bytes: (r as { bytes: Buffer }).bytes.toString("utf8") })],
    ["confluence", () => exportConfluence(owner, { pageId: root }), async (r) => ({ ...(r as object), bytes: (r as { bytes: Buffer }).bytes.toString("utf8") })],
  ];
  for (const [name, job, normalise] of cases) {
    const here = await normalise(await inThread(job));
    const there = await inWorker(job);
    for (const value of Object.values(there as object)) if (value instanceof Uint8Array) assert.ok(Buffer.isBuffer(value), `${name}: bytes come back as a Buffer`);
    assert.deepEqual(await normalise(there), here, name);
  }
  // The whiteboard that was never opened stays without a row (nothing written by the export).
  assert.equal(await one("SELECT page_id FROM whiteboards WHERE page_id=?", unopened), undefined);
});

test("reading an import gives the same tree in the worker", async () => {
  const { bytes } = await inThread(() => exportMarkdown(owner, { spaceId: space, format: "zip", includeSubpages: true }));
  const plain = (tree: Awaited<ReturnType<typeof parseImportOffThread>>) =>
    JSON.parse(
      JSON.stringify({ ...tree, files: [...tree.files].map(([key, file]) => [key, { ...file, data: "data" in file ? file.data.toString("base64") : null }]), report: tree.report ? { entries: tree.report.entries, counts: tree.report.counts } : null }),
    );
  const here = plain(await inThread(() => parseImportOffThread("handbuch.zip", bytes, "obsidian")));
  const there = plain(await inWorker(() => parseImportOffThread("handbuch.zip", bytes, "obsidian")));
  assert.ok(here.pages.length >= 3);
  assert.deepEqual(there, here);
  // An upload on disk is read by the worker itself.
  const file = join(process.env.FLOWPLAN_DATA_DIR!, "upload.zip");
  writeFileSync(file, bytes);
  assert.deepEqual(plain(await inWorker(() => parseImportOffThread("handbuch.zip", { path: file }, "obsidian"))), here);
  // A broken file fails as on the request thread: 400.
  await assert.rejects(inWorker(() => parseImportOffThread("kaputt.zip", Buffer.from("PK\u0003\u0004 kaputt"), "obsidian")), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("the event loop keeps turning while a large export runs in a worker", async () => {
  for (let i = 0; i < 12; i++) await write(await page(`Lang ${i}`, "document", root), long + long);
  let longest = 0,
    last = performance.now(),
    watching = true;
  const watch = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (watching) setImmediate(watch);
  };
  // A warm thread (its modules loaded), as on a running server.
  await exportJira(owner, { pageId: child });
  setImmediate(watch);
  const started = performance.now();
  const result = await exportMarkdown(owner, { spaceId: space, format: "zip", includeSubpages: true });
  const took = performance.now() - started;
  watching = false;
  assert.ok(result.bytes.length > 1000);
  assert.ok(longest < Math.max(150, took / 4), `event loop held ${longest.toFixed(0)} ms of ${took.toFixed(0)} ms`);
});

test("audit entries of a worker's job are written by the request thread, once", async () => {
  const before = await audits("page.jira.export");
  await inWorker(() => exportJira(owner, { pageId: child }));
  assert.equal(await audits("page.jira.export"), before + 1);
  const space0 = await audits("space.markdown.export");
  await inWorker(() => exportMarkdown(owner, { spaceId: space, format: "zip", includeSubpages: false }));
  assert.equal(await audits("space.markdown.export"), space0 + 1);
});

test("errors keep their status: no access is 403/404 as on the request thread", async () => {
  const status = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 200;
    } catch (e) {
      assert.ok(e instanceof HttpError, String(e));
      return [e.status, e.message];
    }
  };
  for (const job of [() => exportDocx(stranger, { pageId: root }), () => exportEpub(stranger, { spaceId: space }), () => exportMarkdown(stranger, { spaceId: space, format: "zip", includeSubpages: true })]) {
    const here = await inThread(() => status(job));
    assert.notEqual(here, 200);
    assert.deepEqual(await status(job), here);
  }
  // Errors cross the thread with their kind.
  const http = pool.reviveError(pool.serializeError(new HttpError(413, "Zu groß.")));
  assert.ok(http instanceof HttpError && http.status === 413 && http.message === "Zu groß.");
  const zod = pool.reviveError(pool.serializeError(z.object({ a: z.string() }).safeParse({ a: 1 }).error));
  assert.ok(zod instanceof z.ZodError && zod.issues[0].path[0] === "a");
  const other = pool.reviveError(pool.serializeError(new TypeError("kaputt")));
  assert.ok(!(other instanceof HttpError) && other.message === "kaputt");
  assert.equal(pool.serializeError(new Error("attempt to write a readonly database")).kind, "write");
});

test("inside a transaction the work stays on the request thread (it sees the uncommitted writes)", async () => {
  const before = pool.workerPoolState().completed;
  const text = await transaction(async () => {
    await run("UPDATE pages SET title=? WHERE id=?", "Ungespeichert", child);
    const result = await exportJira(owner, { pageId: child });
    throw Object.assign(new Error("rollback"), { result });
  }).catch((e: { result: { name: string } }) => e.result);
  assert.equal(text.name, "Ungespeichert.jira.txt");
  assert.equal(pool.workerPoolState().completed, before);
});

const fake = new URL("./helpers/fake-worker.mjs", import.meta.url);
const job = (what: object, here: () => Promise<unknown> = async () => "here", timeoutMs?: number) => pool.offThread("export.docx", [what], here, { timeoutMs });

test("the queue is bounded, a job over its time ends its thread, a write runs on the request thread", async (t) => {
  await pool.resetWorkerPool(fake);
  process.env.FLOWPLAN_WORKERS = "1";
  t.after(async () => {
    process.env.FLOWPLAN_WORKERS = "2";
    await pool.resetWorkerPool();
  });
  // Results come back with Buffers, audit entries are written here.
  const audited = await audits("test.worker");
  const value = (await job({ echo: "hallo", audit: [owner.id, "test.worker", root, ""] })) as { echo: string; bytes: Buffer };
  assert.equal(value.echo, "hallo");
  assert.ok(Buffer.isBuffer(value.bytes) && value.bytes.equals(Buffer.from([1, 2, 3])));
  assert.equal(await audits("test.worker"), audited + 1);
  // One thread: one runs, 16 wait, the next is refused with 503.
  const running = Array.from({ length: 1 + pool.QUEUE_PER_WORKER }, (_, i) => job({ sleep: 30, echo: i }));
  await assert.rejects(job({ echo: "zu viel" }), (e: unknown) => e instanceof HttpError && e.status === 503 && e.message === pool.BUSY_MESSAGE);
  assert.deepEqual(((await Promise.all(running)) as { echo: number }[]).map((r) => r.echo), [...Array(1 + pool.QUEUE_PER_WORKER).keys()]);
  // Over its time: an error (500 in the routes), the thread ends, the next job gets a new one.
  const started = pool.workerPoolState().started;
  await assert.rejects(job({ hang: true }, undefined, 200), (e: unknown) => e instanceof Error && !(e instanceof HttpError) && e.message === pool.TIMEOUT_MESSAGE);
  assert.equal(((await job({ echo: "weiter" })) as { echo: string }).echo, "weiter");
  assert.equal(pool.workerPoolState().started, started + 1);
  // HttpError and ZodError keep their kind; a thread that ends fails its job only.
  await assert.rejects(job({ http: [404, "Seite nicht gefunden."] }), (e: unknown) => e instanceof HttpError && e.status === 404);
  await assert.rejects(job({ zod: true }), (e: unknown) => e instanceof z.ZodError);
  await assert.rejects(job({ exit: true }), (e: unknown) => e instanceof Error && !(e instanceof HttpError));
  assert.equal(((await job({ echo: "danach" })) as { echo: string }).echo, "danach");
  // A job that tried to write runs again on the request thread.
  assert.equal(await job({ write: true }, async () => "auf dem Anfrage-Thread"), "auf dem Anfrage-Thread");
});

test("on shutdown waiting jobs are refused with 503, the running one may finish", async (t) => {
  await pool.resetWorkerPool(fake);
  process.env.FLOWPLAN_WORKERS = "1";
  t.after(async () => {
    process.env.FLOWPLAN_WORKERS = "2";
    await pool.resetWorkerPool();
  });
  const running = job({ sleep: 150, echo: "fertig" });
  const waiting = job({ echo: "wartet" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopped = pool.stopWorkers(Date.now() + 5000);
  await assert.rejects(waiting, (e: unknown) => e instanceof HttpError && e.status === 503 && e.message === pool.STOPPING_MESSAGE);
  await assert.rejects(job({ echo: "neu" }), (e: unknown) => e instanceof HttpError && e.status === 503);
  assert.equal(((await running) as { echo: string }).echo, "fertig");
  await stopped;
  assert.equal(pool.workerPoolState().threads, 0);
});

test("without a worker script the jobs run on the request thread", async (t) => {
  await pool.resetWorkerPool(new URL("./helpers/does-not-exist.mjs", import.meta.url));
  t.after(async () => await pool.resetWorkerPool());
  assert.equal(await job({ echo: "x" }, async () => "hier"), "hier");
  assert.equal(pool.workerPoolState().broken, true);
  assert.equal(await job({ echo: "y" }, async () => "wieder hier"), "wieder hier");
  // FLOWPLAN_WORKERS=0: no thread at all.
  await pool.resetWorkerPool(fake);
  process.env.FLOWPLAN_WORKERS = "0";
  try {
    assert.equal(await job({ echo: "z" }, async () => "aus"), "aus");
    assert.equal(pool.workerPoolState().started, 0);
  } finally {
    process.env.FLOWPLAN_WORKERS = "2";
  }
});
