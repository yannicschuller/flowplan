// Organising notebooks (lib/notebook-organize.ts, lib/notebook-organize-model.ts):
// titles, bookmarks, links, the table of contents, several sheets at once,
// the notebook's trash, copying and moving sheets into another notebook
// (rights on both, journal PIN), and the helpers of the page overview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-nb-organize-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { notebookSheets, notebookOutline, notebookArchive, importNotebook } = await import("../lib/notebook");
const { notebookPeers, sheetTrash, purgeSheetTrash } = await import("../lib/notebook-organize");
const model = await import("../lib/notebook-organize-model");
const store = await import("../lib/page-ink-store");
const { emptyInk, withPage } = await import("../lib/ink/model");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("org-owner"),
  editor = await account("org-editor"),
  viewer = await account("org-viewer"),
  stranger = await account("org-stranger");
const wid = await createWorkspace(owner.id, "Hefte");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "notebook", parentId?: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title, kind, ...(parentId ? { parentId } : {}) })) as { id: string }).id;
type Answer = {
  sheets: { id: string; title?: string; bookmark?: boolean; links?: { id: string; target: Record<string, string> }[]; paper: Record<string, string>; background: { file: string } | null }[];
  outline: { id: string; sheet: string; title: string; level: number }[];
  created?: string[];
  trashed?: string[];
  ink?: Record<string, { doc: { pages: Record<string, unknown[]> } }>;
};
const nb = async (user: Identity, data: Record<string, unknown>) => (await command(user, data)) as Answer;
const pen = (n: number) => ({ id: `s${n}`, type: "pen" as const, color: "#1f1f1f", width: 1.6, points: [n, n, 0.5, n + 10, n + 2, 0.6] });
const on = (surface: string, ...items: Parameters<typeof withPage>[2]) => withPage(emptyInk(), surface, items);
const threeSheets = async (title: string) => {
  const pid = await create(title);
  const answer = await nb(owner, { action: "notebook.sheet.add", pageId: pid, count: 2 });
  return { pid, ids: answer.sheets.map((s) => s.id) };
};

// ---- Pure helpers ----

test("titles, links and contents entries are cleaned; nesting never skips a level", () => {
  assert.equal(model.cleanTitle("  Kapitel\u0000 1 ‮\n Teil  "), "Kapitel 1 Teil");
  assert.equal(model.cleanTitle("x".repeat(500)).length, model.SHEET_TITLE_MAX);
  assert.equal(model.cleanTitle(42), "");
  const pageId = "0b0f4e0c-7f43-4c2a-9a0e-5d1c2b3a4f5e";
  const links = model.cleanLinks(
    [
      { id: "a", x: 10.123, y: 20, w: 100, h: 30, label: " Zu Blatt 2 ", target: { sheet: "s2" } },
      { id: "b", x: 0, y: 0, w: 50, h: 50, target: { sheet: "gone" } },
      { id: "c", x: 0, y: 0, w: 50, h: 50, target: { page: pageId } },
      { id: "a", x: 0, y: 0, w: 50, h: 50, target: { page: pageId } },
      { id: "d", x: 0, y: 0, w: 1, h: 50, target: { page: pageId } },
      { id: "e", x: 0, y: 0, w: 50, h: 50, target: { page: "not-a-uuid" } },
      { id: "f", x: 0, y: 0, w: 50, h: 50, target: { sheet: "s2", page: pageId } },
      "junk",
    ],
    new Set(["s1", "s2"]),
  );
  assert.deepEqual(links, [
    { id: "a", x: 10.12, y: 20, w: 100, h: 30, label: "Zu Blatt 2", target: { sheet: "s2" } },
    { id: "c", x: 0, y: 0, w: 50, h: 50, target: { page: pageId } },
  ]);
  assert.deepEqual(model.parseLinks("{broken"), []);
  const outline = model.cleanOutline(
    [
      { id: "1", sheet: "s1", title: "Einleitung", level: 2 },
      { id: "2", sheet: "s1", title: "Ziel", level: 2 },
      { id: "3", sheet: "s2", title: "  ", level: 0 },
      { id: "4", sheet: "gone", title: "Weg", level: 0 },
      { id: "5", sheet: "s2", title: "Methode", level: 7, y: 120.456 },
    ],
    new Set(["s1", "s2"]),
  );
  assert.deepEqual(
    outline.map((e) => [e.id, e.level]),
    [["1", 0], ["2", 1], ["5", 2]],
  );
  assert.equal(outline[2].y, 120.46);
});

test("contents: new headings follow the sheets; entries move and indent with their children", () => {
  const order = ["a", "b", "c"];
  let outline: import("../lib/notebook-organize-model").OutlineEntry[] = [
    { id: "1", sheet: "a", title: "A", level: 0, y: 10 },
    { id: "3", sheet: "c", title: "C", level: 0 },
  ];
  outline = model.outlineInsert(outline, { id: "2", sheet: "b", title: "B", level: 0 }, order);
  outline = model.outlineInsert(outline, { id: "1b", sheet: "a", title: "A unten", level: 1, y: 500 }, order);
  outline = model.outlineInsert(outline, { id: "0", sheet: "a", title: "A oben", level: 0, y: 0 }, order);
  assert.deepEqual(outline.map((e) => e.id), ["0", "1", "1b", "2", "3"]);
  // "1" with its child "1b" moves below "2".
  const moved = model.outlineMove(outline, "1", 1);
  assert.deepEqual(moved.map((e) => e.id), ["0", "2", "1", "1b", "3"]);
  assert.deepEqual(model.outlineMove(moved, "1", -1).map((e) => e.id), ["0", "1", "1b", "2", "3"]);
  assert.equal(model.outlineMove(outline, "0", -1), outline);
  // A child does not leave its parent by moving.
  assert.equal(model.outlineMove(outline, "1b", 1), outline);
  const indented = model.outlineIndent(outline, "1", 1);
  assert.deepEqual(indented.map((e) => e.level), [0, 1, 2, 0, 0]);
  assert.equal(model.outlineIndent(outline, "0", 1), outline, "the first entry stays a chapter");
  assert.equal(model.outlineIndent(indented, "1", 1), indented, "never deeper than three levels");
  assert.deepEqual(model.outlineIndent(indented, "1", -1).map((e) => e.level), [0, 0, 1, 0, 0]);
  assert.deepEqual(model.outlineWithout(outline, new Set(["a"])).map((e) => e.id), ["2", "3"]);
});

test("overview helpers: search without accents, Shift ranges, moving several sheets, the grid window", () => {
  const sheets = [
    { id: "a", text: "Übungsblatt Analysis" },
    { id: "b", text: "Klausur ubung" },
    { id: "c", text: "Notizen" },
  ];
  assert.deepEqual(model.searchSheets(sheets, "ubung"), ["a", "b"]);
  assert.deepEqual(model.searchSheets(sheets, "ÜBUNG analysis"), ["a"]);
  assert.deepEqual(model.searchSheets(sheets, "   "), []);
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual([...model.rangeSelect(order, "b", "d", new Set(["a"]))].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual([...model.rangeSelect(order, "d", "b", new Set())].sort(), ["b", "c", "d"]);
  assert.deepEqual([...model.rangeSelect(order, null, "e", new Set())], ["e"]);
  assert.deepEqual(model.moveMany(order, new Set(["b", "d"]), 0), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(model.moveMany(order, new Set(["a", "c"]), 5), ["b", "d", "e", "a", "c"]);
  assert.deepEqual(model.moveMany(order, new Set(["a", "e"]), 3), ["b", "c", "a", "e", "d"]);
  assert.deepEqual(model.moveMany(order, new Set(), 2), order);
  const w = model.gridWindow({ count: 1000, columns: 4, rowHeight: 200, scrollTop: 10_000, height: 800, overscan: 1 });
  assert.deepEqual(w, { columns: 4, rows: 250, first: 49 * 4, last: 55 * 4 + 3, top: 49 * 200, total: 50_000 });
  assert.equal(model.gridWindow({ count: 3, columns: 4, rowHeight: 200, scrollTop: 0, height: 800 }).last, 2);
  assert.equal(model.gridColumns(700, 150, 16), 4);
  assert.equal(model.gridColumns(100, 150, 16), 1);
});

// ---- Commands ----

test("titles and bookmarks: editors set them, readers see them, viewers cannot change them", async () => {
  const { pid, ids } = await threeSheets("Lesezeichen");
  await nb(owner, { action: "notebook.sheet.meta", pageId: pid, sheetIds: [ids[1]], title: "  Kapitel 2 " });
  const answer = await nb(editor, { action: "notebook.sheet.meta", pageId: pid, sheetIds: [ids[0], ids[2]], bookmark: true });
  assert.deepEqual(
    answer.sheets.map((s) => [s.title ?? "", !!s.bookmark]),
    [["", true], ["Kapitel 2", false], ["", true]],
  );
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheet.meta", pageId: pid, sheetIds: ids, title: "x" }), { status: 400 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheet.meta", pageId: pid, sheetIds: ["nope"], bookmark: true }), { status: 404 });
  await assert.rejects(async () => await nb(viewer, { action: "notebook.sheet.meta", pageId: pid, sheetIds: [ids[0]], bookmark: false }), { status: 403 });
  const data = (await pageData(viewer, pid)) as { notebook: { sheets: { title?: string; bookmark?: boolean }[] } };
  assert.equal(data.notebook.sheets[1].title, "Kapitel 2");
  assert.equal(data.notebook.sheets[0].bookmark, true);
});

test("links on a sheet point to sheets of this notebook or to pages", async () => {
  const { pid, ids } = await threeSheets("Links");
  const other = await create("Ziel", "document");
  const answer = await nb(owner, {
    action: "notebook.sheet.links",
    pageId: pid,
    sheetId: ids[0],
    links: [
      { id: "l1", x: 40, y: 40, w: 160, h: 28, label: "Zu Blatt 3", target: { sheet: ids[2] } },
      { id: "l2", x: 40, y: 90, w: 160, h: 28, target: { page: other } },
      { id: "l3", x: 40, y: 140, w: 160, h: 28, target: { sheet: "elsewhere" } },
    ],
  });
  assert.deepEqual(answer.sheets[0].links?.map((l) => l.id), ["l1", "l2"]);
  // A link to a deleted sheet is no longer shown.
  await nb(owner, { action: "notebook.sheet.delete", pageId: pid, sheetId: ids[2] });
  assert.deepEqual((await notebookSheets(pid))[0].links?.map((l) => l.id), ["l2"]);
});

test("table of contents: set as a whole, headings added in sheet order, entries of deleted sheets hidden", async () => {
  const { pid, ids } = await threeSheets("Inhalt");
  let answer = await nb(owner, { action: "notebook.outline.add", pageId: pid, sheetId: ids[2], title: "Schluss" });
  answer = await nb(owner, { action: "notebook.outline.add", pageId: pid, sheetId: ids[0], title: "Anfang" });
  answer = await nb(editor, { action: "notebook.outline.add", pageId: pid, sheetId: ids[0], title: "Unterpunkt", level: 1, y: 300 });
  assert.deepEqual(answer.outline.map((e) => [e.title, e.level]), [["Anfang", 0], ["Unterpunkt", 1], ["Schluss", 0]]);
  await assert.rejects(async () => await nb(owner, { action: "notebook.outline.add", pageId: pid, sheetId: ids[0], title: " " }), { status: 400 });
  await assert.rejects(async () => await nb(viewer, { action: "notebook.outline.add", pageId: pid, sheetId: ids[0], title: "x" }), { status: 403 });
  const renamed = answer.outline.map((e) => (e.title === "Schluss" ? { ...e, title: "Ende" } : e)).reverse();
  answer = await nb(owner, { action: "notebook.outline", pageId: pid, outline: renamed });
  assert.deepEqual(answer.outline.map((e) => [e.title, e.level]), [["Ende", 0], ["Unterpunkt", 1], ["Anfang", 0]]);
  // Deleting the sheet hides its entries; restoring brings them back.
  const deleted = await nb(owner, { action: "notebook.sheet.delete", pageId: pid, sheetId: ids[0] });
  assert.deepEqual((await notebookOutline(pid)).map((e) => e.title), ["Ende"]);
  await nb(owner, { action: "notebook.trash.restore", pageId: pid, trashIds: deleted.trashed });
  assert.deepEqual((await notebookOutline(pid)).map((e) => e.title), ["Ende", "Unterpunkt", "Anfang"]);
});

test("several sheets: duplicate after the last one, delete into the trash, restore with ink and place", async () => {
  const { pid, ids } = await threeSheets("Mehrere");
  await store.writeSurface(pid, ids[0], on(ids[0], pen(1), { id: "sticker", type: "image", sticker: "heart", x: 5, y: 5, w: 40, h: 40 }), "Erkannt", owner.id);
  await nb(owner, { action: "notebook.sheet.meta", pageId: pid, sheetIds: [ids[0]], title: "Erstes", bookmark: true });
  const dup = await nb(owner, { action: "notebook.sheets.duplicate", pageId: pid, sheetIds: [ids[2], ids[0]] });
  assert.equal(dup.created?.length, 2);
  assert.deepEqual(dup.sheets.map((s) => s.id), [ids[0], ids[1], ids[2], ...dup.created!]);
  assert.equal(dup.sheets[3].title, "Erstes");
  assert.equal(dup.ink?.[dup.created![0]].doc.pages[dup.created![0]].length, 2);

  const del = await nb(editor, { action: "notebook.sheets.delete", pageId: pid, sheetIds: [ids[0], ids[2]] });
  assert.equal(del.trashed?.length, 2);
  assert.deepEqual(del.sheets.map((s) => s.id), [ids[1], ...dup.created!]);
  assert.equal(await one("SELECT 1 FROM page_ink WHERE page_id=? AND surface=?", pid, ids[0]), undefined);
  const page = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", pid))!;
  const trash = await sheetTrash(page);
  assert.deepEqual(trash.map((t) => t.sheet).sort(), [ids[0], ids[2]].sort());
  assert.equal(trash.find((t) => t.sheet === ids[0])?.title, "Erstes");
  // Not every sheet: one stays.
  await assert.rejects(
    async () => await nb(owner, { action: "notebook.sheets.delete", pageId: pid, sheetIds: [ids[1], ...dup.created!] }),
    { status: 400 },
  );
  await assert.rejects(async () => await nb(viewer, { action: "notebook.trash.restore", pageId: pid, trashIds: del.trashed }), { status: 403 });
  const back = await nb(owner, { action: "notebook.trash.restore", pageId: pid, trashIds: del.trashed });
  assert.deepEqual(back.created?.sort(), [ids[0], ids[2]].sort(), "under their former ids");
  assert.deepEqual(back.sheets.map((s) => s.id), [ids[0], ids[1], ids[2], ...dup.created!]);
  const ink = await store.readPageInk(owner, pid, ids[0]);
  assert.equal(ink.doc.pages[ids[0]].length, 2);
  assert.ok(ink.doc.pages[ids[0]].some((i) => i.type === "image"), "pictures come back from the trash");
  assert.equal(ink.recognized, "Erkannt");
  assert.equal(back.sheets[0].bookmark, true);
  assert.equal((await sheetTrash(page)).length, 0);
  await assert.rejects(async () => await nb(owner, { action: "notebook.trash.restore", pageId: pid, trashIds: del.trashed }), { status: 404 });
  // After 30 days the trash forgets them.
  const again = await nb(owner, { action: "notebook.sheets.delete", pageId: pid, sheetIds: [ids[1]] });
  await purgeSheetTrash(pid, Date.now() + 31 * 24 * 60 * 60 * 1000);
  assert.equal((await sheetTrash(page)).length, 0);
  await assert.rejects(async () => await nb(owner, { action: "notebook.trash.restore", pageId: pid, trashIds: again.trashed }), { status: 404 });
});

test("copy and move sheets into another notebook: rights on both, ink, paper as it looks, PDF backgrounds, contents", async () => {
  const { pid: from, ids } = await threeSheets("Quelle");
  const to = await create("Ziel");
  const [targetFirst] = await notebookSheets(to);
  await nb(owner, { action: "notebook.paper", pageId: to, paper: { template: "grid" } });
  await nb(owner, { action: "notebook.sheet.meta", pageId: from, sheetIds: [ids[1]], title: "Wichtig" });
  await nb(owner, { action: "notebook.outline.add", pageId: from, sheetId: ids[1], title: "Kapitel" });
  await nb(owner, {
    action: "notebook.sheet.links",
    pageId: from,
    sheetId: ids[1],
    links: [
      { id: "in", x: 1, y: 1, w: 20, h: 20, target: { sheet: ids[2] } },
      { id: "out", x: 1, y: 30, w: 20, h: 20, target: { sheet: ids[0] } },
    ],
  });
  // A PDF background on the third sheet.
  const file = id();
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
  writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", file), "%PDF-1.4 test");
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", file, from, "a.pdf", "application/pdf", 13, owner.id);
  await run("UPDATE notebook_sheets SET background=? WHERE id=?", JSON.stringify({ file, page: 2, width: 595, height: 842 }), ids[2]);
  // A picture on the second sheet, an own paper template on it too.
  const [picture, paperFile] = [id(), id()];
  for (const f of [picture, paperFile]) {
    writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", f), "png");
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by,width,height) VALUES(?,?,?,?,?,?,?,?)", f, from, "a.png", "image/png", 3, owner.id, 2, 2);
  }
  await store.writeSurface(from, ids[1], on(ids[1], pen(3), { id: "pic", type: "image", file: picture, x: 10, y: 10, w: 50, h: 50 }), "", owner.id);
  await run("UPDATE notebook_sheets SET paper=? WHERE id=?", JSON.stringify({ image: { file: paperFile, kind: "image", width: 595, height: 842, fit: "stretch" } }), ids[1]);

  // Viewers may not write into a notebook; strangers see neither.
  await assert.rejects(async () => await nb(viewer, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[1]], mode: "copy" }), { status: 403 });
  await assert.rejects(async () => await nb(stranger, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[1]], mode: "copy" }), { status: 403 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheets.transfer", pageId: from, targetPageId: from, sheetIds: [ids[1]], mode: "copy" }), { status: 400 });
  const doc = await create("Dokument", "document");
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheets.transfer", pageId: from, targetPageId: doc, sheetIds: [ids[1]], mode: "copy" }), { status: 400 });

  const copied = (await command(editor, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[1], ids[2]], mode: "copy", after: null })) as Answer & { copied: number };
  assert.equal(copied.copied, 2);
  assert.equal(copied.sheets.length, 3, "copying leaves the source as it was");
  const target = await notebookSheets(to);
  assert.equal(target.length, 3);
  assert.equal(target[0].id, targetFirst.id);
  const [a, b] = [target[1], target[2]];
  // The source's default paper (lined) stays lined in a grid notebook; the
  // own template and the picture come along as copies on the target page.
  const { image: ownPaper, ...lines } = a.paper as Record<string, unknown> & { image?: { file: string } };
  assert.deepEqual(lines, { template: "lined-college" });
  assert.ok(ownPaper && ownPaper.file !== paperFile);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", ownPaper.file))?.page_id, to);
  const pic = (await store.readPageInk(owner, to, a.id)).doc.pages[a.id].find((i) => i.type === "image");
  assert.ok(pic && pic.type === "image" && pic.file !== picture);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", pic.file!))?.page_id, to);
  assert.equal(a.title, "Wichtig");
  assert.deepEqual(a.links?.map((l) => [l.id, l.target]), [["in", { sheet: b.id }]], "a link to a sheet left behind goes");
  assert.equal((await store.readPageInk(owner, to, a.id)).doc.pages[a.id].length, 2);
  assert.ok(b.background && b.background.file !== file, "the PDF is copied onto the target page");
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", b.background!.file))?.page_id, to);
  assert.deepEqual((await notebookOutline(to)).map((e) => [e.title, e.sheet]), [["Kapitel", a.id]]);

  // Moving needs writing the source as well.
  await assert.rejects(async () => await nb(viewer, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[0]], mode: "move" }), { status: 403 });
  const moved = (await command(owner, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[0]], mode: "move", at: "start" })) as Answer;
  assert.deepEqual(moved.sheets.map((s) => s.id), [ids[1], ids[2]]);
  assert.equal((await notebookSheets(to))[0].paper.template, "lined-college");
  await assert.rejects(
    async () => await nb(owner, { action: "notebook.sheets.transfer", pageId: from, targetPageId: to, sheetIds: [ids[1], ids[2]], mode: "move" }),
    { status: 400 },
    "the source keeps one sheet",
  );
});

test("a notebook behind a journal PIN takes no sheets until the PIN is entered", async () => {
  const journal = await create("Tagebuch", "journal");
  const locked = await create("Privat", "notebook", journal);
  const { pid: from, ids } = await threeSheets("Offen");
  await command(owner, { action: "journal.lock", pageId: journal, pin: "123456" });
  await assert.rejects(
    async () => await nb(editor, { action: "notebook.sheets.transfer", pageId: from, targetPageId: locked, sheetIds: [ids[0]], mode: "copy" }),
    { status: 423 },
  );
  const page = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", from))!;
  const peers = await notebookPeers(editor, page);
  assert.equal(peers.pages.find((p) => p.id === locked)?.writable ?? false, false);
  assert.equal(peers.pages.find((p) => p.id === from)?.writable, false, "not into itself");
  assert.equal(peers.pages.find((p) => p.id === locked)?.kind, "notebook");
  const viewerPeers = await notebookPeers(viewer, page);
  assert.ok(viewerPeers.pages.length > 0);
  assert.ok(viewerPeers.pages.every((p) => !p.writable), "viewers write nowhere");
});

test("duplicates and archives keep titles, bookmarks, links and the contents, pointing to the new sheets", async () => {
  const { pid, ids } = await threeSheets("Archiv");
  await nb(owner, { action: "notebook.sheet.meta", pageId: pid, sheetIds: [ids[2]], title: "Drei", bookmark: true });
  await nb(owner, { action: "notebook.sheet.links", pageId: pid, sheetId: ids[0], links: [{ id: "x", x: 0, y: 0, w: 30, h: 30, target: { sheet: ids[2] } }] });
  await nb(owner, { action: "notebook.outline.add", pageId: pid, sheetId: ids[2], title: "Schluss" });
  const check = async (copy: string) => {
    const sheets = await notebookSheets(copy);
    assert.equal(sheets.length, 3);
    assert.ok(!ids.includes(sheets[2].id));
    assert.equal(sheets[2].title, "Drei");
    assert.equal(sheets[2].bookmark, true);
    assert.deepEqual(sheets[0].links?.[0].target, { sheet: sheets[2].id });
    assert.deepEqual((await notebookOutline(copy)).map((e) => [e.title, e.sheet]), [["Schluss", sheets[2].id]]);
  };
  await check(((await command(owner, { action: "page.duplicate", pageId: pid })) as { id: string }).id);
  const archive = await notebookArchive(pid);
  assert.deepEqual(archive.sheets[0].links, [{ id: "x", x: 0, y: 0, w: 30, h: 30, target: { sheet: "_2" } }]);
  const target = await create("Import");
  await importNotebook(target, JSON.parse(JSON.stringify(archive)), new Map(), owner.id);
  await check(target);
  // An archive from before (no titles, links, contents) still imports.
  const old = { paper: archive.paper, sheets: archive.sheets.map((s) => ({ paper: s.paper })) };
  const plain = await create("Alt");
  await importNotebook(plain, old, new Map(), owner.id);
  assert.deepEqual((await notebookSheets(plain)).map((s) => [s.title, s.bookmark, s.links]), [[undefined, undefined, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined]]);
});

test("the laser trail: newer segments heavier, old ones and jumps left out", async () => {
  const { pointerTrail } = await import("../lib/notebook-pointer");
  const points = [
    { x: 0, y: 0, t: 0 },
    { x: 10, y: 0, t: 100 },
    { x: 20, y: 0, t: 600 },
    { x: 30, y: 0, t: 650 },
  ];
  const trail = pointerTrail(points, 700, 700);
  // 0→10 is old (weight 1 - 600/700), 10→20 is a pause of 500 ms: broken.
  assert.deepEqual(trail.map((s) => [s.x1, s.x2, s.weight]), [[0, 10, 0.14], [20, 30, 0.93]]);
  assert.deepEqual(pointerTrail(points, 2000, 700), []);
});
