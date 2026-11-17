// Whiteboard sync with the state vector (performance work): a board that
// sends its vector gets only what it lacks, older clients still the whole
// state; a change signals everyone on the board once it has committed,
// except the browser that wrote it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wbdiff-"));
const { id, run } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { watchBoard } = await import("../lib/whiteboard-presence");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(owner.id, "Boards");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" })) as { id: string }).id;

async function client() {
  const data = (await pageData(owner, pageId)) as { whiteboard: { state: string; generation: string } };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  let sent = Y.encodeStateVector(doc);
  const tag = crypto.randomUUID();
  return {
    doc,
    tag,
    add(text: string) {
      const map = new Y.Map<unknown>();
      map.set("type", "sticky");
      map.set("text", text);
      map.set("x", 0);
      map.set("y", 0);
      doc.getMap("items").set(crypto.randomUUID(), map);
    },
    async sync(withVector = true) {
      const vector = Y.encodeStateVector(doc);
      const update = Y.encodeStateAsUpdate(doc, sent);
      sent = vector;
      const result = (await command(owner, {
        action: "whiteboard.sync",
        pageId,
        generation: data.whiteboard.generation,
        update: b64(update),
        ...(withVector ? { vector: b64(vector), client: tag } : {}),
      })) as { state: string };
      const bytes = Buffer.from(result.state, "base64");
      Y.applyUpdate(doc, bytes, "remote");
      return bytes.length;
    },
  };
}

test("with the state vector only the difference comes back", async () => {
  const a = await client(),
    b = await client();
  for (let i = 0; i < 80; i++) a.add(`Note ${i} ${"x".repeat(200)}`);
  await a.sync();
  // b lacks everything: a full answer.
  const first = await b.sync();
  assert.ok(first > 16_000, `${first} bytes`);
  assert.equal(b.doc.getMap("items").size, 80);
  // Nothing new: a few bytes instead of the whole board.
  const idle = await b.sync();
  assert.ok(idle < 64, `${idle} bytes`);
  // An older client without a vector: still the whole state.
  assert.ok((await b.sync(false)) > 16_000);
  // One new note: about its size.
  a.add("One more");
  await a.sync();
  const one = await b.sync();
  assert.ok(one < 400, `${one} bytes`);
  assert.equal(b.doc.getMap("items").size, 81);
  assert.deepEqual(b.doc.getMap("items").toJSON(), a.doc.getMap("items").toJSON());
});

test("a change signals the others on the board, not the writer", async () => {
  const a = await client();
  const events: { type: string; from?: string }[] = [];
  const stop = watchBoard(pageId, "watcher", (chunk) => {
    const m = /^data: (.*)\n\n$/s.exec(chunk);
    if (m) events.push(JSON.parse(m[1]));
  });
  try {
    await a.sync();
    assert.equal(events.filter((e) => e.type === "changed").length, 0, "nothing changed, no signal");
    a.add("Signal me");
    await a.sync();
    const changed = events.filter((e) => e.type === "changed");
    assert.equal(changed.length, 1);
    // The writer recognises its own change by its id and does not ask again.
    assert.equal(changed[0].from, a.tag);
  } finally {
    stop();
  }
});
