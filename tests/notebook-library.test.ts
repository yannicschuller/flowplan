// Server side of pictures, stickers and own paper templates in notebooks
// (lib/notebook-library.ts, lib/page-ink-store.ts, lib/notebook.ts):
// pictures only of the page's own files, kept for clients that do not know
// them, stickers per person, templates per workspace with their rights,
// quota and PDF pages, copies onto the page that outlive the template,
// file usage, page copies and exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import type { Identity, Page } from "../lib/types";
import { samplePdf } from "./helpers/pdf";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notebook-library-"));
const { run, id, one, all, transaction } = await import("../lib/db");
const { notebookSheets } = await import("../lib/notebook");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { storeUpload } = await import("../lib/page-upload");
const store = await import("../lib/page-ink-store");
const library = await import("../lib/notebook-library");
const { usedFileIds } = await import("../lib/file-usage");
const { workspaceBytes } = await import("../lib/instance-ops");
const { duplicatePageTree } = await import("../lib/page-tree");
const { inkPicture } = await import("../lib/ink-export");
const { emptyInk, withPage } = await import("../lib/ink/model");
type InkImage = import("../lib/ink/model").InkImage;

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("lib-owner"),
  editor = await account("lib-editor"),
  viewer = await account("lib-viewer"),
  stranger = await account("lib-stranger");
const wid = await createWorkspace(owner.id, "Bibliothek");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, kind = "notebook") =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title, kind })) as { id: string }).id;
const pageOf = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
const sheetsOf = async (pid: string) => ((await command(owner, { action: "notebook.sheet.add", pageId: pid, count: 1 })) as { sheets: { id: string }[] }).sheets;

function png(w: number, h: number, shade = 0x80, stored = false) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, shade)])));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, stored ? { level: 0 } : {})), chunk("IEND", Buffer.alloc(0))]);
}
async function attach(user: Identity, pid: string, content: Buffer, name = "bild.png", mime = "image/png") {
  const fid = id();
  await transaction(async () => await storeUpload(user, await pageOf(pid), { id: fid, name, mime, content }), user);
  return fid;
}
const image = (file: string, extra: Partial<InkImage> = {}): InkImage => ({ id: `i${file.slice(0, 4)}`, type: "image", file, x: 10, y: 10, w: 100, h: 50, ...extra });
const save = async (user: Identity, pid: string, surface: string, items: unknown[], base: number, knows: string[] | null = ["image"]) =>
  await store.savePageInk(user, pid, surface, { base, doc: withPage(emptyInk(), surface, items as never), ...(knows ? { knows } : {}) });
const itemsOf = async (pid: string, surface: string) => (await store.pageInkDocs(pid)).get(surface)?.doc.pages[surface] || [];

const nb = await create("Heft mit Bildern");
const other = await create("Anderes Heft");
const [sheet] = await sheetsOf(nb);
const photo = await attach(owner, nb, png(40, 20));
const foreign = await attach(owner, other, png(8, 8, 0x20));

test("sheets show pictures of the page's own files only", async () => {
  const saved = await save(editor, nb, sheet.id, [image(photo), image(foreign, { id: "foreign" }), { id: "st", type: "image", sticker: "star", x: 0, y: 0, w: 64, h: 64 }], 0);
  const kept = await itemsOf(nb, sheet.id);
  assert.deepEqual(kept.map((i) => i.id), [image(photo).id, "st"]);
  // The answer carries the corrected ink.
  assert.deepEqual(saved.doc?.pages[sheet.id].map((i) => i.id), [image(photo).id, "st"]);
});

test("a client that does not know pictures keeps them when it saves; one that knows can delete them", async () => {
  const before = (await store.pageInkDocs(nb)).get(sheet.id)!.version;
  const pen = { id: "pen1", type: "pen", color: "#1f1f1f", width: 1, points: [0, 0, 0.5, 5, 5, 0.5] };
  // Older version: only the pen (it dropped the pictures it could not read).
  await save(editor, nb, sheet.id, [pen], before, null);
  assert.deepEqual((await itemsOf(nb, sheet.id)).map((i) => i.id), [image(photo).id, "st", "pen1"]);
  const now = (await store.pageInkDocs(nb)).get(sheet.id)!.version;
  await save(editor, nb, sheet.id, [pen], now);
  assert.deepEqual((await itemsOf(nb, sheet.id)).map((i) => i.id), ["pen1"]);
  assert.deepEqual(store.keepUnknownItems([pen as never], [image(photo), pen as never], ["image"]).length, 1);
  // Back to the picture for the tests below.
  await save(editor, nb, sheet.id, [image(photo), pen], now + 1);
});

test("pictures of the page for the picker: readers yes, strangers no; files in use stay used", async () => {
  const pictures = await library.notebookPictures(viewer, nb);
  assert.deepEqual(pictures.map((p) => p.id), [photo]);
  assert.equal(pictures[0].url, `/api/files/${photo}`);
  await assert.rejects(library.notebookPictures(stranger, nb), /403|Berechtigung|nicht gefunden/i);
  // The picture on the sheet counts as use ("Delete unused files").
  assert.ok((await usedFileIds(wid, [photo, foreign])).has(photo));
});

test("stickers are a person's own: from a picture or ink, inserted as a copy on the page", async () => {
  const fromPicture = (await command(editor, { action: "notebook.sticker.save", pageId: nb, fileId: photo, name: "Foto" })) as { id: string; kind: string; width: number };
  assert.equal(fromPicture.kind, "image");
  assert.equal(fromPicture.width, 40);
  // A file of another page cannot be taken.
  await assert.rejects(command(editor, { action: "notebook.sticker.save", pageId: nb, fileId: foreign }), /Datei fehlt/);
  const fromInk = (await command(editor, {
    action: "notebook.sticker.save",
    pageId: nb,
    name: "Unterschrift",
    items: [{ id: "a", type: "pen", color: "#1f1f1f", width: 2, points: [100, 200, 0.5, 150, 220, 0.5] }, image(photo)],
  })) as { kind: string; items: { type: string; points?: number[] }[] };
  assert.equal(fromInk.kind, "ink");
  // Moved to the top left, the picture of a file left out.
  assert.deepEqual(fromInk.items.map((i) => i.type), ["pen"]);
  assert.ok(Math.min(...fromInk.items[0].points!.filter((_, i) => i % 3 === 0)) < 2);
  const mine = (await command(editor, { action: "notebook.stickers", pageId: nb })) as { stickers: { id: string }[] };
  assert.equal(mine.stickers.length, 2);
  assert.equal(((await command(owner, { action: "notebook.stickers", pageId: nb })) as { stickers: unknown[] }).stickers.length, 0);
  // Others can neither see, rename, delete nor insert it.
  await assert.rejects(command(owner, { action: "notebook.sticker.delete", stickerId: fromPicture.id }), /Sticker nicht gefunden/);
  await assert.rejects(library.libraryFile(owner, fromPicture.id), /Nicht gefunden/);
  assert.equal((await library.libraryFile(editor, fromPicture.id)).mime, "image/png");
  // Inserting: a copy attached to the target page, reused for the same sticker.
  const first = (await command(editor, { action: "notebook.sticker.insert", pageId: other, stickerId: fromPicture.id })) as { kind: string; fileId: string };
  const again = (await command(editor, { action: "notebook.sticker.insert", pageId: other, stickerId: fromPicture.id })) as { fileId: string };
  assert.equal(first.kind, "image");
  assert.equal(again.fileId, first.fileId);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", first.fileId))?.page_id, other);
  // Viewers cannot put stickers on a page.
  await assert.rejects(command(viewer, { action: "notebook.sticker.insert", pageId: other, stickerId: fromPicture.id }));
  await command(editor, { action: "notebook.sticker.rename", stickerId: fromPicture.id, name: "Urlaub" });
  await command(editor, { action: "notebook.sticker.delete", stickerId: fromPicture.id });
  // The page keeps its copy.
  assert.ok(await one("SELECT 1 FROM files WHERE id=?", first.fileId));
});

const newTemplate = async (user: Identity, file: { name: string; type: string; bytes: Buffer }, extra: Record<string, unknown> = {}) =>
  await transaction(async () => await library.createTemplate(user, { pageId: nb, name: extra.name ?? "", fit: extra.fit, pdfPage: extra.pdfPage, file }), user);

test("paper templates: members add a picture or a PDF page; only the one who added it or an owner changes it", async () => {
  const before = await workspaceBytes(wid);
  const planner = await newTemplate(editor, { name: "planer.pdf", type: "application/pdf", bytes: Buffer.from(samplePdf(["eins", "zwei", "drei"])) }, { pdfPage: 2, name: "Wochenplan" });
  assert.equal(planner.kind, "pdf");
  assert.deepEqual([planner.width, planner.height], [612, 792]);
  const stored = await one<{ data: Uint8Array }>("SELECT data FROM notebook_templates WHERE id=?", planner.id);
  const pdf = await PDFDocument.load(stored!.data);
  assert.equal(pdf.getPageCount(), 1);
  // Counted in the workspace's storage.
  assert.ok((await workspaceBytes(wid)) > before);
  const dots = await newTemplate(owner, { name: "punkte.png", type: "image/png", bytes: png(20, 20) }, { fit: "tile" });
  assert.deepEqual([dots.kind, dots.fit, dots.width, dots.name], ["image", "tile", 15, "punkte"]);
  await assert.rejects(newTemplate(viewer, { name: "x.png", type: "image/png", bytes: png(2, 2) }), /Berechtigung/);
  await assert.rejects(newTemplate(editor, { name: "x.png", type: "image/png", bytes: Buffer.from("<svg/>") }), /Bild \(PNG, JPEG, WebP\) oder ein PDF/);
  await assert.rejects(newTemplate(editor, { name: "x.pdf", type: "application/pdf", bytes: Buffer.from(samplePdf(["a"])) }, { pdfPage: 3 }), /Seite hat das PDF nicht/);
  // Everyone in the workspace sees them, with who may change them.
  const seen = (await command(viewer, { action: "notebook.templates", pageId: nb })) as { templates: { id: string; canEdit: boolean }[] };
  assert.deepEqual(seen.templates.map((t) => t.canEdit), [false, false]);
  const byOwner = (await library.listTemplates(owner, nb)).map((t) => t.canEdit);
  assert.deepEqual(byOwner, [true, true]);
  await assert.rejects(command(editor, { action: "notebook.template.update", templateId: dots.id, name: "Meins" }), /Nur wer die Vorlage angelegt hat/);
  await command(owner, { action: "notebook.template.update", templateId: planner.id, name: "Woche" });
  assert.equal((await library.libraryFile(viewer, planner.id)).mime, "application/pdf");
  await assert.rejects(library.libraryFile(stranger, planner.id), /Berechtigung/);
});

test("the quota holds for templates", async () => {
  // Whole megabytes: quota_mb is an integer column on PostgreSQL. The
  // picture is stored uncompressed, larger than the 1 MB allowed.
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", 1, wid);
  try {
    await assert.rejects(newTemplate(owner, { name: "gross.png", type: "image/png", bytes: png(800, 800, 0x80, true) }), /Speicherkontingent/);
  } finally {
    await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  }
});

test("a template on sheets is a copy on the page: reused, kept after the template is deleted, copied with the page", async () => {
  const [dots] = (await library.listTemplates(owner, nb)).filter((t) => t.kind === "image");
  const answer = (await command(editor, { action: "notebook.paper", pageId: nb, paper: { image: { template: dots.id } } })) as { paper: { image?: { file: string; fit: string; template: string } } };
  const copy = answer.paper.image!;
  assert.equal(copy.template, dots.id);
  assert.equal(copy.fit, "tile");
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", copy.file))?.page_id, nb);
  // A sheet of its own with the same template: the same copy.
  const sheetAnswer = (await command(editor, { action: "notebook.sheet.paper", pageId: nb, sheetIds: [sheet.id], paper: { image: { template: dots.id, fit: "stretch" } } })) as {
    sheets: { id: string; paper: { image?: { file: string; fit: string } } }[];
  };
  const own = sheetAnswer.sheets.find((s) => s.id === sheet.id)!.paper.image!;
  assert.equal(own.file, copy.file);
  assert.equal(own.fit, "stretch");
  // A file of another page cannot be named.
  await assert.rejects(command(editor, { action: "notebook.paper", pageId: nb, paper: { image: { file: foreign, width: 10, height: 10, fit: "stretch" } } }), /Datei fehlt/);
  assert.ok((await usedFileIds(wid, [copy.file])).has(copy.file));
  await command(owner, { action: "notebook.template.delete", templateId: dots.id });
  const paper = (await command(owner, { action: "notebook.sheet.add", pageId: nb })) as { paper: { image?: { file: string } } };
  assert.equal(paper.paper.image?.file, copy.file);
  // "No own paper" on a sheet, and back to lines for the notebook.
  await command(editor, { action: "notebook.paper", pageId: nb, paper: { template: "grid", image: null } });
  // Copying the page: pictures and paper point to the copied files.
  await command(editor, { action: "notebook.paper", pageId: nb, paper: { image: { file: copy.file, width: 15, height: 15, fit: "tile" } } });
  const duplicate = await transaction(async () => await duplicatePageTree(owner, await pageOf(nb)), owner);
  const copiedPaper = JSON.parse((await one<{ paper: string }>("SELECT paper FROM notebooks WHERE page_id=?", duplicate.id))!.paper);
  const copiedFiles = new Set((await all<{ id: string }>("SELECT id FROM files WHERE page_id=?", duplicate.id)).map((f) => f.id));
  assert.ok(copiedFiles.has(copiedPaper.image.file));
  const copiedSheets = await notebookSheets(duplicate.id);
  const inks = await store.pageInkDocs(duplicate.id);
  const pictures = copiedSheets.flatMap((s) => inks.get(s.id)?.doc.pages[s.id] || []).filter((i): i is InkImage => i.type === "image" && !!i.file);
  assert.ok(pictures.length >= 1);
  for (const p of pictures) assert.ok(copiedFiles.has(p.file!), "picture points to a copied file");
});

test("exports put the pictures into the sheet's SVG", async () => {
  const picture = await inkPicture(await pageOf(nb), { id: sheet.id });
  assert.ok(picture?.svg?.includes("data:image/png;base64,"));
});
