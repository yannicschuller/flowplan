// GoodNotes import (lib/importers/goodnotes.ts): PDF exports become notebooks
// whose sheets have the PDF pages as background (size, orientation, order,
// title), several at once through a ZIP (folders as parent pages, also as
// sent by the import page's multi-select, lib/stored-zip.ts), the PDF's text
// in search; GoodNotes' own format and unreadable PDFs are refused or
// skipped with what to do; rights, quota and the page limit hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees } from "pdf-lib";
import type { Identity } from "../lib/types";
import { samplePdf } from "./helpers/pdf";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-goodnotes-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip, readZip } = await import("../lib/archive");
const { importFromSource, detectSource, zipEntries } = await import("../lib/importers");
const { GOODNOTES_REFUSAL, NO_PDF, PDF_EXPECTED, pdfSheetSizes } = await import("../lib/importers/goodnotes");
const { notebookSheets } = await import("../lib/notebook");
const { storedZip } = await import("../lib/stored-zip");
const { englishMessage } = await import("../lib/i18n-errors");
const { extractPendingFileTexts } = await import("../lib/file-text");
const { processSearchIndex, searchWorkspace } = await import("../lib/search-index");

const account = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const owner = await account("gn-owner");
const viewer = await account("gn-viewer");
const wid = await createWorkspace(owner.id, "GoodNotes");
const space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");

// A PDF with pages of the given sizes (points), optionally rotated.
async function pdf(pages: { size: [number, number]; rotate?: number }[], padding = 0) {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const p = doc.addPage(page.size);
    if (page.rotate) p.setRotation(degrees(page.rotate));
  }
  // Bytes a stream of the PDF carries (a large export).
  if (padding) doc.context.register(doc.context.stream(new Uint8Array(padding)));
  return Buffer.from(await doc.save());
}
const A4: [number, number] = [595.28, 841.89];
const pagesNamed = async (title: string) =>
  await all<{ id: string; kind: string; parent_id: string | null; position: number }>(
    "SELECT id,kind,parent_id,position FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL",
    wid,
    title,
  );
// A synthetic .goodnotes: a ZIP of GoodNotes' own protobuf records.
const goodnotesFile = () =>
  writeZip(
    new Map([
      ["index.notes.pb", Buffer.from([0x0a, 0x24, ...Buffer.from(id())])],
      [`notes/${id()}`, Buffer.from([0x08, 0x01])],
      [`attachments/${id()}`, samplePdf(["Vorlage"])],
      [`thumbnails/${id()}.jpg`, Buffer.from([0xff, 0xd8, 0xff])],
    ]),
  );

test("a GoodNotes PDF becomes a notebook: one sheet per page with the page as background, its size and orientation", async () => {
  const bytes = await pdf([{ size: A4 }, { size: [A4[1], A4[0]] }, { size: A4, rotate: 90 }]);
  assert.equal(detectSource("Biologie.pdf", bytes), "goodnotes");
  const preview = await importFromSource(owner, wid, space, { name: "Biologie.pdf", bytes }, { dryRun: true });
  assert.equal(preview.source, "goodnotes");
  assert.equal(preview.title, "Biologie");
  assert.equal(preview.notebooks, 1);
  assert.equal(preview.sheets, 3);
  assert.equal(preview.files, 1);
  assert.equal(preview.bytes, bytes.length);
  assert.deepEqual(preview.warnings, []);

  const result = await importFromSource(owner, wid, space, { name: "Biologie.pdf", bytes });
  const [notebook] = await pagesNamed("Biologie");
  assert.equal(notebook.kind, "notebook");
  assert.deepEqual(result.rootIds, [notebook.id]);
  const file = (await one<{ id: string; mime: string; size: number; name: string }>("SELECT id,mime,size,name FROM files WHERE page_id=?", notebook.id))!;
  assert.equal(file.mime, "application/pdf");
  assert.equal(file.name, "Biologie.pdf");
  assert.equal(file.size, bytes.length);
  const sheets = await notebookSheets(notebook.id);
  // The default first sheet of a new notebook is replaced.
  assert.equal(sheets.length, 3);
  assert.deepEqual(
    sheets.map((s) => s.background),
    [
      { file: file.id, page: 1, width: 595.28, height: 841.89 },
      { file: file.id, page: 2, width: 841.89, height: 595.28 },
      // Rotated by 90°: shown in landscape.
      { file: file.id, page: 3, width: 841.89, height: 595.28 },
    ],
  );
  assert.deepEqual(sheets.map((s) => s.position), [0, 1, 2]);
});

test("the PDF's text (typed text, recognised handwriting) is found by search", async () => {
  const bytes = samplePdf(["Photosynthese Mitschrift", "Zellatmung Klausur"]);
  await importFromSource(owner, wid, space, { name: "Vorlesung Bio.pdf", bytes });
  const [notebook] = await pagesNamed("Vorlesung Bio");
  assert.equal((await notebookSheets(notebook.id)).length, 2);
  while (await extractPendingFileTexts()) {}
  await processSearchIndex(1000);
  assert.ok((await searchWorkspace(owner, wid, "Zellatmung")).some((r) => r.id === notebook.id));
});

test("a ZIP of PDFs: one notebook each, folders as parent pages, natural order, other files skipped", async () => {
  const bytes = await writeZip(
    new Map([
      ["Backup/Schule/Mathe 10.pdf", await pdf([{ size: A4 }])],
      ["Backup/Schule/Mathe 2.pdf", await pdf([{ size: A4 }, { size: A4 }])],
      ["Backup/Privat.pdf", await pdf([{ size: [400, 600] }])],
      ["Backup/Liesmich.txt", Buffer.from("hallo")],
      ["Backup/._Privat.pdf", Buffer.from("AppleDouble")],
    ]),
  );
  assert.equal(detectSource("Backup.zip", bytes, await zipEntries(bytes)), "goodnotes");
  const preview = await importFromSource(owner, wid, space, { name: "Backup.zip", bytes }, { dryRun: true });
  assert.equal(preview.notebooks, 3);
  assert.equal(preview.sheets, 4);
  assert.equal(preview.folders, 1);
  assert.equal(preview.files, 3);
  assert.deepEqual(preview.warnings.map(englishMessage), ["Files that are not PDFs are skipped."]);
  await importFromSource(owner, wid, space, { name: "Backup.zip", bytes });
  const [folder] = await pagesNamed("Schule");
  assert.equal(folder.kind, "document");
  const [two] = await pagesNamed("Mathe 2");
  const [ten] = await pagesNamed("Mathe 10");
  assert.equal(two.parent_id, folder.id);
  assert.equal(ten.parent_id, folder.id);
  assert.ok(two.position < ten.position, "Mathe 2 comes before Mathe 10");
  assert.equal((await pagesNamed("Privat"))[0].parent_id, null);
  assert.equal((await notebookSheets(two.id)).length, 2);
});

test("several PDFs chosen at once arrive as one stored ZIP; large PDFs inside a ZIP are allowed", async () => {
  const big = await pdf([{ size: A4 }], 11 * 1024 * 1024);
  const zip = Buffer.from(
    storedZip([
      { name: "Heft.pdf", data: await pdf([{ size: A4 }]) },
      { name: "Heft.pdf", data: big },
    ]),
  );
  const entries = await readZip(zip, { foreign: true, largeEntries: /\.pdf$/i });
  assert.deepEqual([...entries.keys()], ["Heft.pdf", "Heft (2).pdf"]);
  assert.equal(entries.get("Heft (2).pdf")!.length, big.length);
  // Without the option an entry above 10 MB is refused, as before.
  await assert.rejects(readZip(zip, { foreign: true }), { status: 413 });
  const preview = await importFromSource(owner, wid, space, { name: "Notizbücher.zip", bytes: zip }, { dryRun: true });
  assert.equal(preview.notebooks, 2);
  assert.deepEqual(preview.warnings, []);
});

test("GoodNotes' own format is refused with how to export as PDF; inside a ZIP it is skipped", async () => {
  const gn = await goodnotesFile();
  for (const name of ["Chemie.goodnotes", "Chemie"])
    await assert.rejects(importFromSource(owner, wid, space, { name, bytes: gn }, { dryRun: true }), (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, GOODNOTES_REFUSAL);
      return true;
    });
  // Also when it is too large to be read at all, and when the source was chosen.
  await assert.rejects(importFromSource(owner, wid, space, { name: "Chemie.goodnotes", bytes: Buffer.from("PK\u0003\u0004") }, { source: "goodnotes", dryRun: true }), { message: GOODNOTES_REFUSAL });
  assert.match(englishMessage(GOODNOTES_REFUSAL), /export the notebook as PDF/);
  // A backup with nothing but GoodNotes files: the same answer.
  await assert.rejects(importFromSource(owner, wid, space, { name: "Backup.zip", bytes: await writeZip(new Map([["Chemie.goodnotes", gn]])) }, { dryRun: true }), { message: GOODNOTES_REFUSAL });
  // Next to PDFs: skipped and named.
  const mixed = await writeZip(new Map([["Chemie.goodnotes", gn], ["Physik.pdf", await pdf([{ size: A4 }])]]));
  const preview = await importFromSource(owner, wid, space, { name: "Backup.zip", bytes: mixed }, { dryRun: true });
  assert.equal(preview.notebooks, 1);
  assert.deepEqual(preview.warnings.map(englishMessage), ["Chemie.goodnotes: GoodNotes file skipped – please export it from GoodNotes as PDF."]);
});

test("unreadable PDFs and other files are refused or skipped; nothing is written for them", async () => {
  const before = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages"))!.n);
  const broken = Buffer.from("%PDF-1.7\nkaputt\n");
  assert.equal(await pdfSheetSizes(broken), null);
  const preview = await importFromSource(owner, wid, space, { name: "Kaputt.pdf", bytes: broken }, { dryRun: true });
  assert.equal(preview.notebooks, undefined);
  assert.deepEqual(preview.warnings.map(englishMessage), ["Kaputt.pdf: the PDF cannot be read (damaged or password-protected) and is skipped."]);
  await assert.rejects(importFromSource(owner, wid, space, { name: "Kaputt.pdf", bytes: broken }), { status: 400 });
  // Not a PDF for the GoodNotes source; a ZIP without PDFs.
  await assert.rejects(importFromSource(owner, wid, space, { name: "bild.png", bytes: Buffer.from("\x89PNG\r\n") }, { source: "goodnotes", dryRun: true }), { message: PDF_EXPECTED });
  await assert.rejects(
    importFromSource(owner, wid, space, { name: "leer.zip", bytes: await writeZip(new Map([["a.png", Buffer.from("x")]])) }, { source: "goodnotes", dryRun: true }),
    { message: NO_PDF },
  );
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages"))!.n), before);
});

test("limits: at most 500 pages per PDF, the import's page limit, quota, rights, database mode", async () => {
  const long = await pdf(Array.from({ length: 503 }, () => ({ size: A4 })));
  const preview = await importFromSource(owner, wid, space, { name: "Dick.pdf", bytes: long }, { dryRun: true });
  assert.equal(preview.sheets, 500);
  assert.deepEqual(preview.warnings.map(englishMessage), ["Dick.pdf: only the first 500 of 503 pages are imported."]);

  const zip = await writeZip(new Map([["a.pdf", await pdf([{ size: A4 }])], ["b.pdf", await pdf([{ size: A4 }])], ["c.pdf", await pdf([{ size: A4 }])]]));
  process.env.FLOWPLAN_IMPORT_MAX_DOCS = "2";
  try {
    assert.equal((await importFromSource(owner, wid, space, { name: "drei.zip", bytes: zip }, { dryRun: true })).tooMany, true);
    await assert.rejects(importFromSource(owner, wid, space, { name: "drei.zip", bytes: zip }), { status: 413 });
  } finally {
    delete process.env.FLOWPLAN_IMPORT_MAX_DOCS;
  }

  const bytes = await pdf([{ size: A4 }], 2 * 1024 * 1024);
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", 1, wid);
  try {
    const limited = await importFromSource(owner, wid, space, { name: "Voll.pdf", bytes }, { dryRun: true });
    assert.ok(limited.warnings.some((w) => /Speicherkontingent/.test(w)));
    await assert.rejects(importFromSource(owner, wid, space, { name: "Voll.pdf", bytes }), { status: 413 });
  } finally {
    await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  }
  assert.equal((await pagesNamed("Voll")).length, 0);

  // Readers of the workspace may not import into it.
  await assert.rejects(importFromSource(viewer, wid, space, { name: "Biologie.pdf", bytes }, { dryRun: true }), { status: 403 });

  // Notebooks only come as pages.
  const asDatabase = await importFromSource(owner, wid, space, { name: "Tabelle.pdf", bytes: await pdf([{ size: A4 }]) }, { dryRun: true, mode: "database" });
  assert.ok(asDatabase.warnings.map(englishMessage).includes("Notebooks are only imported when importing as pages."));
  assert.equal(asDatabase.files, 0);
});
