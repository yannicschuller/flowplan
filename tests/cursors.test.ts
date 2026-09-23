import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import {
  cursorRequestSchema,
  relativePositionSchema,
  CURSOR_LEASE_MS,
} from "../lib/cursor-protocol";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-cursors-"),
);
const { run, one, id } = await import("../lib/db");
const { editorPresence } = await import("../lib/editor-presence");
const { HttpError } = await import("../lib/auth");
const position = { tname: "default" as const, item: null, assoc: 0 };
const cursor = { anchor: position, head: position };
function fixture() {
  const now = Date.now(),
    workspace = id(),
    space = id(),
    page = id(),
    row = id(),
    database = id();
  const user = (name: string) => {
    const uid = id(),
      token = id();
    run(
      "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
      uid,
      uid,
      name,
      `${uid}@test.invalid`,
    );
    run(
      "INSERT INTO sessions VALUES(?,?,?,?)",
      token,
      uid,
      "[]",
      now + 1000000,
    );
    return {
      token,
      identity: {
        id: uid,
        name,
        email: "",
        created_at: "",
        disabled: 0,
        groups: [],
        isAdmin: false,
      } as Identity,
    };
  };
  const alice = user("Alice <script>"),
    bob = user("Bob");
  run(
    "INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)",
    workspace,
    "Cursor tests",
    alice.identity.id,
  );
  for (const u of [alice, bob])
    run(
      "INSERT INTO members VALUES(?,?,?)",
      workspace,
      u.identity.id,
      "editor",
    );
  run(
    "INSERT INTO spaces(id,workspace_id,name,owner_id) VALUES(?,?,?,?)",
    space,
    workspace,
    "Team",
    alice.identity.id,
  );
  for (const [pid, kind] of [
    [page, "document"],
    [database, "database"],
  ])
    run(
      "INSERT INTO pages(id,workspace_id,space_id,title,kind) VALUES(?,?,?,?,?)",
      pid,
      workspace,
      space,
      "Test",
      kind,
    );
  run(
    "INSERT INTO documents(page_id,state,html,generation) VALUES(?,?,?,?)",
    page,
    new Uint8Array(),
    "<p>Original</p>",
    "g1",
  );
  run("INSERT INTO rows(id,page_id,cells) VALUES(?,?,?)", row, database, "{}");
  run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
    row,
    new Uint8Array(),
    "<p>Row</p>",
    "r1",
  );
  const request = (extra = {}) => ({
    pageId: page,
    generation: "g1",
    clientId: id(),
    sequence: 1,
    cursor,
    ...extra,
  });
  const send = (u: typeof alice, input: unknown, time = now) =>
    editorPresence(u.identity, u.token, input, time);
  return {
    now,
    workspace,
    space,
    page,
    database,
    row,
    alice,
    bob,
    request,
    send,
  };
}
test("cursor protocol accepts real Yjs positions and bounds untrusted input", () => {
  const doc = new Y.Doc(),
    fragment = doc.getXmlFragment("default"),
    text = new Y.XmlText();
  fragment.insert(0, [text]);
  text.insert(0, "hello");
  for (const p of [
    Y.createRelativePositionFromTypeIndex(fragment, 0),
    Y.createRelativePositionFromTypeIndex(text, 2),
  ])
    assert.equal(
      relativePositionSchema.safeParse(Y.relativePositionToJSON(p)).success,
      true,
    );
  for (const p of [
    {},
    { tname: "secret" },
    { ...position, type: { client: 1, clock: 2 } },
    { type: { client: -1, clock: 0 } },
    { ...position, extra: "x" },
  ])
    assert.equal(relativePositionSchema.safeParse(p).success, false);
  const f = fixture();
  for (const extra of [
    { name: "Spoof" },
    { sequence: 1.5 },
    { sequence: Infinity },
    { clientId: "bad" },
    { generation: "x".repeat(129) },
  ])
    assert.equal(
      cursorRequestSchema.safeParse(f.request(extra)).success,
      false,
    );
  doc.destroy();
});
test("relative selection stays attached when a second Yjs replica inserts before it", () => {
  const a = new Y.Doc(),
    b = new Y.Doc(),
    t = a.getText("default");
  t.insert(0, "one two three");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const anchor = Y.createRelativePositionFromTypeIndex(t, 4),
    head = Y.createRelativePositionFromTypeIndex(t, 7);
  b.getText("default").insert(0, "new ");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  const from = Y.createAbsolutePositionFromRelativePosition(anchor, a)!.index,
    to = Y.createAbsolutePositionFromRelativePosition(head, a)!.index;
  assert.equal(t.toString().slice(from, to), "two");
  assert.equal(from, 8);
  a.destroy();
  b.destroy();
});
test("server derives identity, isolates sessions and preserves independent tabs", () => {
  const f = fixture(),
    a = f.request(),
    b = f.request({ clientId: a.clientId });
  f.send(f.alice, a);
  const result = f.send(f.bob, b);
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0].name, "Alice <script>");
  assert.equal(result.peers[0].userId, f.alice.identity.id);
  assert.equal(JSON.stringify(result).includes(f.alice.token), false);
  assert.equal(f.send(f.alice, f.request()).peers.length, 2);
  assert.throws(
    () => editorPresence(f.alice.identity, f.bob.token, a),
    (e) => e instanceof HttpError && e.status === 401,
  );
});
test("stale requests and departures cannot resurrect cursors; leases expire", () => {
  const f = fixture(),
    a = f.request(),
    b = f.request({ cursor: null });
  f.send(f.alice, a);
  assert.equal(f.send(f.bob, b).peers.length, 1);
  f.send(f.alice, { ...a, sequence: 3, cursor: null });
  f.send(f.alice, { ...a, sequence: 2 }, f.now + 1);
  assert.equal(f.send(f.bob, { ...b, sequence: 2 }, f.now + 2).peers.length, 0);
  f.send(f.alice, { ...a, sequence: 4 });
  assert.equal(
    f.send(f.bob, { ...b, sequence: 3 }, f.now + CURSOR_LEASE_MS).peers.length,
    0,
  );
});
test("fresh page rights and live session status govern both publishing and receiving", () => {
  const f = fixture(),
    a = f.request(),
    b = f.request({ cursor: null });
  f.send(f.alice, a);
  run("UPDATE users SET disabled=1 WHERE id=?", f.alice.identity.id);
  assert.equal(f.send(f.bob, b).peers.length, 0);
  assert.throws(() => f.send(f.alice, a), HttpError);
  run("UPDATE users SET disabled=0 WHERE id=?", f.alice.identity.id);
  run(
    "DELETE FROM members WHERE workspace_id=? AND user_id=?",
    f.workspace,
    f.alice.identity.id,
  );
  assert.equal(f.send(f.bob, { ...b, sequence: 2 }).peers.length, 0);
  assert.throws(() => f.send(f.alice, a), HttpError);
  run(
    "INSERT INTO members VALUES(?,?,?)",
    f.workspace,
    f.alice.identity.id,
    "viewer",
  );
  assert.equal(f.send(f.bob, { ...b, sequence: 3 }).peers.length, 1);
  run("DELETE FROM sessions WHERE token=?", f.alice.token);
  assert.equal(f.send(f.bob, { ...b, sequence: 4 }).peers.length, 0);
  assert.equal(
    one("SELECT id FROM editor_presence WHERE session_token=?", f.alice.token),
    undefined,
  );
});
test("private pages, generations, rows and tabs have disjoint scopes", () => {
  const f = fixture(),
    a = f.request();
  f.send(f.alice, a);
  run("UPDATE spaces SET visibility='private' WHERE id=?", f.space);
  assert.throws(() => f.send(f.bob, f.request()), HttpError);
  run("UPDATE spaces SET visibility='team' WHERE id=?", f.space);
  const rowRequest = f.request({
    pageId: f.database,
    rowId: f.row,
    generation: "r1",
  });
  assert.equal(f.send(f.bob, rowRequest).peers.length, 0);
  assert.throws(() => f.send(f.bob, f.request({ rowId: f.row })), HttpError);
  assert.throws(
    () =>
      f.send(f.alice, {
        ...a,
        pageId: f.database,
        rowId: f.row,
        generation: "r1",
        sequence: 2,
      }),
    HttpError,
  );
  run("UPDATE documents SET generation='g2' WHERE page_id=?", f.page);
  assert.throws(() => f.send(f.alice, { ...a, sequence: 2 }), HttpError);
  assert.equal(f.send(f.bob, f.request({ generation: "g2" })).peers.length, 0);
  run("DELETE FROM rows WHERE id=?", f.row);
  assert.equal(
    one("SELECT id FROM editor_presence WHERE row_id=?", f.row),
    undefined,
  );
});
test("cursor heartbeats never alter content or create snapshots or audit records", () => {
  const f = fixture(),
    before = one("SELECT * FROM documents WHERE page_id=?", f.page),
    a = f.request();
  const count = () =>
    one(
      "SELECT (SELECT count(*) FROM snapshots)+(SELECT count(*) FROM audit) n",
    )!.n;
  const n = count();
  for (let sequence = 1; sequence < 20; sequence++)
    f.send(f.alice, { ...a, sequence });
  assert.deepEqual(
    one("SELECT * FROM documents WHERE page_id=?", f.page),
    before,
  );
  assert.equal(count(), n);
});
test("per-session instance limit is bounded and abandoned records are reclaimed", () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) f.send(f.alice, f.request({ cursor: null }));
  assert.throws(
    () => f.send(f.alice, f.request()),
    (e) => e instanceof HttpError && e.status === 429,
  );
  assert.doesNotThrow(() => f.send(f.alice, f.request(), f.now + 300001));
});
