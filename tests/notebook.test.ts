// Notebooks (lib/notebook.ts, lib/notebook-paper.ts) and the ink of page
// surfaces (lib/page-ink-store.ts): paper geometry, sheet order, storage
// and migration, merging of concurrent saves, recognised text in search,
// PDF import and export, copies and archives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { Identity } from "../lib/types";
import { samplePdf } from "./helpers/pdf";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notebook-"));
const { run, id, one, all, tableNames, tableColumns } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const paper = await import("../lib/notebook-paper");
const { notebookData, notebookSheets, pdfImportSheets, placeSheets, sheetPlace, notebookArchive, importNotebook, notebookText, MAX_SHEETS } = await import("../lib/notebook");
const store = await import("../lib/page-ink-store");
const { saveFileInk, saveFileRecognized, readFileInk } = await import("../lib/ink-store");
const { processSearchIndex, searchWorkspace } = await import("../lib/search-index");
const { emptyInk, withPage } = await import("../lib/ink/model");
const { mergeInk, mergePage } = await import("../lib/ink/merge");
const { cleanRecognizedText, cleanRecognizedMap } = await import("../lib/ink/recognized");
const { recognitionRequest, parseRecognition, convertedTextPlacement } = await import("../lib/ink/recognition");
const { notebookPdf, notebookPdfSheets } = await import("../lib/ink/notebook-pdf");
const { inkSvg } = await import("../lib/ink/svg");
const { duplicatePageTree } = await import("../lib/page-tree");
const { freshLinkedIds } = await import("../lib/linked-paste");
const { htmlState, cleanHtml } = await import("../lib/document-server");
const { exportMarkdown } = await import("../lib/markdown-export");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { readExportZip } = await import("./helpers/read-export-zip");
const { withInkPictures } = await import("../lib/ink-export");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("nb-owner"),
  editor = await account("nb-editor"),
  viewer = await account("nb-viewer"),
  stranger = await account("nb-stranger");
const wid = await createWorkspace(owner.id, "Hefte");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "notebook") =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title, kind })) as { id: string }).id;
type Sheets = { sheets: { id: string; position: number; paper: Record<string, string>; background: unknown }[]; created?: string[] };
const nb = async (user: Identity, data: Record<string, unknown>) => (await command(user, data)) as Sheets;
const pen = (n: number, extra: Partial<{ color: string }> = {}) => ({
  id: `s${n}`,
  type: "pen" as const,
  color: extra.color || "#1f1f1f",
  width: 1.6,
  points: [n, n, 0.5, n + 10, n + 2, 0.6, n + 20, n + 1, 0.55],
});
const on = (surface: string, ...items: Parameters<typeof withPage>[2]) => withPage(emptyInk(), surface, items);

// ---- Paper ----

test("paper templates: ruling, grid, dots, Cornell and staves stay on the sheet", () => {
  const a4 = paper.paperSize({ size: "a4", orientation: "portrait" });
  assert.deepEqual(a4, { width: 595.28, height: 841.89 });
  assert.deepEqual(paper.paperSize({ size: "letter", orientation: "landscape" }), { width: 792, height: 612 });
  const inside = (layout: Awaited<ReturnType<typeof paper.paperLayout>>) =>
    layout.shapes.every((s) =>
      s.type === "line"
        ? [s.x1, s.x2].every((x) => x >= 0 && x <= layout.width + 0.01) && [s.y1, s.y2].every((y) => y >= 0 && y <= layout.height + 0.01)
        : s.x > 0 && s.x < layout.width && s.y > 0 && s.y < layout.height,
    );
  for (const template of paper.PAPER_TEMPLATES)
    for (const size of paper.PAPER_SIZES)
      for (const orientation of paper.PAPER_ORIENTATIONS) {
        const layout = paper.paperLayout({ template, size, orientation, color: "light" });
        assert.ok(inside(layout), `${template} ${size} ${orientation}`);
        assert.equal(layout.width, paper.paperSize({ size, orientation }).width);
      }
  const rules = (template: "lined-college" | "lined-wide") =>
    paper
      .paperLayout({ ...paper.DEFAULT_PAPER, template })
      .shapes.filter((s) => s.type === "line" && s.y1 === s.y2)
      .map((s) => (s.type === "line" ? s.y1 : 0));
  const college = rules("lined-college");
  assert.equal(college[0], 72);
  assert.ok(Math.abs(college[1] - college[0] - 20.25) < 0.02, "college ruled: 9/32 in");
  assert.ok(Math.abs(rules("lined-wide")[1] - rules("lined-wide")[0] - 24.75) < 0.02, "wide ruled: 11/32 in");
  assert.ok(college.length > rules("lined-wide").length);
  // Margin line on lined paper.
  assert.ok(paper.paperLayout({ ...paper.DEFAULT_PAPER }).shapes.some((s) => s.type === "line" && s.x1 === 90 && s.x2 === 90));
  // Grid: 5 mm.
  const grid = paper.paperLayout({ ...paper.DEFAULT_PAPER, template: "grid" });
  const xs = grid.shapes.filter((s) => s.type === "line" && s.x1 === s.x2).map((s) => (s.type === "line" ? s.x1 : 0));
  assert.ok(Math.abs(xs[1] - xs[0] - 5 * paper.MM) < 0.02);
  assert.ok(Math.abs(xs[0] - (grid.width - xs[xs.length - 1])) < 0.02, "centred");
  const dots = paper.paperLayout({ ...paper.DEFAULT_PAPER, template: "dotted" }).shapes;
  assert.ok(dots.length > 500 && dots.every((s) => s.type === "dot"));
  const cornell = paper.paperLayout({ ...paper.DEFAULT_PAPER, template: "cornell" });
  const cue = cornell.shapes.find((s) => s.type === "line" && s.x1 === s.x2);
  assert.ok(cue && cue.type === "line" && cue.x1 > 100 && cue.x1 < cornell.width / 2, "cue column");
  // Music: 12 staves of 5 equally spaced lines (portrait), 8 in landscape.
  const staves = (orientation: "portrait" | "landscape") => paper.paperLayout({ ...paper.DEFAULT_PAPER, template: "music", orientation }).shapes;
  assert.equal(staves("portrait").length, 60);
  assert.equal(staves("landscape").length, 40);
  const first = staves("portrait").slice(0, 5).map((s) => (s.type === "line" ? s.y1 : 0));
  const gaps = first.slice(1).map((y, i) => Math.round((y - first[i]) * 10) / 10);
  assert.equal(new Set(gaps).size, 1);
  // Dark paper: dark background, the same geometry.
  const dark = paper.paperLayout({ ...paper.DEFAULT_PAPER, color: "dark" });
  assert.equal(dark.background, paper.PAPER_TONES.dark.background);
  assert.equal(dark.shapes.length, paper.paperLayout(paper.DEFAULT_PAPER).shapes.length);
  // Overrides: unknown values are dropped, the sheet wins over the notebook.
  assert.deepEqual(paper.cleanPaper({ template: "x", size: "letter", color: "dark", extra: 1 }), { size: "letter", color: "dark" });
  assert.deepEqual(paper.effectivePaper(paper.DEFAULT_PAPER, { template: "grid" }), { ...paper.DEFAULT_PAPER, template: "grid" });
  // Drawing blocks: lines without margins, transparent.
  const block = paper.blockPaperLayout("lined", { width: 720, height: 300 });
  assert.equal(block.background, "transparent");
  assert.ok(block.shapes.length >= 10 && block.shapes.every((s) => s.type === "line" && s.x1 === 0));
  assert.ok(!paper.paperSvg(block).includes("<rect"));
});

test("sheet order: insert after, move, same set", () => {
  assert.deepEqual(paper.insertAfter(["a", "b", "c"], "x", "a"), ["a", "x", "b", "c"]);
  assert.deepEqual(paper.insertAfter(["a", "b"], "x", null), ["a", "b", "x"]);
  assert.deepEqual(paper.insertAfter(["a", "b"], "x", "missing"), ["a", "b", "x"]);
  assert.deepEqual(paper.moveTo(["a", "b", "c", "d"], "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(paper.moveTo(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(paper.moveTo(["a", "b", "c"], "b", 99), ["a", "c", "b"]);
  assert.ok(paper.sameSheets(["a", "b"], ["b", "a"]));
  assert.ok(!paper.sameSheets(["a", "b"], ["a", "a"]));
  assert.ok(!paper.sameSheets(["a", "b"], ["a", "b", "c"]));
});

// ---- Storage ----

test("schema: notebook tables and the recognised text of PDF ink exist", async () => {
  for (const table of ["notebooks", "notebook_sheets", "page_ink", "page_ink_versions"])
    assert.ok((await tableNames()).includes(table), table);
  const columns = await tableColumns("file_ink");
  assert.ok(columns.includes("recognized"));
});

test("a new notebook has one sheet; sheets are added, duplicated, reordered, re-papered and deleted", async () => {
  const pid = await create("Physik");
  const data = (await pageData(owner, pid)) as { notebook: Awaited<ReturnType<typeof notebookData>>; page: { kind: string; icon: string } };
  assert.equal(data.page.kind, "notebook");
  assert.equal(data.page.icon, "notebook");
  assert.equal(data.notebook.sheets.length, 1);
  assert.deepEqual(data.notebook.paper, paper.DEFAULT_PAPER);
  assert.equal(data.notebook.canEdit, true);
  const [first] = data.notebook.sheets;

  const added = await nb(editor, { action: "notebook.sheet.add", pageId: pid, after: null, paper: { template: "grid" } });
  const second = added.created![0];
  assert.deepEqual(added.sheets.map((s) => s.id), [first.id, second]);
  assert.deepEqual(added.sheets[1].paper, { template: "grid" });
  // After the first: between them.
  const third = (await nb(owner, { action: "notebook.sheet.add", pageId: pid, after: first.id })).created![0];
  assert.deepEqual((await notebookSheets(pid)).map((s) => s.id), [first.id, third, second]);

  // Ink on the first, then a duplicate carries it.
  await store.writeSurface(pid, first.id, on(first.id, pen(1)), "", owner.id);
  const dup = (await nb(owner, { action: "notebook.sheet.duplicate", pageId: pid, sheetId: first.id })) as Sheets & { ink: Record<string, { doc: { pages: Record<string, unknown[]> } }> };
  const copy = dup.created![0];
  assert.deepEqual(dup.sheets.map((s) => s.id), [first.id, copy, third, second]);
  assert.equal(dup.ink[copy].doc.pages[copy].length, 1);
  assert.equal((await store.readPageInk(viewer, pid, copy)).doc.pages[copy].length, 1);

  await nb(owner, { action: "notebook.sheet.move", pageId: pid, order: [second, first.id, copy, third] });
  assert.deepEqual((await notebookSheets(pid)).map((s) => s.id), [second, first.id, copy, third]);
  // Only a reorder of the same sheets.
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheet.move", pageId: pid, order: [second, first.id] }), { status: 409 });

  await nb(owner, { action: "notebook.sheet.paper", pageId: pid, sheetIds: [third], paper: { template: "music", orientation: "landscape" } });
  assert.deepEqual((await notebookSheets(pid)).find((s) => s.id === third)!.paper, { template: "music", orientation: "landscape" });
  await nb(owner, { action: "notebook.sheet.paper", pageId: pid, sheetIds: [third], paper: null });
  assert.deepEqual((await notebookSheets(pid)).find((s) => s.id === third)!.paper, {});
  await nb(owner, { action: "notebook.paper", pageId: pid, paper: { color: "dark", template: "dotted" }, all: true });
  assert.equal(((await pageData(owner, pid)) as { notebook: { paper: { color: string } } }).notebook.paper.color, "dark");
  assert.deepEqual((await notebookSheets(pid)).find((s) => s.id === second)!.paper, {}, "for all sheets");

  await nb(owner, { action: "notebook.sheet.delete", pageId: pid, sheetId: copy });
  assert.equal((await notebookSheets(pid)).length, 3);
  assert.equal(await one("SELECT 1 FROM page_ink WHERE surface=?", copy), undefined, "its ink goes with it");
  assert.deepEqual((await notebookSheets(pid)).map((s) => s.position), [0, 1, 2]);

  // Viewers read, strangers nothing.
  await assert.rejects(async () => await nb(viewer, { action: "notebook.sheet.add", pageId: pid }), { status: 403 });
  await assert.rejects(async () => await pageData(stranger, pid), { status: 403 });
  assert.equal(((await pageData(viewer, pid)) as { notebook: { canEdit: boolean } }).notebook.canEdit, false);
  // At least one sheet.
  for (const s of (await notebookSheets(pid)).slice(1)) await nb(owner, { action: "notebook.sheet.delete", pageId: pid, sheetId: s.id });
  await assert.rejects(async () => await nb(owner, { action: "notebook.sheet.delete", pageId: pid, sheetId: (await notebookSheets(pid))[0].id }), { status: 400 });
  assert.ok(MAX_SHEETS >= 500);
});

test("page ink: versions, three-way merge of concurrent saves, permissions, locked pages", async () => {
  const pid = await create("Gemeinsam");
  const sheet = (await notebookSheets(pid))[0].id;
  await assert.rejects(async () => await store.savePageInk(viewer, pid, sheet, { base: 0, doc: on(sheet, pen(1)) }), { status: 403 });
  await assert.rejects(async () => await store.savePageInk(owner, pid, "unknown-sheet", { base: 0, doc: on("unknown-sheet", pen(1)) }), { status: 404 });
  await assert.rejects(async () => await store.savePageInk(owner, pid, "../x", { base: 0, doc: {} }), { status: 400 });
  const a = await store.savePageInk(owner, pid, sheet, { base: 0, doc: on(sheet, pen(1), pen(2)) });
  assert.deepEqual(a, { version: 1, conflict: null });
  // Both start from version 1: the owner adds a stroke, the editor removes one and adds another.
  const mine = await store.savePageInk(owner, pid, sheet, { base: 1, doc: on(sheet, pen(1), pen(2), pen(3)) });
  assert.equal(mine.version, 2);
  const theirs = await store.savePageInk(editor, pid, sheet, { base: 1, doc: on(sheet, pen(2), pen(4)) });
  assert.equal(theirs.version, 3);
  assert.equal(theirs.conflict?.by, "nb-owner");
  assert.deepEqual(theirs.doc!.pages[sheet].map((i) => i.id), ["s2", "s3", "s4"]);
  const now = await store.readPageInk(viewer, pid, sheet);
  assert.deepEqual(now.doc.pages[sheet].map((i) => i.id), ["s2", "s3", "s4"]);
  assert.equal(now.canEdit, false);
  assert.deepEqual(await store.pageInkVersions(viewer, pid), { [sheet]: 3 });
  assert.equal((await store.pageInkHistory(owner, pid, sheet))[0].version, 3);
  assert.deepEqual((await store.pageInkVersion(owner, pid, sheet, 2)).doc.pages[sheet].map((i) => i.id), ["s1", "s2", "s3"]);
  // Other page keys are not stored.
  await store.savePageInk(owner, pid, sheet, { base: 3, doc: { ...on(sheet, pen(5)), pages: { [sheet]: [pen(5)], other: [pen(6)] } } });
  assert.deepEqual(Object.keys((await store.readPageInk(owner, pid, sheet)).doc.pages), [sheet]);
  await run("UPDATE pages SET locked=1 WHERE id=?", pid);
  try {
    assert.equal((await store.readPageInk(owner, pid, sheet)).canEdit, false);
    await assert.rejects(async () => await store.savePageInk(owner, pid, sheet, { base: 4, doc: on(sheet) }), { status: 409 });
  } finally {
    await run("UPDATE pages SET locked=0 WHERE id=?", pid);
  }
  // A database page has no surfaces.
  const db = await create("Tabelle", "database");
  await assert.rejects(async () => await store.readPageInk(owner, db, "x"), { status: 400 });
});

test("merge: additions on both sides, deletions, edits", () => {
  const base = [pen(1), pen(2), pen(3)];
  const moved = { ...pen(2), points: [0, 0, 0.5, 5, 5, 0.5] };
  // Ours: delete 1, change 2, add 9. Theirs: delete 3, add 7.
  const out = mergePage(base, [moved, pen(3), pen(9)], [pen(1), pen(2), pen(7)]);
  assert.deepEqual(out.map((i) => i.id), ["s2", "s7", "s9"]);
  assert.deepEqual(out[0], moved);
  // A deletion does not win over the other side's change.
  assert.deepEqual(mergePage(base, [pen(1), pen(3)], [pen(1), moved, pen(3)]).map((i) => i.id), ["s1", "s2", "s3"]);
  const doc = mergeInk(on("a", pen(1)), on("a", pen(1), pen(2)), withPage(on("a", pen(1)), "b", [pen(5)]));
  assert.deepEqual(Object.keys(doc.pages).sort(), ["a", "b"]);
});

test("recognised text: cleaned and capped, stale answers dropped, found by search", async () => {
  assert.equal(cleanRecognizedText("  Hallo\u0000 <b>Welt</b>‮  \n\n\n\nzwei "), "Hallo <b>Welt</b>\n\nzwei");
  assert.equal(cleanRecognizedText(42), "");
  assert.equal(cleanRecognizedText("x".repeat(10000)).length, 4000);
  assert.deepEqual(cleanRecognizedMap({ "1": "eins", "../x": "no", "2": 5 }), { "1": "eins" });

  const pid = await create("Vorlesung");
  const sheet = (await notebookSheets(pid))[0].id;
  const saved = await store.savePageInk(owner, pid, sheet, { base: 0, doc: on(sheet, pen(1)) });
  assert.deepEqual(await store.savePageRecognized(owner, pid, sheet, { version: saved.version, recognized: "Quantenverschränkung erklärt" }), { saved: true });
  await assert.rejects(async () => await store.savePageRecognized(viewer, pid, sheet, { version: saved.version, recognized: "x" }), { status: 403 });
  assert.ok((await searchWorkspace(viewer, wid, "Quantenverschränkung")).some((r) => r.id === pid));
  // An answer for an older state is dropped.
  const next = await store.savePageInk(owner, pid, sheet, { base: saved.version, doc: on(sheet, pen(1), pen(2)) });
  assert.deepEqual(await store.savePageRecognized(owner, pid, sheet, { version: saved.version, recognized: "veraltet" }), { saved: false });
  assert.equal((await store.readPageInk(owner, pid, sheet)).recognized, "Quantenverschränkung erklärt");
  // Sent with the ink, it belongs to that state; ink gone, text gone.
  await store.savePageInk(owner, pid, sheet, { base: next.version, doc: on(sheet), recognized: "leer" });
  assert.equal((await store.readPageInk(owner, pid, sheet)).recognized, "");
  assert.equal((await searchWorkspace(owner, wid, "Quantenverschränkung")).filter((r) => r.id === pid).length, 0);
  // Text typed on a sheet is found too.
  await store.savePageInk(owner, pid, sheet, { base: next.version + 1, doc: on(sheet, { id: "t", type: "text", color: "#1f1f1f", size: 14, x: 1, y: 1, text: "Klausurtermin" }) });
  assert.ok((await searchWorkspace(owner, wid, "Klausurtermin")).some((r) => r.id === pid));
  assert.deepEqual(await notebookText(pid), ["Klausurtermin"]);
});

test("drawing blocks: ink keyed by the block, searched while the block is in the document, copies start from their source", async () => {
  const doc = await create("Protokoll", "document");
  const html = `<p>Skizze:</p><div data-ink-block="ink-a1" data-ink-height="300" data-ink-paper="lined" data-ink-page="${doc}"></div>`;
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", cleanHtml(html), htmlState(html), doc);
  assert.ok(String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", doc))?.html).includes('data-ink-block="ink-a1"'), "kept by the sanitizer");
  const saved = await store.savePageInk(editor, doc, "ink-a1", { base: 0, doc: on("ink-a1", pen(1)) });
  await store.savePageRecognized(editor, doc, "ink-a1", { version: saved.version, recognized: "Lieferkette" });
  assert.ok((await searchWorkspace(owner, wid, "Lieferkette")).some((r) => r.id === doc));
  // Removed from the document: no longer found.
  await run("UPDATE documents SET html='<p>Skizze:</p>' WHERE page_id=?", doc);
  assert.equal((await searchWorkspace(owner, wid, "Lieferkette")).filter((r) => r.id === doc).length, 0);
  await run("UPDATE documents SET html=? WHERE page_id=?", cleanHtml(html), doc);
  // A pasted copy elsewhere: fresh id, starts with the source's ink until it saves its own.
  const other = await create("Anderes Dokument", "document");
  const fresh = await store.readPageInk(owner, other, "ink-b2", `${doc}/ink-a1`);
  assert.equal(fresh.copied, true);
  assert.equal(fresh.version, 0);
  assert.deepEqual(fresh.doc.pages["ink-b2"].map((i) => i.id), ["s1"]);
  // Only from pages this person may read.
  const secret = await create("Geheim", "document");
  await run("INSERT INTO page_ink(page_id,surface,data,text,recognized,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)", secret, "ink-s", JSON.stringify(on("ink-s", pen(9))), "", "", 1, owner.id, 1);
  await run("UPDATE pages SET parent_id=NULL WHERE id=?", secret);
  assert.equal((await store.readPageInk(viewer, other, "ink-c3", `${secret}/ink-s`)).copied, true, "a viewer of the workspace may read it");
  // A private page in a space the stranger cannot see: nothing copied.
  await assert.rejects(async () => await store.readPageInk(stranger, other, "ink-c5", `${secret}/ink-s`), { status: 403 });
  assert.equal((await store.readPageInk(owner, other, "ink-c4", "not-a-ref")).copied, undefined);
});

test("pasting a drawing block gives it a fresh id and its source", async () => {
  const { documentSchema: schema } = await import("../lib/document-schema");
  const { Slice, Fragment } = await import("@tiptap/pm/model");
  const s = schema();
  const node = s.nodes.drawBlock.create({ id: "ink-old", page: "11111111-1111-1111-1111-111111111111", height: 400, paper: "grid" });
  const out = freshLinkedIds(new Slice(Fragment.from(node), 0, 0)).content.child(0);
  assert.notEqual(out.attrs.id, "ink-old");
  assert.match(out.attrs.id, /^[\w-]{1,40}$/);
  assert.equal(out.attrs.from, "11111111-1111-1111-1111-111111111111/ink-old");
  assert.equal(out.attrs.height, 400);
});

test("PDF ink: recognised text per page, kept with the page's ink, searched", async () => {
  const pid = await create("Akten", "document");
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "Akte.pdf", "application/pdf", 10, owner.id);
  const saved = await saveFileInk(owner, fid, { base: 0, doc: withPage(withPage(emptyInk(), "1", [pen(1)]), "2", [pen(2)]), recognized: { "1": "Erstbescheid" } });
  assert.deepEqual((await readFileInk(viewer, fid)).recognized, { "1": "Erstbescheid" });
  assert.deepEqual(await saveFileRecognized(owner, fid, { version: saved.version, recognized: { "2": "Widerspruchsfrist" } }), { saved: true });
  assert.deepEqual((await readFileInk(owner, fid)).recognized, { "1": "Erstbescheid", "2": "Widerspruchsfrist" });
  assert.deepEqual(await saveFileRecognized(owner, fid, { version: saved.version + 7, recognized: { "2": "alt" } }), { saved: false });
  await processSearchIndex(1000);
  assert.ok((await searchWorkspace(owner, wid, "Widerspruchsfrist")).length > 0);
  // Page 2 erased: its text goes.
  await saveFileInk(owner, fid, { base: saved.version, doc: withPage(emptyInk(), "1", [pen(1)]) });
  assert.deepEqual((await readFileInk(owner, fid)).recognized, { "1": "Erstbescheid" });
});

test("recognition requests carry pen strokes only; answers are checked", () => {
  const items = [pen(1), { ...pen(2), type: "highlighter" as const }, { id: "t", type: "text" as const, color: "#1f1f1f", size: 12, x: 0, y: 0, text: "x" }];
  const request = recognitionRequest("r1", { width: 595.28, height: 841.89 }, items)!;
  assert.deepEqual(Object.keys(request).sort(), ["height", "id", "strokes", "width"]);
  assert.equal(request.strokes.length, 1);
  assert.deepEqual(request.strokes[0].points[0], [1, 1]);
  assert.equal(recognitionRequest("r2", { width: 1, height: 1 }, [items[1]]), null);
  assert.equal(parseRecognition({ text: "no id" }), null);
  const parsed = parseRecognition({ id: "r1", text: "Hallo\u0000", lines: [{ text: "Hallo", box: [10, 20, 80, 16] }, { text: "bad", box: [1, "x", 2, 3] }] })!;
  assert.deepEqual(parsed, { id: "r1", text: "Hallo", lines: [{ text: "Hallo", box: [10, 20, 80, 16] }] });
  const place = convertedTextPlacement(parsed, { x: 9, y: 18, w: 90, h: 20 });
  assert.deepEqual(place, { x: 9, y: 18, size: 12 });
});

// ---- PDF import and export ----

test("PDF import: each page becomes a sheet with that page as background", async () => {
  assert.deepEqual(pdfImportSheets("00000000-0000-4000-8000-000000000001", [{ width: 612, height: 792 }, { width: 841.89, height: 595.28 }]), [
    { file: "00000000-0000-4000-8000-000000000001", page: 1, width: 612, height: 792 },
    { file: "00000000-0000-4000-8000-000000000001", page: 2, width: 841.89, height: 595.28 },
  ]);
  const pid = await create("Skript");
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "Skript.pdf", "application/pdf", 10, owner.id);
  const result = await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }, { width: 792, height: 612 }], replaceEmpty: true });
  // The empty first sheet made way for the PDF.
  assert.equal(result.sheets.length, 3);
  assert.deepEqual(result.sheets.map((s) => (s.background as { page: number }).page), [1, 2, 3]);
  // Appended after the second sheet.
  const more = await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, after: result.sheets[1].id, pages: [{ width: 300, height: 400 }] });
  assert.deepEqual(more.sheets.map((s) => (s.background as { page: number }).page), [1, 2, 1, 3]);
  // Only PDFs of this notebook.
  const image = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", image, pid, "Foto.png", "image/png", 10, owner.id);
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: image, pages: [{ width: 1, height: 1 }] }), { status: 400 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: id(), pages: [{ width: 612, height: 792 }] }), { status: 404 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, pages: [] }));
});

test("inserting a PDF into a notebook: before the first sheet, after any sheet, at the end", async () => {
  // Where the new sheets go (pure).
  assert.deepEqual(placeSheets(["a", "b", "c"], ["x", "y"], "start"), ["x", "y", "a", "b", "c"]);
  assert.deepEqual(placeSheets(["a", "b", "c"], ["x", "y"], "end"), ["a", "b", "c", "x", "y"]);
  assert.deepEqual(placeSheets(["a", "b", "c"], ["x"], { after: "b" }), ["a", "b", "x", "c"]);
  assert.deepEqual(placeSheets(["a", "b", "c"], ["x"], { after: "c" }), ["a", "b", "c", "x"]);
  // The new ids may already be in the list (as stored); an unknown sheet means the end.
  assert.deepEqual(placeSheets(["x", "a", "y", "b"], ["x", "y"], { after: "a" }), ["a", "x", "y", "b"]);
  assert.deepEqual(placeSheets(["a", "b"], ["x"], { after: "gone" }), ["a", "b", "x"]);
  assert.deepEqual(sheetPlace({ at: "start", after: "a" }), "start");
  assert.deepEqual(sheetPlace({ after: "a" }), { after: "a" });
  assert.deepEqual(sheetPlace({ after: null }), "end");
  assert.deepEqual(sheetPlace({}), "end");
  assert.throws(() => sheetPlace({ after: "../x" }));

  const pid = await create("Mitschrift");
  const [first] = (await nb(owner, { action: "notebook.sheet.add", pageId: pid, count: 2 })).sheets;
  // Handwriting on the first sheet: the notebook is not "empty", nothing is replaced.
  await store.savePageInk(owner, pid, first.id, { base: 0, doc: on(first.id, pen(1)) });
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "Folien.pdf", "application/pdf", 10, owner.id);
  const size = { width: 612, height: 792 };
  const page = (s: Sheets["sheets"][number]) => (s.background as { page: number } | null)?.page ?? 0;
  const front = await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, at: "start", pages: [size, size], replaceEmpty: true });
  assert.deepEqual(front.sheets.map(page), [1, 2, 0, 0, 0]);
  assert.deepEqual(front.created, front.sheets.slice(0, 2).map((s) => s.id));
  assert.equal(front.sheets[2].id, first.id, "the written sheet stays");
  const middle = await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, after: first.id, pages: [size] });
  assert.deepEqual(middle.sheets.map(page), [1, 2, 0, 1, 0, 0]);
  const end = await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, pages: [size, size, size] });
  assert.deepEqual(end.sheets.map(page), [1, 2, 0, 1, 0, 0, 1, 2, 3]);
  assert.deepEqual(end.sheets.map((s) => s.position), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // The ink of the written sheet is untouched; the new sheets carry none.
  const data = await notebookData(owner, (await one<Parameters<typeof notebookData>[1]>("SELECT * FROM pages WHERE id=?", pid))!);
  assert.equal(data.sheets.find((s) => s.id === first.id)!.ink.pages[first.id].length, 1);
  assert.equal(data.sheets.filter((s) => s.background && Object.keys(s.ink.pages).length).length, 0);
  // Readers may not insert; an unknown sheet to follow is refused; the sheet limit holds.
  await assert.rejects(async () => await nb(viewer, { action: "notebook.import", pageId: pid, fileId: fid, at: "start", pages: [size] }), { status: 403 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, after: "unknown-sheet", pages: [size] }), { status: 404 });
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, pages: Array.from({ length: 501 }, () => size) }));
  for (let i = 0; i < 2; i++) await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, pages: Array.from({ length: 495 }, () => size) });
  await assert.rejects(async () => await nb(owner, { action: "notebook.import", pageId: pid, fileId: fid, at: "start", pages: [size, size] }), { status: 413 });
  // Blank sheets can go to the front as well.
  const other = await create("Leer vorne");
  const before = await notebookSheets(other);
  const added = await nb(owner, { action: "notebook.sheet.add", pageId: other, at: "start" });
  assert.equal(added.sheets[0].id, added.created![0]);
  assert.equal(added.sheets[1].id, before[0].id);
});

test("PDF export: one page per sheet, paper and PDF backgrounds, ink as vectors", async () => {
  const source = samplePdf(["Erste Seite", "Zweite Seite"]);
  const fileId = "00000000-0000-4000-8000-0000000000aa";
  const sheets = [
    { id: "a", paper: {}, background: null, ink: on("a", pen(1)) },
    { id: "b", paper: { template: "grid" as const, orientation: "landscape" as const, color: "dark" as const }, background: null, ink: on("b", pen(2)) },
    { id: "c", paper: {}, background: { file: fileId, page: 2, width: 612, height: 792 }, ink: on("c", pen(3), { id: "t", type: "text", color: "#e03131", size: 14, x: 40, y: 40, text: "Notiz" }) },
    { id: "d", paper: {}, background: { file: "00000000-0000-4000-8000-0000000000bb", page: 1, width: 300, height: 400 }, ink: emptyInk() },
  ];
  const pages = notebookPdfSheets(paper.DEFAULT_PAPER, sheets);
  assert.equal(pages.length, 4);
  assert.equal(pages[1].dark, true);
  const bytes = await notebookPdf(pages, async (file) => (file === fileId ? source : null), { title: "Heft" });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 4);
  assert.equal(pdf.getTitle(), "Heft");
  const sizes = pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  assert.deepEqual(sizes, [
    [595, 842],
    [842, 595],
    [612, 792],
    // The missing PDF: an empty page of its size.
    [300, 400],
  ]);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true }).promise;
  const text = await (await doc.getPage(3)).getTextContent();
  const words = text.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  assert.ok(words.includes("Zweite Seite"), "the PDF page itself");
  assert.ok(words.includes("Notiz"), "typed text on top");
  // The SVG for published pages and exports.
  const svg = inkSvg(sheets[2].ink.pages.c, { width: 612, height: 792 }, { title: "<Heft>" });
  assert.ok(svg.startsWith("<svg") && svg.includes("&lt;Heft&gt;") && svg.includes(">Notiz</tspan>"));
});

// ---- Copies and archives ----

test("duplicating a notebook copies sheets, paper and ink; archives carry them", async () => {
  const pid = await create("Original");
  const [first] = await notebookSheets(pid);
  await nb(owner, { action: "notebook.sheet.add", pageId: pid, paper: { template: "cornell" } });
  await store.writeSurface(pid, first.id, on(first.id, pen(1), pen(2)), "Handschrift", owner.id);
  const page = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", pid))!;
  const copy = ((await command(owner, { action: "page.duplicate", pageId: pid })) as { id?: string }).id ?? (await duplicatePageTree(owner, page)).id;
  const sheets = await notebookSheets(copy);
  assert.equal(sheets.length, 2);
  assert.notEqual(sheets[0].id, first.id);
  assert.deepEqual(sheets[1].paper, { template: "cornell" });
  const ink = await store.readPageInk(owner, copy, sheets[0].id);
  assert.equal(ink.doc.pages[sheets[0].id].length, 2);
  assert.equal(ink.recognized, "Handschrift");

  const archive = await notebookArchive(pid);
  assert.equal(archive.sheets.length, 2);
  const target = await create("Import");
  await importNotebook(target, JSON.parse(JSON.stringify(archive)), new Map(), owner.id);
  const imported = await notebookSheets(target);
  assert.equal(imported.length, 2);
  assert.equal((await store.readPageInk(owner, target, imported[0].id)).doc.pages[imported[0].id].length, 2);
});

test("a notebook saved as a template gives new notebooks its sheets, paper and handwriting", async () => {
  const pid = await create("Vorlage Heft");
  const [first] = await notebookSheets(pid);
  await nb(owner, { action: "notebook.sheet.add", pageId: pid, paper: { template: "music" } });
  await store.writeSurface(pid, first.id, on(first.id, pen(1)), "", owner.id);
  const template = ((await command(owner, { action: "template.save", pageId: pid, workspaceId: wid, name: "Übungsheft" })) as { id: string }).id;
  const created = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Neu", templateId: template })) as { id: string }).id;
  const sheets = await notebookSheets(created);
  assert.equal((await one<{ kind: string }>("SELECT kind FROM pages WHERE id=?", created))?.kind, "notebook");
  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets[1].paper, { template: "music" });
  assert.equal((await store.readPageInk(owner, created, sheets[0].id)).doc.pages[sheets[0].id].length, 1);
});

test("exports: a notebook as PDF next to a Markdown stub; drawing blocks as pictures", async () => {
  const pid = await create("Laborbuch");
  const [first] = await notebookSheets(pid);
  await nb(owner, { action: "notebook.sheet.add", pageId: pid });
  await store.writeSurface(pid, first.id, on(first.id, pen(1), { id: "t", type: "text", color: "#1f1f1f", size: 12, x: 5, y: 5, text: "Messreihe A" }), "handschriftlich", owner.id);
  const exported = await exportMarkdown(owner, { pageId: pid, format: "zip", includeSubpages: false });
  const zip = await readExportZip(exported.bytes);
  const index = zip.get("index.md")!.toString();
  assert.match(index, /Notizbuch mit 2 Blättern|Notebook with 2 sheets/);
  assert.match(index, /Messreihe A/);
  const pdfPath = [...zip.keys()].find((k) => k.endsWith(".pdf"))!;
  assert.ok(pdfPath.startsWith("assets/") && index.includes(pdfPath));
  assert.equal((await PDFDocument.load(zip.get(pdfPath)!)).getPageCount(), 2);
  // The print view (PDF export) shows each sheet as a picture.
  const printedNotebook = (await exportPrintHtml(owner, { pageId: pid })).html;
  assert.equal(printedNotebook.match(/data:image\/svg\+xml;base64/g)?.length, 2);
  assert.match(printedNotebook, /Blatt 2|Sheet 2/);
  // One Markdown file alone: a link back to Flowplan.
  const single = (await exportMarkdown(owner, { pageId: pid, format: "markdown", includeSubpages: false })).bytes.toString();
  assert.match(single, /#page=/);

  // A document with a drawing block: the print view and published pages show its picture.
  const doc = await create("Mit Skizze", "document");
  const html = `<p>Vorher</p><div data-ink-block="ink-x1" data-ink-height="240" data-ink-paper="grid" data-ink-page="${doc}"></div>`;
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", cleanHtml(html), htmlState(html), doc);
  await store.writeSurface(doc, "ink-x1", on("ink-x1", pen(2)), "Skizzentext", owner.id);
  const print = (await exportPrintHtml(owner, { pageId: doc })) as unknown as { html?: string } | string;
  const printed = typeof print === "string" ? print : JSON.stringify(print);
  assert.match(printed, /data:image\/svg\+xml;base64/);
  assert.match(printed, /Skizzentext/);
  const published = await withInkPictures(cleanHtml(html), { id: doc, kind: "document", title: "Mit Skizze" });
  assert.match(published, /<svg class="ink-block-picture"/);
  assert.match(published, /ink-block-static/);
  const md = await exportMarkdown(owner, { pageId: doc, format: "zip", includeSubpages: false });
  const mdZip = await readExportZip(md.bytes);
  assert.ok([...mdZip.keys()].some((k) => k.endsWith("ink-x1.svg")));
  assert.match(mdZip.get("index.md")!.toString(), /Skizzentext/);
});
