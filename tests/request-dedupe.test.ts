// Fewer requests when a page or record opens (performance work): the record
// view's surroundings in one answer, the ticket prefixes once per page, no
// save of a document opened without changes, comment threads by the live
// channel's signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-dedupe-"));
const { id, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { recordContext, RECORD_CONTEXT_PARTS } = await import("../lib/record-context");
const { recordBacklinks } = await import("../lib/relation-backlinks");
const { relatedPages } = await import("../lib/related-pages");
const { recordPart } = await import("../lib/record-context-client");
const { ticketPrefixes } = await import("../lib/ticket-ref-plugin");
const { sameAsServer } = await import("../lib/yjs-compare");
const { documentKey, threadsChanged, watchDocument } = await import("../lib/document-live");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const outsiderId = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", outsiderId, outsiderId, "outsider", "outsider@test.invalid");
const outsider: Identity = { ...owner, id: outsiderId, name: "outsider", email: "outsider@test.invalid" };
const wid = await createWorkspace(owner.id, "Dedupe");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);

test("the record view's parts come in one answer, each as its own endpoint gives it", async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Tasks" })).id as string;
  const row = (await act({ action: "row.create", pageId: db, cells: { title: "Write the plan" } })).id as string;
  const context = await recordContext(owner, db, row);
  assert.deepEqual(context.failed, []);
  for (const part of RECORD_CONTEXT_PARTS) assert.ok(part in context, part);
  assert.deepEqual(context.backlinks, await recordBacklinks(owner, db, row));
  assert.deepEqual(context.related, await relatedPages(owner, db, row));
  assert.ok(Array.isArray((context.unlinked as { mentions: unknown[] }).mentions));
  assert.equal(context.issue, null);
  // Without access every part fails – the view then asks the endpoints, which refuse as before.
  const refused = await recordContext(outsider, db, row);
  assert.deepEqual([...refused.failed].sort(), [...RECORD_CONTEXT_PARTS].sort());
});

test("the parts of one record share one request; a failed part asks its own endpoint", async () => {
  let requests = 0;
  const load = async () => {
    requests++;
    return new Response(JSON.stringify({ backlinks: [{ id: "b" }], related: { items: [], semantic: false }, failed: ["issue"] }), { status: 200 });
  };
  const own = (value: unknown) => async () => value;
  assert.deepEqual(await recordPart("p", "r", "backlinks", own("own"), load), [{ id: "b" }]);
  assert.deepEqual(await recordPart("p", "r", "related", own("own"), load), { items: [], semantic: false });
  assert.equal(await recordPart("p", "r", "issue", own("own issue"), load), "own issue");
  assert.equal(await recordPart("p", "r", "ticketThread", own("own thread"), load), "own thread");
  assert.equal(requests, 1);
  // An older server without the endpoint: every part as before.
  const missing = async () => new Response("{}", { status: 404 });
  assert.equal(await recordPart("p", "other", "backlinks", own("own"), missing), "own");
});

test("ticket prefixes: one request per page for a while", async () => {
  let requests = 0;
  const load = async () => (requests++, [{ prefix: "WEB" }]);
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.deepEqual(await ticketPrefixes("page-a", now + i, load), [{ prefix: "WEB" }]);
  assert.equal(requests, 1);
  await ticketPrefixes("page-a", now + 61_000, load);
  assert.equal(requests, 2);
});

test("a document opened without changes of its own needs no save", () => {
  const server = new Y.Doc();
  server.getXmlFragment("default").insert(0, [new Y.XmlText("Hello")]);
  const state = Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64");
  // What IndexedDB kept is part of it already.
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
  Y.applyUpdate(local, Buffer.from(state, "base64"));
  assert.equal(sameAsServer(local, state), true);
  // A change kept on this device from before.
  (local.getXmlFragment("default").get(0) as Y.XmlText).insert(5, " world");
  assert.equal(sameAsServer(local, state), false);
  // A deletion only (same clocks of others, more deleted).
  const deleting = new Y.Doc();
  Y.applyUpdate(deleting, Y.encodeStateAsUpdate(server));
  (deleting.getXmlFragment("default").get(0) as Y.XmlText).delete(0, 1);
  assert.equal(sameAsServer(deleting, state), false);
  // No server state (content from HTML): saved as before.
  assert.equal(sameAsServer(new Y.Doc(), null), false);
});

test("a written comment thread signals the open editors of the page", async () => {
  const doc = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Commented" })).id as string;
  const events: string[] = [];
  const stop = watchDocument(documentKey(doc, null, "g1"), "tab", (e) => events.push(e));
  const other = watchDocument(documentKey(id(), null, "g1"), "tab", (e) => assert.ok(!e.includes('"threads"'), "another page"));
  try {
    threadsChanged(doc, null);
    assert.ok(events.some((e) => e.includes('"threads"')));
  } finally {
    stop();
    other();
  }
});
