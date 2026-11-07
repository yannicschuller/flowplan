import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-whiteboard-"),
);
const { id, run, one } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { searchWorkspace } = await import("../lib/search-index");
const { exportArchive, importArchive } = await import("../lib/archive");
const { whiteboardSnapshotItems } = await import("../lib/whiteboard");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.com`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.com`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  reader = await user("reader"),
  wid = await createWorkspace(owner.id, "Boards"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: any) => e.status === status);
const create = async (title: string, kind = "whiteboard") =>
  (
    (await command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title,
      kind,
    })) as { id: string }
  ).id;
// A client adds items to its own copy and sends the difference.
async function client(pageId: string, who = owner) {
  const data = (await pageData(who, pageId)) as any;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  let vector = Y.encodeStateVector(doc);
  return {
    doc,
    generation: data.whiteboard.generation as string,
    add(item: Record<string, unknown>) {
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(item)) map.set(k, v);
      const key = crypto.randomUUID();
      doc.getMap("items").set(key, map);
      return key;
    },
    async sync(cursor?: { x: number; y: number }) {
      const update = Y.encodeStateAsUpdate(doc, vector);
      vector = Y.encodeStateVector(doc);
      const result = (await command(who, {
        action: "whiteboard.sync",
        pageId,
        generation: this.generation,
        update: b64(update),
        ...(cursor ? { cursor } : {}),
      })) as { state: string; presence: { name: string }[] };
      Y.applyUpdate(doc, Buffer.from(result.state, "base64"));
      return result;
    },
  };
}

test("whiteboards merge edits of several people and are searchable", async () => {
  const board = await create("Retro");
  const a = await client(board),
    b = await client(board);
  a.add({
    type: "sticky",
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    z: 1,
    text: "Was lief gut",
  });
  b.add({
    type: "shape",
    shape: "ellipse",
    x: 300,
    y: 0,
    w: 120,
    h: 80,
    z: 2,
    text: "Kundenfeedback",
  });
  await a.sync({ x: 10, y: 20 });
  // Own cursors are not reported back.
  assert.deepEqual((await b.sync()).presence, []);
  await a.sync();
  const texts = (await whiteboardSnapshotItems(
    await one<any>("SELECT * FROM pages WHERE id=?", board),
  )).map((i) => i.text);
  assert.deepEqual(texts.sort(), ["Kundenfeedback", "Was lief gut"]);
  assert.equal(a.doc.getMap("items").size, 2);
  assert.ok(
    (await searchWorkspace(owner, wid, "Kundenfeedback")).some((r) => r.id === board),
  );
  // Readers see the board but cannot change it; stale generations are refused.
  const r = await client(board, reader);
  r.add({ type: "text", x: 0, y: 0, w: 10, h: 10, z: 3, text: "Nein" });
  fails(async () => await r.sync(), 403);
  const stale = await client(board);
  stale.generation = "old";
  fails(async () => await stale.sync(), 409);
});

test("whiteboards are copied, archived and restored with their items", async () => {
  const doc = await create("Ziel", "document");
  const board = await create("Plan");
  const c = await client(board);
  c.add({ type: "card", pageId: doc, x: 0, y: 0, w: 280, h: 80, z: 1 });
  c.add({
    type: "sticky",
    x: 0,
    y: 200,
    w: 200,
    h: 200,
    z: 2,
    text: "Schritt 1",
  });
  await c.sync();
  // Page copies keep the board.
  const copy = (
    (await command(owner, { action: "page.duplicate", pageId: board })) as {
      id: string;
    }
  ).id;
  const copied = await whiteboardSnapshotItems(
    await one<any>("SELECT * FROM pages WHERE id=?", copy),
  );
  assert.equal(copied.length, 2);
  assert.ok(copied.some((i) => i.text === "Schritt 1"));
  // Archives carry the board and map linked pages.
  const dest = await createWorkspace(owner.id, "Kopie");
  const imported = await importArchive(
    owner,
    dest,
    await exportArchive(owner, wid),
  );
  const restored = imported.pageIds[board];
  const items = await whiteboardSnapshotItems(
    await one<any>("SELECT * FROM pages WHERE id=?", restored),
  );
  assert.equal(
    items.find((i) => i.type === "card")?.pageId,
    imported.pageIds[doc],
  );
  // A saved version brings the old state back under a new generation.
  const before = ((await pageData(owner, board)) as any).whiteboard.generation;
  await run("DELETE FROM snapshots WHERE page_id=?", board);
  c.add({ type: "sticky", x: 0, y: 500, w: 200, h: 200, z: 3, text: "Später" });
  await c.sync();
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    board,
  ))!;
  await command(owner, {
    action: "snapshot.restore",
    pageId: board,
    snapshotId: snapshot.id,
  });
  const after = (await pageData(owner, board)) as any;
  assert.notEqual(after.whiteboard.generation, before);
  assert.ok(
    !(await whiteboardSnapshotItems(after.page)).some((i) => i.text === "Später"),
  );
});
