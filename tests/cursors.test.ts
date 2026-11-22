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
  HEARTBEAT_WITH_PEERS_MS,
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
async function fixture() {
  const now = Date.now(),
    workspace = id(),
    space = id(),
    page = id(),
    row = id(),
    database = id();
  const user = async (name: string) => {
    const uid = id(),
      token = id();
    await run(
      "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
      uid,
      uid,
      name,
      `${uid}@test.invalid`,
    );
    await run(
      "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
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
  const alice = await user("Alice <script>"),
    bob = await user("Bob");
  await run(
    "INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)",
    workspace,
    "Cursor tests",
    alice.identity.id,
  );
  for (const u of [alice, bob])
    await run(
      "INSERT INTO members VALUES(?,?,?)",
      workspace,
      u.identity.id,
      "editor",
    );
  await run(
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
    await run(
      "INSERT INTO pages(id,workspace_id,space_id,title,kind) VALUES(?,?,?,?,?)",
      pid,
      workspace,
      space,
      "Test",
      kind,
    );
  await run(
    "INSERT INTO documents(page_id,state,html,generation) VALUES(?,?,?,?)",
    page,
    new Uint8Array(),
    "<p>Original</p>",
    "g1",
  );
  await run("INSERT INTO rows(id,page_id,cells) VALUES(?,?,?)", row, database, "{}");
  await run(
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
  const send = async (u: typeof alice, input: unknown, time = now) =>
    await editorPresence(u.identity, u.token, input, time);
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
test("cursor protocol accepts real Yjs positions and bounds untrusted input", async () => {
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
  const f = await fixture();
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
test("server derives identity, isolates sessions and preserves independent tabs", async () => {
  const f = await fixture(),
    a = f.request(),
    b = f.request({ clientId: a.clientId });
  await f.send(f.alice, a);
  const result = await f.send(f.bob, b);
  assert.equal(result.peers.length, 1);
  assert.equal(result.peers[0].name, "Alice <script>");
  assert.equal(result.peers[0].userId, f.alice.identity.id);
  assert.equal(JSON.stringify(result).includes(f.alice.token), false);
  assert.equal((await f.send(f.alice, f.request())).peers.length, 2);
  await assert.rejects(
    async () => await editorPresence(f.alice.identity, f.bob.token, a),
    (e) => e instanceof HttpError && e.status === 401,
  );
});
test("stale requests and departures cannot resurrect cursors; leases expire", async () => {
  const f = await fixture(),
    a = f.request(),
    b = f.request({ cursor: null });
  await f.send(f.alice, a);
  assert.equal((await f.send(f.bob, b)).peers.length, 1);
  await f.send(f.alice, { ...a, sequence: 3, cursor: null });
  await f.send(f.alice, { ...a, sequence: 2 }, f.now + 1);
  assert.equal((await f.send(f.bob, { ...b, sequence: 2 }, f.now + 2)).peers.length, 0);
  await f.send(f.alice, { ...a, sequence: 4 });
  assert.equal(
    (await f.send(f.bob, { ...b, sequence: 3 }, f.now + CURSOR_LEASE_MS)).peers.length,
    0,
  );
});
test("a closed live channel takes its tab's cursor along; the tab, if still there, shows it again", async () => {
  const { editorLeft } = await import("../lib/editor-presence");
  const { documentKey } = await import("../lib/document-live");
  const f = await fixture(),
    a = f.request(),
    b = f.request({ cursor: null });
  await f.send(f.alice, a);
  assert.equal((await f.send(f.bob, b)).peers.length, 1);
  // The departure on pagehide got lost; the live channel of a's tab closes.
  assert.deepEqual((await editorLeft(f.alice.token, a.clientId))?.key, documentKey(f.page, undefined, "g1"));
  assert.equal((await f.send(f.bob, { ...b, sequence: 2 }, f.now + 1)).peers.length, 0);
  // Nothing more to take: no signal to the others.
  assert.equal(await editorLeft(f.alice.token, a.clientId), null);
  assert.equal(await editorLeft(f.alice.token, id()), null);
  // Only another session's own channel counts.
  await f.send(f.alice, { ...a, sequence: 2 }, f.now + 2);
  assert.equal(await editorLeft(f.bob.token, a.clientId), null);
  // The channel only reconnected: the tab's next request brings the cursor back.
  assert.equal((await f.send(f.bob, { ...b, sequence: 3 }, f.now + 3)).peers.length, 1);
});
test("fresh page rights and live session status govern both publishing and receiving", async () => {
  const f = await fixture(),
    a = f.request(),
    b = f.request({ cursor: null });
  await f.send(f.alice, a);
  await run("UPDATE users SET disabled=1 WHERE id=?", f.alice.identity.id);
  assert.equal((await f.send(f.bob, b)).peers.length, 0);
  await assert.rejects(async () => await f.send(f.alice, a), HttpError);
  await run("UPDATE users SET disabled=0 WHERE id=?", f.alice.identity.id);
  await run(
    "DELETE FROM members WHERE workspace_id=? AND user_id=?",
    f.workspace,
    f.alice.identity.id,
  );
  assert.equal((await f.send(f.bob, { ...b, sequence: 2 })).peers.length, 0);
  await assert.rejects(async () => await f.send(f.alice, a), HttpError);
  await run(
    "INSERT INTO members VALUES(?,?,?)",
    f.workspace,
    f.alice.identity.id,
    "viewer",
  );
  assert.equal((await f.send(f.bob, { ...b, sequence: 3 })).peers.length, 1);
  await run("DELETE FROM sessions WHERE token=?", f.alice.token);
  assert.equal((await f.send(f.bob, { ...b, sequence: 4 })).peers.length, 0);
  assert.equal(
    await one("SELECT id FROM editor_presence WHERE session_token=?", f.alice.token),
    undefined,
  );
});
test("private pages, generations, rows and tabs have disjoint scopes", async () => {
  const f = await fixture(),
    a = f.request();
  await f.send(f.alice, a);
  await run("UPDATE spaces SET visibility='private' WHERE id=?", f.space);
  await assert.rejects(async () => await f.send(f.bob, f.request()), HttpError);
  await run("UPDATE spaces SET visibility='team' WHERE id=?", f.space);
  const rowRequest = f.request({
    pageId: f.database,
    rowId: f.row,
    generation: "r1",
  });
  assert.equal((await f.send(f.bob, rowRequest)).peers.length, 0);
  await assert.rejects(async () => await f.send(f.bob, f.request({ rowId: f.row })), HttpError);
  await assert.rejects(
    async () =>
      await f.send(f.alice, {
        ...a,
        pageId: f.database,
        rowId: f.row,
        generation: "r1",
        sequence: 2,
      }),
    HttpError,
  );
  await run("UPDATE documents SET generation='g2' WHERE page_id=?", f.page);
  await assert.rejects(async () => await f.send(f.alice, { ...a, sequence: 2 }), HttpError);
  assert.equal((await f.send(f.bob, f.request({ generation: "g2" }))).peers.length, 0);
  await run("DELETE FROM rows WHERE id=?", f.row);
  assert.equal(
    await one("SELECT id FROM editor_presence WHERE row_id=?", f.row),
    undefined,
  );
});
test("cursor heartbeats never alter content or create snapshots or audit records", async () => {
  const f = await fixture(),
    before = await one("SELECT * FROM documents WHERE page_id=?", f.page),
    a = f.request();
  const count = async () =>
    (await one(
      "SELECT (SELECT count(*) FROM snapshots)+(SELECT count(*) FROM audit) n",
    ))!.n;
  const n = await count();
  for (let sequence = 1; sequence < 20; sequence++)
    await f.send(f.alice, { ...a, sequence });
  assert.deepEqual(
    await one("SELECT * FROM documents WHERE page_id=?", f.page),
    before,
  );
  assert.equal(await count(), n);
});
test("per-session instance limit is bounded and abandoned records are reclaimed", async () => {
  const f = await fixture();
  for (let i = 0; i < 128; i++) await f.send(f.alice, f.request({ cursor: null }));
  await assert.rejects(
    async () => await f.send(f.alice, f.request()),
    (e) => e instanceof HttpError && e.status === 429,
  );
  await assert.doesNotReject(async () => await f.send(f.alice, f.request(), f.now + 300001));
});

test("presence: every accepted update brings the cursor for the others' editors; a departure takes it away", async () => {
  const f = await fixture();
  const a = f.request();
  const first = await f.send(f.alice, a);
  assert.deepEqual(first.peer, { id: (first.peer as { id: string }).id, userId: f.alice.identity.id, name: "Alice <script>", cursor, expiresInMs: CURSOR_LEASE_MS });
  // A heartbeat at the same place soon after: nothing on the live channel
  // (the others' own requests renew the lease), but the lease is renewed.
  const quiet = await f.send(f.alice, { ...a, sequence: a.sequence + 1 }, f.now + 1000);
  assert.equal(quiet.peer, undefined);
  // A moved cursor goes out at once.
  const moved = { anchor: position, head: { ...position, assoc: 1 } };
  const move = await f.send(f.alice, { ...a, sequence: a.sequence + 2, cursor: moved }, f.now + 2000);
  assert.equal(move.peer?.id, first.peer?.id);
  assert.deepEqual(move.peer && "userId" in move.peer ? move.peer.cursor : null, moved);
  // The same place after a longer pause (alone, or a newcomer arrived):
  // sent again under the same id.
  const beat = await f.send(f.alice, { ...a, sequence: a.sequence + 3, cursor: moved }, f.now + 2000 + CURSOR_LEASE_MS - HEARTBEAT_WITH_PEERS_MS);
  assert.equal(beat.peer?.id, first.peer?.id);
  assert.ok(beat.peer?.cursor);
  const t = f.now + 2000 + CURSOR_LEASE_MS;
  // A stale request: nothing for the others.
  assert.equal((await f.send(f.alice, { ...a, sequence: a.sequence }, t + 1)).peer, undefined);
  // The cursor went: its id with null.
  assert.deepEqual((await f.send(f.alice, { ...a, sequence: a.sequence + 4, cursor: null }, t + 2)).peer, { id: first.peer?.id, cursor: null });
  // Gone already: nothing to tell.
  assert.equal((await f.send(f.alice, { ...a, sequence: a.sequence + 5, cursor: null }, t + 3)).peer, undefined);
});

test("presence: a heartbeat while alone, moves of the others by signal", async () => {
  // Imported here: the plugin module touches no DOM at import time.
  const { presenceDelay, peerSignature } = await import("../lib/collaboration-cursors");
  const { HEARTBEAT_ALONE_MS } = await import("../lib/cursor-protocol");
  // Alone with the live channel open: a heartbeat of 15–30 s.
  assert.equal(presenceDelay(true, false), HEARTBEAT_ALONE_MS);
  assert.ok(HEARTBEAT_ALONE_MS >= 15_000 && HEARTBEAT_ALONE_MS <= 30_000);
  // With others and the live channel a heartbeat (their cursors come with
  // the channel); without it every second, as before.
  assert.equal(presenceDelay(true, true), HEARTBEAT_WITH_PEERS_MS);
  assert.ok(HEARTBEAT_WITH_PEERS_MS * 2 < CURSOR_LEASE_MS);
  assert.equal(presenceDelay(false, true), 1_000);
  assert.ok(presenceDelay(false, false) <= 5_000);
  // Only what the others see counts as a change, not the expiry.
  const peer = { id: "a", userId: "u", name: "Ann", cursor, expiresInMs: 1000 };
  assert.equal(peerSignature([peer]), peerSignature([{ ...peer, expiresInMs: 40_000 }]));
  assert.notEqual(peerSignature([peer]), peerSignature([{ ...peer, name: "Anna" }]));
  assert.notEqual(peerSignature([peer]), peerSignature([]));
});

test("presence: moves stay home while nobody else has the document open; pushed cursors and answers merge", async () => {
  const { sendsMoves, mergeAnswer, mergePushed } = await import("../lib/collaboration-cursors");
  // Alone with the live channel: no moves. Someone there (the channel says
  // so, or their cursor is shown), or no channel: as before.
  assert.equal(sendsMoves(true, false, 0), false);
  assert.equal(sendsMoves(true, true, 0), true);
  assert.equal(sendsMoves(true, false, 1), true);
  assert.equal(sendsMoves(false, false, 0), true);
  const peer = (id: string, name = id) => ({ id, userId: `u-${id}`, name, cursor, expiresInMs: CURSOR_LEASE_MS, deadline: 0 });
  // A pushed cursor is added, replaced in place, or removed.
  let list = mergePushed([], peer("a"), 1000);
  assert.equal(list[0].deadline, 1000 + CURSOR_LEASE_MS);
  list = mergePushed([...list, peer("b")], peer("a", "Ann"), 2000);
  assert.deepEqual(list.map((p) => p.name), ["Ann", "b"]);
  assert.deepEqual(mergePushed(list, { id: "a", cursor: null }).map((p) => p.id), ["b"]);
  // An answer replaces the list, but what the channel brought or took away
  // after the request started stays.
  const pushedAt = new Map([["a", 50], ["c", 150], ["d", 150]]);
  const current = [peer("a", "old a"), peer("c", "pushed c")];
  const answer = [peer("a", "answer a"), peer("b"), peer("d", "gone d")];
  assert.deepEqual(mergeAnswer(current, answer, pushedAt, 100).map((p) => p.name), ["answer a", "b", "pushed c"]);
});

test("audience: each live stream hears whether anyone else is in its room", async () => {
  const { joinAudience, audienceOthers } = await import("../lib/live-audience");
  const room = `doc:${id()}:`;
  const heard: Record<"a" | "b" | "a2", boolean[]> = { a: [], b: [], a2: [] };
  const leaveA = joinAudience(room, "a", (o) => heard.a.push(o));
  assert.deepEqual(heard.a, [false]);
  assert.equal(audienceOthers(room, "a"), false);
  const leaveB = joinAudience(room, "b", (o) => heard.b.push(o));
  assert.deepEqual({ ...heard }, { a: [false, true], b: [true], a2: [] });
  // A second stream under the same id is no audience for the first.
  const leaveA2 = joinAudience(room, "a", (o) => heard.a2.push(o));
  assert.deepEqual(heard.a2, [true]);
  leaveB();
  assert.deepEqual({ ...heard }, { a: [false, true, false], b: [true], a2: [true, false] });
  leaveA2();
  leaveA();
  leaveA();
  assert.equal(audienceOthers(room, "b"), false);
});

test("audience: streams on other instances count (cluster bus); a stale instance is forgotten", async () => {
  const { joinAudience } = await import("../lib/live-audience");
  const bus = (globalThis as unknown as { flowplanBus?: { handlers: Map<string, Set<(p: unknown, o: string) => void>> } }).flowplanBus;
  const deliver = (payload: unknown, origin: string) => {
    for (const handler of bus?.handlers.get("audience") ?? []) handler(payload, origin);
  };
  assert.ok(bus?.handlers.get("audience")?.size, "listening on the bus");
  const room = `board:${id()}`;
  const heard: boolean[] = [];
  const leave = joinAudience(room, "me", (o) => heard.push(o));
  // The same person on another instance is no audience; someone else is.
  deliver({ k: "join", room, ids: ["me"] }, "other");
  deliver({ k: "join", room, ids: ["you"] }, "other");
  deliver({ k: "leave", room, ids: ["you"] }, "other");
  assert.deepEqual(heard, [false, true, false]);
  // A "here" without a "leave" lasts a minute.
  const realNow = Date.now;
  try {
    deliver({ k: "here", room, ids: ["you"] }, "third");
    assert.deepEqual(heard, [false, true, false, true]);
    Date.now = () => realNow() + 61_000;
    const late: boolean[] = [];
    const leaveLate = joinAudience(room, "late", (o) => late.push(o));
    // "me" is still here, "you" is forgotten.
    assert.deepEqual(late, [true]);
    leaveLate();
    deliver({ k: "join", room, ids: ["x"] }, "fourth");
    deliver({ k: "leave", room, ids: ["x"] }, "fourth");
    assert.equal(heard.at(-1), false);
  } finally {
    Date.now = realNow;
  }
  leave();
});
