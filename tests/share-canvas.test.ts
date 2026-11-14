// Guests editing whiteboards and notebooks through an edit link (#280,
// lib/share-canvas.ts): who may, what reaches the board, what never
// leaves it, and that uploads stay closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-share-canvas-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const canvas = await import("../lib/share-canvas");
const { guestUpload } = await import("../lib/shared-uploads");
const { whiteboardSnapshotItems, whiteboardData } = await import("../lib/whiteboard");
const { pageInkDocs } = await import("../lib/page-ink-store");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Canvas"),
  boot = await bootstrap(owner, wid);
const space = boot.spaces[0].id;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};
const page = async (kind: string, title = kind, parentId?: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, kind, ...(parentId ? { parentId } : {}) })) as { id: string }).id;
const share = async (pageId: string, role: "viewer" | "commenter" | "editor", extra: Record<string, unknown> = {}) =>
  ((await command(owner, { action: "share.create", pageId, role, name: "Workshop", ...extra })) as { token: string }).token;
const pageRow = async (pid: string) => (await one<Parameters<typeof whiteboardSnapshotItems>[0]>("SELECT * FROM pages WHERE id=?", pid))!;
const boardItems = async (pid: string) => await whiteboardSnapshotItems(await pageRow(pid));

// A member edit through the normal board sync.
async function memberBoard(pid: string, edit: (items: Y.Map<Y.Map<unknown>>) => void) {
  await whiteboardData(await pageRow(pid));
  const data = (await command(owner, { action: "whiteboard.sync", pageId: pid, generation: (await one<{ generation: string }>("SELECT generation FROM whiteboards WHERE page_id=?", pid))?.generation || "" })) as { state: string };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.state, "base64"));
  const before = Y.encodeStateVector(doc);
  doc.transact(() => edit(doc.getMap<Y.Map<unknown>>("items")));
  const generation = (await one<{ generation: string }>("SELECT generation FROM whiteboards WHERE page_id=?", pid))!.generation;
  await command(owner, { action: "whiteboard.sync", pageId: pid, generation, update: b64(Y.encodeStateAsUpdate(doc, before)) });
}
const item = (props: Record<string, unknown>) => new Y.Map<unknown>(Object.entries({ x: 0, y: 0, w: 100, h: 100, z: 1, ...props }));

// A guest's browser: its own Yjs document, synchronised like the board does.
async function guest(token: string, pid: string) {
  const first = await canvas.syncSharedBoard(token, { pageId: pid });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(first.state, "base64"), "remote");
  let generation = first.generation;
  let sent: Uint8Array | null = null;
  const sync = async () => {
    const vector = Y.encodeStateVector(doc);
    const result = await canvas.syncSharedBoard(token, { pageId: pid, generation, update: b64(sent ? Y.encodeStateAsUpdate(doc, sent) : Y.encodeStateAsUpdate(doc)) });
    sent = vector;
    generation = result.generation;
    Y.applyUpdate(doc, Buffer.from(result.state, "base64"), "remote");
  };
  const items = () => doc.getMap<Y.Map<unknown>>("items");
  const shown = () => Object.fromEntries([...items().entries()].map(([k, v]) => [k, v.toJSON() as Record<string, unknown>]));
  return { doc, sync, items, shown };
}

test("an edit link edits the whiteboard live with members; their changes reach the guest", async () => {
  const board = await page("whiteboard", "Board");
  const token = await share(board, "editor");
  const g = await guest(token, board);
  g.items().set("s1", item({ type: "sticky", text: "Idee vom Gast", fill: "#fff6b6" }));
  await g.sync();
  let items = await boardItems(board);
  assert.equal(items.find((i) => i.id === "s1")?.text, "Idee vom Gast");
  // Moving it.
  g.items().get("s1")!.set("x", 240);
  await g.sync();
  assert.equal((await boardItems(board)).find((i) => i.id === "s1")?.x, 240);
  // A member writes; the guest sees it with the next exchange.
  await memberBoard(board, (map) => map.set("m1", item({ type: "text", text: "Vom Team", author: owner.id })));
  await g.sync();
  assert.equal(g.shown().m1?.text, "Vom Team");
  assert.equal(g.shown().m1?.author, undefined, "authors (user ids) are not shown");
  // A guest deletes.
  g.items().delete("m1");
  await g.sync();
  items = await boardItems(board);
  assert.ok(!items.some((i) => i.id === "m1"));
  // Snapshot and audit as guest.
  assert.ok(await one("SELECT 1 FROM snapshots WHERE page_id=? AND created_by='guest'", board));
  assert.ok(await one("SELECT 1 FROM audit WHERE action='share.whiteboard' AND resource_id=?", board));
});

test("view and comment links, revoked and expired links and locked boards cannot edit", async () => {
  const board = await page("whiteboard", "Board 2");
  const viewer = await share(board, "viewer"),
    commenter = await share(board, "commenter");
  assert.equal(await status(() => canvas.syncSharedBoard(viewer, { pageId: board })), 403);
  assert.equal(await status(() => canvas.syncSharedBoard(commenter, { pageId: board })), 403);
  assert.equal(await status(() => canvas.sharedBoardCursor(viewer, { pageId: board, clientId: id(), point: { x: 1, y: 1 } })), 403);
  const token = await share(board, "editor");
  const g = await guest(token, board);
  // Locked: pulling still works, writing does not.
  await run("UPDATE pages SET locked=1 WHERE id=?", board);
  g.items().set("x", item({ type: "sticky", text: "zu spät" }));
  assert.equal(await status(() => g.sync()), 409);
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: board })), 200);
  await run("UPDATE pages SET locked=0 WHERE id=?", board);
  // Expired.
  await run("UPDATE share_links SET expires_at=? WHERE token=?", Date.now() - 1000, token);
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: board })), 410);
  await run("UPDATE share_links SET expires_at=NULL WHERE token=?", token);
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: board })), 200);
  // Password protected: only with the unlock cookie (lib/share-access.ts).
  await command(owner, { action: "share.protect", pageId: board, token, password: "geheim123" });
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: board })), 401);
  await command(owner, { action: "share.protect", pageId: board, token, password: null });
  // Revoked.
  await command(owner, { action: "share.revoke", pageId: board, token });
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: board })), 404);
  assert.ok(!(await boardItems(board)).some((i) => i.id === "x"));
});

test("a link reaches only its own pages: other boards, other kinds, other notebooks", async () => {
  const board = await page("whiteboard", "Shared");
  const other = await page("whiteboard", "Secret board");
  const doc = await page("document", "Doc");
  const token = await share(board, "editor");
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: other })), 404);
  assert.equal(await status(() => canvas.sharedNotebook(token, other)), 404);
  const docToken = await share(doc, "editor");
  assert.equal(await status(() => canvas.syncSharedBoard(docToken, { pageId: doc })), 400);
  // The board's own sub-pages: only those the link includes.
  const child = await page("notebook", "Child notebook", board);
  assert.equal(await status(() => canvas.sharedNotebook(token, child)), 404);
});

test("guests get no ids, records, votes or covered content, and write only what they may", async () => {
  const board = await page("whiteboard", "Leaks");
  const secret = await page("document", "Geheime Seite");
  const shared = await page("document", "Geteilte Seite", board);
  const token = await share(board, "editor", { includeChildren: true });
  const file = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", file, secret, "x.png", "image/png", 1, owner.id);
  const own = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", own, board, "own.png", "image/png", 1, owner.id);
  await memberBoard(board, (map) => {
    map.set("card-secret", item({ type: "card", pageId: secret }));
    map.set("card-shared", item({ type: "card", pageId: shared }));
    map.set("record", item({ type: "card", pageId: secret, rowId: id() }));
    map.set("foreign-image", item({ type: "image", src: `/api/files/${file}` }));
    map.set("own-image", item({ type: "image", src: `/api/files/${own}` }));
    map.set("covered", item({ type: "sticky", text: "Verdeckte Antwort", covered: true }));
    map.set("voted", item({ type: "sticky", text: "Abstimmen", votes: { [owner.id]: true } }));
    map.set("link", item({ type: "shape", link: `/#page=${secret}&item=abc` }));
  });
  const g = await guest(token, board);
  const shown = g.shown();
  assert.equal(shown["card-secret"].pageId, undefined, "pages outside the link are not named");
  assert.equal(shown["card-shared"].pageId, shared);
  assert.equal(shown.record.rowId, undefined);
  assert.equal(shown["foreign-image"].src, undefined, "files of other pages are not served");
  assert.equal(shown["own-image"].src, `/api/share/${token}/files/${own}`);
  assert.equal(shown.covered.text, undefined, "covered notes keep their content");
  assert.equal(shown.voted.votes, undefined);
  assert.equal(shown.link.link, undefined);
  assert.ok(!JSON.stringify(shown).includes(owner.id), "no user ids");
  assert.ok(!JSON.stringify(shown).includes(secret), "no ids of pages outside the link");

  // Escalation attempts: point a card elsewhere, add a card, foreign or
  // script sources and links, rewrite a covered note, vote.
  g.doc.transact(() => {
    g.items().get("card-shared")!.set("pageId", secret);
    g.items().set("new-card", item({ type: "card", pageId: secret }));
    g.items().set("bad-image", item({ type: "image", src: `/api/files/${file}` }));
    g.items().set("data-image", item({ type: "image", src: "data:image/svg+xml,<svg onload=alert(1)>" }));
    g.items().set("web-image", item({ type: "image", src: "https://example.org/a.png" }));
    g.items().set("copy", item({ type: "image", src: `/api/share/${token}/files/${own}` }));
    g.items().set("js", item({ type: "shape", link: "javascript:alert(1)" }));
    g.items().get("covered")!.set("text", "überschrieben");
    g.items().get("covered")!.set("x", 500);
    g.items().get("voted")!.set("votes", { "guest:x": true });
    g.items().get("own-image")!.set("src", `/api/files/${file}`);
  });
  await g.sync();
  const real = new Map((await boardItems(board)).map((i) => [i.id, i]));
  assert.equal(real.get("card-shared")?.pageId, shared);
  assert.ok(!real.has("new-card"), "guests do not add cards");
  assert.equal(real.get("bad-image")?.src, undefined);
  assert.equal(real.get("data-image")?.src, undefined);
  assert.equal(real.get("web-image")?.src, "https://example.org/a.png", "https images like in the app");
  assert.equal(real.get("copy")?.src, `/api/files/${own}`, "a copy of an image on the board keeps it");
  assert.equal(real.get("js")?.link, undefined);
  assert.equal(real.get("covered")?.text, "Verdeckte Antwort");
  assert.equal(real.get("covered")?.x, 500, "covered notes can be moved");
  assert.deepEqual(real.get("voted")?.votes, { [owner.id]: true });
  assert.equal(real.get("own-image")?.src, `/api/files/${own}`);
  assert.equal(real.get("record")?.rowId !== undefined, true, "hidden properties stay");
  // The guest's projection is corrected.
  assert.equal(g.shown()["card-shared"].pageId, shared);
  assert.ok(!g.shown()["new-card"]);
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='blocked.content' AND detail LIKE '%whiteboard%'"));
});

test("comments by guests carry the link's guest name, never someone else's", async () => {
  const board = await page("whiteboard", "Comments");
  const token = await share(board, "editor");
  const g = await guest(token, board);
  g.items().set("pin", item({ type: "comment", messages: [{ id: "m1", author: owner.id, name: "owner", text: "Ich bin der Chef", at: 1 }] }));
  await g.sync();
  const pin = (await boardItems(board)).find((i) => i.id === "pin")!;
  assert.equal(pin.messages?.length, 1);
  assert.equal(pin.messages![0].name, "Gast · Workshop");
  assert.match(pin.messages![0].author, /^guest:/);
});

test("guest pointers are named after the link; members appear under a pseudonym", async () => {
  const board = await page("whiteboard", "Cursors");
  const token = await share(board, "editor");
  const { moveCursor } = await import("../lib/whiteboard-presence");
  const events: string[] = [];
  const stop = canvas.watchSharedBoard(token, board, id(), (e) => events.push(e));
  moveCursor(board, { id: owner.id, name: owner.name }, { x: 5, y: 5 });
  await canvas.sharedBoardCursor(token, { pageId: board, clientId: id(), point: { x: 1, y: 2 } });
  stop();
  const text = events.join("");
  assert.ok(text.includes("member:") && !text.includes(owner.id));
  assert.ok(text.includes("Gast · Workshop"));
});

test("upload endpoints refuse share links of whiteboards and notebooks", async () => {
  const board = await page("whiteboard", "No uploads");
  const notebook = await page("notebook", "No uploads either");
  const doc = await page("document", "Uploads ok");
  const png = new File([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], "a.png", { type: "image/png" });
  for (const pid of [board, notebook]) {
    const token = await share(pid, "editor");
    await assert.rejects(async () => await guestUpload(token, pid, png), (e: Error & { status?: number }) => e.status === 403 && /Gäste/.test(e.message));
  }
  // Documents keep their guest uploads.
  assert.equal(await status(async () => await guestUpload(await share(doc, "editor"), doc, png)), 200);
});

test("an edit link writes on notebook sheets and adds, moves and deletes sheets; others cannot", async () => {
  const notebook = await page("notebook", "Heft");
  const token = await share(notebook, "editor");
  const data = await canvas.sharedNotebook(token, notebook);
  const sheet = data.sheets[0].id;
  const stroke = { id: "st1", type: "pen", color: "#1f2937", width: 2, points: [10, 10, 0.5, 40, 40, 0.5] };
  const picture = { id: "im1", type: "image", x: 0, y: 0, w: 10, h: 10, file: id() };
  const saved = await canvas.saveSharedInk(token, notebook, sheet, { base: 0, doc: { format: "flowplan-ink", version: 1, unit: "pt", pages: { [sheet]: [stroke, picture] } } });
  assert.equal(saved.version, 1);
  const ink = (await pageInkDocs(notebook)).get(sheet)!;
  assert.deepEqual(ink.doc.pages[sheet].map((i) => i.id), ["st1"], "pictures guests did not find on the notebook are dropped");
  assert.equal(ink.version, 1);
  assert.equal((await canvas.sharedInkVersions(token, notebook))[sheet], 1);
  assert.equal((await canvas.sharedInk(token, notebook, sheet)).doc.pages[sheet].length, 1);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='share.ink' AND resource_id=?", notebook));
  // Sheets.
  const added = await canvas.sharedNotebookCommand(token, { pageId: notebook, op: "sheet.add", after: sheet });
  assert.equal(added.sheets.length, 2);
  const order = added.sheets.map((s) => s.id).reverse();
  assert.deepEqual((await canvas.sharedNotebookCommand(token, { pageId: notebook, op: "sheet.move", order })).sheets.map((s) => s.id), order);
  const dup = await canvas.sharedNotebookCommand(token, { pageId: notebook, op: "sheet.duplicate", sheetId: sheet });
  assert.equal(dup.sheets.length, 3);
  assert.equal((await canvas.sharedNotebookCommand(token, { pageId: notebook, op: "sheet.delete", sheetId: sheet })).sheets.length, 2);
  // Other commands are not offered to guests.
  await assert.rejects(async () => await canvas.sharedNotebookCommand(token, { pageId: notebook, op: "paper" }), { name: "ZodError" });
  // View and comment links, locked notebook.
  for (const role of ["viewer", "commenter"] as const) {
    const other = await share(notebook, role);
    assert.equal(await status(() => canvas.sharedNotebook(other, notebook)), 403);
    assert.equal(await status(() => canvas.saveSharedInk(other, notebook, sheet, { base: 1, doc: { pages: {} } })), 403);
    assert.equal(await status(() => canvas.sharedNotebookCommand(other, { pageId: notebook, op: "sheet.add" })), 403);
  }
  await run("UPDATE pages SET locked=1 WHERE id=?", notebook);
  const remaining = (await canvas.sharedNotebook(token, notebook)).sheets[0].id;
  assert.equal(await status(() => canvas.saveSharedInk(token, notebook, remaining, { base: 0, doc: { pages: {} } })), 409);
  assert.equal(await status(() => canvas.sharedNotebookCommand(token, { pageId: notebook, op: "sheet.add" })), 409);
  await run("UPDATE pages SET locked=0 WHERE id=?", notebook);
  // A whiteboard link is no notebook link and the other way round.
  assert.equal(await status(() => canvas.syncSharedBoard(token, { pageId: notebook })), 400);
  // Revoked.
  await command(owner, { action: "share.revoke", pageId: notebook, token });
  assert.equal(await status(() => canvas.saveSharedInk(token, notebook, remaining, { base: 0, doc: { pages: {} } })), 404);
  assert.ok((await all("SELECT 1 FROM page_ink WHERE page_id=?", notebook)).length >= 1);
});

test("notebook sheet links to pages outside the link are not shown", async () => {
  const notebook = await page("notebook", "Links");
  const secret = await page("document", "Geheim");
  const token = await share(notebook, "editor");
  const sheet = (await canvas.sharedNotebook(token, notebook)).sheets[0].id;
  await command(owner, { action: "notebook.sheet.links", pageId: notebook, sheetId: sheet, links: [{ id: "l1", x: 1, y: 1, w: 50, h: 20, target: { page: secret } }, { id: "l2", x: 1, y: 40, w: 50, h: 20, target: { sheet } }] });
  const shown = (await canvas.sharedNotebook(token, notebook)).sheets[0];
  assert.deepEqual(shown.links?.map((l) => l.id), ["l2"]);
});
