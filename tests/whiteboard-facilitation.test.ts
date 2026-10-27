// Workshop facilitation on whiteboards (lib/whiteboard-facilitation.ts):
// private mode keeps others' content off every path until it is revealed,
// planning poker hides cards until the reveal, "Alle zu mir holen" reaches
// everyone else once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-facilitation-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap, pageData, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { searchWorkspace } = await import("../lib/search-index");
const { whiteboardSnapshotItems } = await import("../lib/whiteboard");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");
const { facilitate, facilitationState } = await import("../lib/whiteboard-facilitation");
const { watchBoard } = await import("../lib/whiteboard-presence");
const { installPrivateRouting, newClientId, privateUpdate, setPrivateRouting, sharedUpdate } = await import("../lib/whiteboard-private-mode");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.com`);
  return { id: uid, name, email: `${uid}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const mara = user("Mara"),
  ben = user("Ben"),
  vera = user("Vera"),
  wid = createWorkspace(mara.id, "Workshop"),
  boot = bootstrap(mara, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vera.id, "viewer");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: { status?: number; name?: string }) => e.status === status || (status === 400 && e.name === "ZodError"));
const create = (title: string, kind = "whiteboard") =>
  (command(mara, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title, kind }) as { id: string }).id;

// A browser: its document, the shared sync and its private sync.
function browser(pageId: string, who: Identity) {
  const data = pageData(who, pageId) as { whiteboard: { state: string; generation: string } };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  const items = doc.getMap<Y.Map<unknown>>("items");
  installPrivateRouting(doc, items);
  let vector: Uint8Array | null = Y.encodeStateVector(doc);
  let client = 0,
    session = "";
  const acked = new Map<number, number>();
  return {
    doc,
    items,
    add(props: Record<string, unknown>) {
      const key = crypto.randomUUID();
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(props)) map.set(k, v);
      items.set(key, map);
      return key;
    },
    sync() {
      const update = sharedUpdate(doc, vector);
      vector = Y.encodeStateVector(doc);
      const result = command(who, { action: "whiteboard.sync", pageId, generation: data.whiteboard.generation, update: b64(update) }) as { state: string };
      Y.applyUpdate(doc, Buffer.from(result.state, "base64"), "remote");
      return result;
    },
    joinPrivate(sid: string) {
      session = sid;
      client = newClientId(doc);
      setPrivateRouting(doc, { client });
      return client;
    },
    privateSync() {
      const update = privateUpdate(doc, [client], acked);
      acked.set(client, Y.getState(doc.store, client));
      return facilitate(who, pageId, { action: "private.sync", session, client, update: b64(update) }) as { clients: number[]; rev: number; state?: string; revealed: boolean };
    },
    leavePrivate() {
      setPrivateRouting(doc, { client: null });
    },
  };
}
const SECRET = "Kündigungswelle im Vertrieb";
const raw = (value: unknown) => JSON.stringify(value);

test("private mode: others' private notes reach no other person by any path until revealed", async () => {
  const board = create("Retro");
  const a = browser(board, mara),
    b = browser(board, ben);
  const frame = a.add({ type: "frame", x: 0, y: 0, w: 800, h: 600, z: -1, text: "Ideen" });
  a.add({ type: "sticky", x: 900, y: 0, w: 100, h: 100, z: 1, text: "Agenda" });
  a.sync();
  b.sync();

  // Viewers cannot start it; editors can, once.
  fails(() => facilitate(vera, board, { action: "private.start" }), 403);
  fails(() => facilitate(ben, board, { action: "private.start", frame: "keiner" }), 400);
  const { id: session } = facilitate(mara, board, { action: "private.start", frame }) as { id: string };
  fails(() => facilitate(ben, board, { action: "private.start" }), 409);
  assert.equal(facilitationState(ben, board).private?.frame, frame);

  // Ben brainstorms in the frame.
  b.joinPrivate(session);
  const idea = b.add({ type: "sticky", x: 100, y: 100, w: 100, h: 100, z: 2, text: SECRET });
  b.items.get(idea)!.set("text", `${SECRET}!`);
  b.sync();
  const answer = b.privateSync();
  assert.equal(answer.revealed, false);
  assert.ok(answer.state, "his own private notes come back for his other tabs");
  // A client that sends everything with the normal sync: stripped.
  command(ben, {
    action: "whiteboard.sync",
    pageId: board,
    generation: (pageData(ben, board) as { whiteboard: { generation: string } }).whiteboard.generation,
    update: b64(Y.encodeStateAsUpdate(b.doc)),
  });

  // Mara: a count, nothing else.
  const seen = facilitationState(mara, board);
  assert.equal(seen.private?.others, 1);
  assert.equal(seen.private?.mine, 0);
  assert.doesNotMatch(raw(seen), /Kündigung/);
  assert.equal(facilitationState(ben, board).private?.mine, 1);
  a.sync();
  assert.equal(a.items.has(idea), false);
  assert.doesNotMatch(raw(a.doc.getMap("items").toJSON()), /Kündigung/);
  assert.doesNotMatch(Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString("latin1"), /Kündigung/);
  // Page API, search, snapshot items, Markdown/SVG export, stored board and history.
  assert.doesNotMatch(raw(pageData(mara, board)), /Kündigung/);
  assert.ok(!searchWorkspace(mara, wid, "Kündigungswelle").some((r) => r.id === board));
  assert.doesNotMatch(raw(whiteboardSnapshotItems(one<never>("SELECT * FROM pages WHERE id=?", board)!)), /Kündigung/);
  const files = await readExportZip((await exportMarkdown(mara, { pageId: board, format: "zip", includeSubpages: true })).bytes as Buffer);
  for (const [name, bytes] of files) assert.doesNotMatch(bytes.toString("utf8"), /Kündigung/, name);
  for (const table of ["whiteboards", "documents", "snapshots"])
    for (const row of all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE page_id=?`, board))
      for (const value of Object.values(row)) assert.doesNotMatch(Buffer.from(value instanceof Uint8Array ? value : String(value ?? "")).toString("latin1"), /Kündigung/, table);

  // Nobody else may write or read under Ben's private writer.
  fails(() => facilitate(mara, board, { action: "private.sync", session, client: answer.clients[0] }), 409);
  const foreign = new Y.Doc();
  foreign.clientID = answer.clients[0];
  foreign.getMap("items").set("x", new Y.Map());
  const maraClient = newClientId(a.doc);
  fails(() => facilitate(mara, board, { action: "private.sync", session, client: maraClient, update: b64(Y.encodeStateAsUpdate(foreign)) }), 403);
  // A shared change built on Ben's private note is refused, not stored.
  const piggy = new Y.Doc();
  Y.applyUpdate(piggy, Y.encodeStateAsUpdate(b.doc));
  const before = Y.encodeStateVector(piggy);
  piggy.getMap<Y.Map<unknown>>("items").get(idea)!.set("text", "Huckepack");
  fails(
    () =>
      command(ben, {
        action: "whiteboard.sync",
        pageId: board,
        generation: (pageData(ben, board) as { whiteboard: { generation: string } }).whiteboard.generation,
        update: b64(Y.encodeStateAsUpdate(piggy, before)),
      }),
    409,
  );

  // Reveal: everybody gets it, the search too; a viewer cannot reveal.
  fails(() => facilitate(vera, board, { action: "private.reveal", session }), 403);
  assert.deepEqual(facilitate(mara, board, { action: "private.reveal", session }), { count: 1 });
  a.sync();
  assert.equal(a.items.get(idea)?.get("text"), `${SECRET}!`);
  assert.ok(searchWorkspace(mara, wid, "Kündigungswelle").some((r) => r.id === board));
  const after = facilitationState(mara, board);
  assert.equal(after.private, null);
  assert.equal(after.revealed?.count, 1);
  // A tab that was offline sends its last private change late: it lands on the board.
  b.items.get(idea)!.set("fill", "#ffc9c9");
  b.privateSync();
  b.leavePrivate();
  a.sync();
  assert.equal(a.items.get(idea)?.get("fill"), "#ffc9c9");
  // A new writer cannot join a finished session.
  fails(() => facilitate(ben, board, { action: "private.sync", session, client: newClientId(b.doc) }), 409);
});

test("private mode: reloads get their own notes back, the facilitator leaving changes nothing", () => {
  const board = create("Brainstorming");
  const { id: session } = facilitate(ben, board, { action: "private.start" }) as { id: string };
  const first = browser(board, mara);
  first.joinPrivate(session);
  const note = first.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, z: 1, text: "Meins" });
  first.privateSync();
  // Mara reloads: a new tab with a new writer gets her notes back.
  const second = browser(board, mara);
  assert.equal(second.items.has(note), false);
  second.joinPrivate(session);
  const back = second.privateSync();
  assert.equal(back.clients.length, 2);
  Y.applyUpdate(second.doc, Buffer.from(back.state!, "base64"));
  assert.equal(second.items.get(note)?.get("text"), "Meins");
  // Ben, who started it and left, still only sees the count.
  assert.equal(facilitationState(ben, board).private?.others, 1);
  assert.equal(facilitationState(vera, board).private?.others, 1);
  facilitate(ben, board, { action: "private.reveal", session });
  assert.equal(whiteboardSnapshotItems(one<never>("SELECT * FROM pages WHERE id=?", board)!).find((i) => i.id === note)?.text, "Meins");
});

test("planning poker: cards stay hidden until the reveal, the result goes onto the record", () => {
  const board = create("Sprint");
  const db = create("Backlog", "database");
  const current = database(db);
  command(mara, {
    action: "database.update",
    pageId: db,
    version: current.version,
    views: current.views,
    fields: [...current.fields, { id: "pts", name: "Story Points", type: "number" }, { id: "size", name: "Größe", type: "select", options: ["S", "M", "L"] }],
  });
  const row = command(mara, { action: "row.create", pageId: db, cells: {} }) as { id: string };
  const a = browser(board, mara);
  const sticky = a.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, z: 1, text: "Login" });
  const card = a.add({ type: "card", x: 200, y: 0, w: 200, h: 100, z: 2, pageId: db, rowId: row.id });
  const shape = a.add({ type: "shape", x: 400, y: 0, w: 100, h: 100, z: 3 });
  a.sync();

  fails(() => facilitate(mara, board, { action: "estimate.start", items: [shape], deck: { kind: "fibonacci", values: ["1", "2"] } }), 400);
  fails(() => facilitate(mara, board, { action: "estimate.start", items: [sticky], deck: { kind: "custom", values: ["1"] } }), 400);
  const started = facilitate(mara, board, { action: "estimate.start", items: [shape, sticky, card], deck: { kind: "fibonacci", values: ["1", "2", "3", "5", "8", "13", "21", "?", "☕"] } }) as { items: string[]; round: string };
  assert.deepEqual(started.items, [sticky, card]);
  const round = started.round;
  fails(() => facilitate(vera, board, { action: "estimate.vote", round, value: "3" }), 403);
  fails(() => facilitate(ben, board, { action: "estimate.vote", round, value: "4" }), 400);
  facilitate(mara, board, { action: "estimate.vote", round, value: "5" });
  facilitate(ben, board, { action: "estimate.vote", round, value: "8" });
  facilitate(ben, board, { action: "estimate.vote", round, value: "13" });
  // Before the reveal: who voted, the own card – nobody else's.
  const forBen = facilitationState(ben, board).estimation!;
  assert.equal(forBen.mine, "13");
  assert.deepEqual(forBen.votes.map((v) => v.name).sort(), ["Ben", "Mara"]);
  assert.ok(forBen.votes.every((v) => !("value" in v)));
  assert.equal(forBen.stats, null);
  const forVera = facilitationState(vera, board).estimation!;
  assert.equal(forVera.mine, null);
  assert.doesNotMatch(raw(forVera.votes), /value|"5"|"13"/);
  fails(() => facilitate(ben, board, { action: "estimate.reveal", round: crypto.randomUUID() }), 409);
  facilitate(ben, board, { action: "estimate.reveal", round });
  const open = facilitationState(vera, board).estimation!;
  assert.deepEqual(open.votes.map((v) => v.value).sort(), ["13", "5"]);
  assert.equal(open.stats?.average, 9);
  assert.equal(open.stats?.consensus, false);
  fails(() => facilitate(mara, board, { action: "estimate.vote", round, value: "3" }), 409);
  facilitate(mara, board, { action: "estimate.result", item: sticky, value: "8" });
  // Next item: a new round without votes.
  facilitate(mara, board, { action: "estimate.next", round });
  const next = facilitationState(mara, board).estimation!;
  assert.equal(next.index, 1);
  assert.equal(next.votes.length, 0);
  assert.equal(next.results[sticky], "8");
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM whiteboard_estimate_votes WHERE page_id=?", board)?.n, 0);
  // Into the record: a number property; a value missing from a select is refused; viewers cannot.
  const record = { pageId: db, rowId: row.id, fieldId: "pts" };
  fails(() => facilitate(vera, board, { action: "estimate.result", item: card, value: "5", record }), 403);
  fails(() => facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record: { ...record, fieldId: "size" } }), 400);
  fails(() => facilitate(mara, board, { action: "estimate.result", item: card, value: "?", record }), 400);
  fails(() => facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record: { ...record, rowId: crypto.randomUUID() } }), 400);
  facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record });
  assert.equal(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row.id)!.cells).pts, 5);
  // Again, then done.
  facilitate(ben, board, { action: "estimate.revote", round: next.round });
  assert.notEqual(facilitationState(ben, board).estimation!.round, next.round);
  facilitate(ben, board, { action: "estimate.end" });
  assert.equal(facilitationState(ben, board).estimation, null);
});

test("Alle zu mir holen: everyone else gets one jump, late joiners see it a minute, nothing else", () => {
  const board = create("Workshop");
  const got = new Map<string, string[]>();
  const listen = (who: Identity) => watchBoard(board, who.id, (event) => got.set(who.id, [...(got.get(who.id) || []), event]));
  const stops = [listen(mara), listen(ben)];
  fails(() => facilitate(vera, board, { action: "gather", view: { x: 0, y: 0, w: 800, h: 600 } }), 403);
  fails(() => facilitate(mara, board, { action: "gather", view: { x: 0, y: 0, w: 0, h: 600 } }), 400);
  fails(() => facilitate(mara, board, { action: "gather", view: { x: Infinity, y: 0, w: 10, h: 10 } }), 400);
  const gather = facilitate(mara, board, { action: "gather", view: { x: 100, y: 50, w: 1200, h: 800 } }) as { id: string; name: string };
  const events = (who: Identity) => (got.get(who.id) || []).map((e) => JSON.parse(e.replace(/^data: /, ""))).filter((e) => e.type === "gather");
  assert.deepEqual(events(ben).map((e) => [e.id, e.name, e.view.w]), [[gather.id, "Mara", 1200]]);
  assert.equal(events(mara).length, 0, "not to the one who gathers");
  assert.equal(facilitationState(vera, board).gather?.id, gather.id);
  stops.forEach((stop) => stop());
});
