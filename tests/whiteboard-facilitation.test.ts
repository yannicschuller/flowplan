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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.com`);
  return { id: uid, name, email: `${uid}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const mara = await user("Mara"),
  ben = await user("Ben"),
  vera = await user("Vera"),
  wid = await createWorkspace(mara.id, "Workshop"),
  boot = await bootstrap(mara, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, vera.id, "viewer");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fails = async (fn: () => unknown, status: number) =>
  assert.rejects(async () => fn(), (e: { status?: number; name?: string }) => e.status === status || (status === 400 && e.name === "ZodError"));
const create = async (title: string, kind = "whiteboard") =>
  ((await command(mara, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title, kind })) as { id: string }).id;

// A browser: its document, the shared sync and its private sync.
async function browser(pageId: string, who: Identity) {
  const data = (await pageData(who, pageId)) as { whiteboard: { state: string; generation: string } };
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
    async sync() {
      const update = sharedUpdate(doc, vector);
      vector = Y.encodeStateVector(doc);
      const result = (await command(who, { action: "whiteboard.sync", pageId, generation: data.whiteboard.generation, update: b64(update) })) as { state: string };
      Y.applyUpdate(doc, Buffer.from(result.state, "base64"), "remote");
      return result;
    },
    joinPrivate(sid: string) {
      session = sid;
      client = newClientId(doc);
      setPrivateRouting(doc, { client });
      return client;
    },
    async privateSync() {
      const update = privateUpdate(doc, [client], acked);
      acked.set(client, Y.getState(doc.store, client));
      return (await facilitate(who, pageId, { action: "private.sync", session, client, update: b64(update) })) as { clients: number[]; rev: number; state?: string; revealed: boolean };
    },
    leavePrivate() {
      setPrivateRouting(doc, { client: null });
    },
  };
}
const SECRET = "Kündigungswelle im Vertrieb";
const raw = (value: unknown) => JSON.stringify(value);

test("private mode: others' private notes reach no other person by any path until revealed", async () => {
  const board = await create("Retro");
  const a = await browser(board, mara),
    b = await browser(board, ben);
  const frame = a.add({ type: "frame", x: 0, y: 0, w: 800, h: 600, z: -1, text: "Ideen" });
  a.add({ type: "sticky", x: 900, y: 0, w: 100, h: 100, z: 1, text: "Agenda" });
  await a.sync();
  await b.sync();

  // Viewers cannot start it; editors can, once.
  await fails(async () => await facilitate(vera, board, { action: "private.start" }), 403);
  await fails(async () => await facilitate(ben, board, { action: "private.start", frame: "keiner" }), 400);
  const { id: session } = (await facilitate(mara, board, { action: "private.start", frame })) as { id: string };
  await fails(async () => await facilitate(ben, board, { action: "private.start" }), 409);
  assert.equal((await facilitationState(ben, board)).private?.frame, frame);

  // Ben brainstorms in the frame.
  b.joinPrivate(session);
  const idea = b.add({ type: "sticky", x: 100, y: 100, w: 100, h: 100, z: 2, text: SECRET });
  b.items.get(idea)!.set("text", `${SECRET}!`);
  await b.sync();
  const answer = await b.privateSync();
  assert.equal(answer.revealed, false);
  assert.ok(answer.state, "his own private notes come back for his other tabs");
  // A client that sends everything with the normal sync: stripped.
  await command(ben, {
    action: "whiteboard.sync",
    pageId: board,
    generation: ((await pageData(ben, board)) as { whiteboard: { generation: string } }).whiteboard.generation,
    update: b64(Y.encodeStateAsUpdate(b.doc)),
  });

  // Mara: a count, nothing else.
  const seen = await facilitationState(mara, board);
  assert.equal(seen.private?.others, 1);
  assert.equal(seen.private?.mine, 0);
  assert.doesNotMatch(raw(seen), /Kündigung/);
  assert.equal((await facilitationState(ben, board)).private?.mine, 1);
  await a.sync();
  assert.equal(a.items.has(idea), false);
  assert.doesNotMatch(raw(a.doc.getMap("items").toJSON()), /Kündigung/);
  assert.doesNotMatch(Buffer.from(Y.encodeStateAsUpdate(a.doc)).toString("latin1"), /Kündigung/);
  // Page API, search, snapshot items, Markdown/SVG export, stored board and history.
  assert.doesNotMatch(raw(await pageData(mara, board)), /Kündigung/);
  assert.ok(!(await searchWorkspace(mara, wid, "Kündigungswelle")).some((r) => r.id === board));
  assert.doesNotMatch(raw(await whiteboardSnapshotItems((await one<never>("SELECT * FROM pages WHERE id=?", board))!)), /Kündigung/);
  const files = await readExportZip((await exportMarkdown(mara, { pageId: board, format: "zip", includeSubpages: true })).bytes as Buffer);
  for (const [name, bytes] of files) assert.doesNotMatch(bytes.toString("utf8"), /Kündigung/, name);
  for (const table of ["whiteboards", "documents", "snapshots"])
    for (const row of await all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE page_id=?`, board))
      for (const value of Object.values(row)) assert.doesNotMatch(Buffer.from(value instanceof Uint8Array ? value : String(value ?? "")).toString("latin1"), /Kündigung/, table);

  // Nobody else may write or read under Ben's private writer.
  await fails(async () => await facilitate(mara, board, { action: "private.sync", session, client: answer.clients[0] }), 409);
  const foreign = new Y.Doc();
  foreign.clientID = answer.clients[0];
  foreign.getMap("items").set("x", new Y.Map());
  const maraClient = newClientId(a.doc);
  await fails(async () => await facilitate(mara, board, { action: "private.sync", session, client: maraClient, update: b64(Y.encodeStateAsUpdate(foreign)) }), 403);
  // A shared change built on Ben's private note is refused, not stored.
  const piggy = new Y.Doc();
  Y.applyUpdate(piggy, Y.encodeStateAsUpdate(b.doc));
  const before = Y.encodeStateVector(piggy);
  piggy.getMap<Y.Map<unknown>>("items").get(idea)!.set("text", "Huckepack");
  await fails(
    async () =>
      await command(ben, {
        action: "whiteboard.sync",
        pageId: board,
        generation: ((await pageData(ben, board)) as { whiteboard: { generation: string } }).whiteboard.generation,
        update: b64(Y.encodeStateAsUpdate(piggy, before)),
      }),
    409,
  );

  // Reveal: everybody gets it, the search too; a viewer cannot reveal.
  await fails(async () => await facilitate(vera, board, { action: "private.reveal", session }), 403);
  assert.deepEqual(await facilitate(mara, board, { action: "private.reveal", session }), { count: 1 });
  await a.sync();
  assert.equal(a.items.get(idea)?.get("text"), `${SECRET}!`);
  assert.ok((await searchWorkspace(mara, wid, "Kündigungswelle")).some((r) => r.id === board));
  const after = await facilitationState(mara, board);
  assert.equal(after.private, null);
  assert.equal(after.revealed?.count, 1);
  // A tab that was offline sends its last private change late: it lands on the board.
  b.items.get(idea)!.set("fill", "#ffc9c9");
  await b.privateSync();
  b.leavePrivate();
  await a.sync();
  assert.equal(a.items.get(idea)?.get("fill"), "#ffc9c9");
  // A new writer cannot join a finished session.
  await fails(async () => await facilitate(ben, board, { action: "private.sync", session, client: newClientId(b.doc) }), 409);
});

test("private mode: reloads get their own notes back, the facilitator leaving changes nothing", async () => {
  const board = await create("Brainstorming");
  const { id: session } = (await facilitate(ben, board, { action: "private.start" })) as { id: string };
  const first = await browser(board, mara);
  first.joinPrivate(session);
  const note = first.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, z: 1, text: "Meins" });
  await first.privateSync();
  // Mara reloads: a new tab with a new writer gets her notes back.
  const second = await browser(board, mara);
  assert.equal(second.items.has(note), false);
  second.joinPrivate(session);
  const back = await second.privateSync();
  assert.equal(back.clients.length, 2);
  Y.applyUpdate(second.doc, Buffer.from(back.state!, "base64"));
  assert.equal(second.items.get(note)?.get("text"), "Meins");
  // Ben, who started it and left, still only sees the count.
  assert.equal((await facilitationState(ben, board)).private?.others, 1);
  assert.equal((await facilitationState(vera, board)).private?.others, 1);
  await facilitate(ben, board, { action: "private.reveal", session });
  assert.equal((await whiteboardSnapshotItems((await one<never>("SELECT * FROM pages WHERE id=?", board))!)).find((i) => i.id === note)?.text, "Meins");
});

test("planning poker: cards stay hidden until the reveal, the result goes onto the record", async () => {
  const board = await create("Sprint");
  const db = await create("Backlog", "database");
  const current = await database(db);
  await command(mara, {
    action: "database.update",
    pageId: db,
    version: current.version,
    views: current.views,
    fields: [...current.fields, { id: "pts", name: "Story Points", type: "number" }, { id: "size", name: "Größe", type: "select", options: ["S", "M", "L"] }],
  });
  const row = (await command(mara, { action: "row.create", pageId: db, cells: {} })) as { id: string };
  const a = await browser(board, mara);
  const sticky = a.add({ type: "sticky", x: 0, y: 0, w: 100, h: 100, z: 1, text: "Login" });
  const card = a.add({ type: "card", x: 200, y: 0, w: 200, h: 100, z: 2, pageId: db, rowId: row.id });
  const shape = a.add({ type: "shape", x: 400, y: 0, w: 100, h: 100, z: 3 });
  await a.sync();

  await fails(async () => await facilitate(mara, board, { action: "estimate.start", items: [shape], deck: { kind: "fibonacci", values: ["1", "2"] } }), 400);
  await fails(async () => await facilitate(mara, board, { action: "estimate.start", items: [sticky], deck: { kind: "custom", values: ["1"] } }), 400);
  const started = (await facilitate(mara, board, { action: "estimate.start", items: [shape, sticky, card], deck: { kind: "fibonacci", values: ["1", "2", "3", "5", "8", "13", "21", "?", "☕"] } })) as { items: string[]; round: string };
  assert.deepEqual(started.items, [sticky, card]);
  const round = started.round;
  await fails(async () => await facilitate(vera, board, { action: "estimate.vote", round, value: "3" }), 403);
  await fails(async () => await facilitate(ben, board, { action: "estimate.vote", round, value: "4" }), 400);
  await facilitate(mara, board, { action: "estimate.vote", round, value: "5" });
  await facilitate(ben, board, { action: "estimate.vote", round, value: "8" });
  await facilitate(ben, board, { action: "estimate.vote", round, value: "13" });
  // Before the reveal: who voted, the own card – nobody else's.
  const forBen = (await facilitationState(ben, board)).estimation!;
  assert.equal(forBen.mine, "13");
  assert.deepEqual(forBen.votes.map((v) => v.name).sort(), ["Ben", "Mara"]);
  assert.ok(forBen.votes.every((v) => !("value" in v)));
  assert.equal(forBen.stats, null);
  const forVera = (await facilitationState(vera, board)).estimation!;
  assert.equal(forVera.mine, null);
  assert.doesNotMatch(raw(forVera.votes), /value|"5"|"13"/);
  await fails(async () => await facilitate(ben, board, { action: "estimate.reveal", round: crypto.randomUUID() }), 409);
  await facilitate(ben, board, { action: "estimate.reveal", round });
  const open = (await facilitationState(vera, board)).estimation!;
  assert.deepEqual(open.votes.map((v) => v.value).sort(), ["13", "5"]);
  assert.equal(open.stats?.average, 9);
  assert.equal(open.stats?.consensus, false);
  await fails(async () => await facilitate(mara, board, { action: "estimate.vote", round, value: "3" }), 409);
  await facilitate(mara, board, { action: "estimate.result", item: sticky, value: "8" });
  // Next item: a new round without votes.
  await facilitate(mara, board, { action: "estimate.next", round });
  const next = (await facilitationState(mara, board)).estimation!;
  assert.equal(next.index, 1);
  assert.equal(next.votes.length, 0);
  assert.equal(next.results[sticky], "8");
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM whiteboard_estimate_votes WHERE page_id=?", board))?.n, 0);
  // Into the record: a number property; a value missing from a select is refused; viewers cannot.
  const record = { pageId: db, rowId: row.id, fieldId: "pts" };
  await fails(async () => await facilitate(vera, board, { action: "estimate.result", item: card, value: "5", record }), 403);
  await fails(async () => await facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record: { ...record, fieldId: "size" } }), 400);
  await fails(async () => await facilitate(mara, board, { action: "estimate.result", item: card, value: "?", record }), 400);
  await fails(async () => await facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record: { ...record, rowId: crypto.randomUUID() } }), 400);
  await facilitate(mara, board, { action: "estimate.result", item: card, value: "5", record });
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row.id))!.cells).pts, 5);
  // Again, then done.
  await facilitate(ben, board, { action: "estimate.revote", round: next.round });
  assert.notEqual((await facilitationState(ben, board)).estimation!.round, next.round);
  await facilitate(ben, board, { action: "estimate.end" });
  assert.equal((await facilitationState(ben, board)).estimation, null);
});

test("Alle zu mir holen: everyone else gets one jump, late joiners see it a minute, nothing else", async () => {
  const board = await create("Workshop");
  const got = new Map<string, string[]>();
  const listen = (who: Identity) => watchBoard(board, who.id, (event) => got.set(who.id, [...(got.get(who.id) || []), event]));
  const stops = [listen(mara), listen(ben)];
  await fails(async () => await facilitate(vera, board, { action: "gather", view: { x: 0, y: 0, w: 800, h: 600 } }), 403);
  await fails(async () => await facilitate(mara, board, { action: "gather", view: { x: 0, y: 0, w: 0, h: 600 } }), 400);
  await fails(async () => await facilitate(mara, board, { action: "gather", view: { x: Infinity, y: 0, w: 10, h: 10 } }), 400);
  const gather = (await facilitate(mara, board, { action: "gather", view: { x: 100, y: 50, w: 1200, h: 800 } })) as { id: string; name: string };
  const events = (who: Identity) => (got.get(who.id) || []).map((e) => JSON.parse(e.replace(/^data: /, ""))).filter((e) => e.type === "gather");
  assert.deepEqual(events(ben).map((e) => [e.id, e.name, e.view.w]), [[gather.id, "Mara", 1200]]);
  assert.equal(events(mara).length, 0, "not to the one who gathers");
  assert.equal((await facilitationState(vera, board)).gather?.id, gather.id);
  stops.forEach((stop) => stop());
});
