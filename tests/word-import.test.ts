// Microsoft Word import (#122): single .docx, ZIPs of them as a page tree,
// and the refusal of older Word files (.doc) and OneNote with what to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-word-import-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource, parseImport, detectSource, zipEntries } = await import("../lib/importers");
const { legacyOffice, DOC_REFUSAL, ONENOTE_REFUSAL } = await import("../lib/importers/word");
const { englishMessage } = await import("../lib/i18n-errors");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "word", "word@example.test");
const owner = { id: uid, name: "word", email: "word@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Word");
const space = (await bootstrap(owner, wid)).spaces[0].id;

const fixture = join(import.meta.dirname, "fixtures", "import", "docx");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const docx = () => writeZip(new Map(walk(fixture).map((f) => [relative(fixture, f), readFileSync(f)] as [string, Buffer])));
const pageByTitle = async (title: string) =>
  await one<{ id: string; parent_id: string | null }>("SELECT id,parent_id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1", wid, title);
const pageHtml = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

// Minimal files with the first bytes of each format.
const OLE2 = Buffer.from("d0cf11e0a1b11ae1000000000000000000000000000000003e000300feff0900", "hex");
const ONE = Buffer.concat([Buffer.from("e4525c7b8cd8a74daeb15378d02996d3", "hex"), Buffer.alloc(64)]);
const ONETOC2 = Buffer.concat([Buffer.from("a12fff43d9ef764c9ee210ea5722765f", "hex"), Buffer.alloc(64)]);
const CAB = Buffer.concat([Buffer.from("MSCF\0\0\0\0", "latin1"), Buffer.alloc(64)]);

test("a single .docx through the Microsoft Word source becomes one page", async () => {
  const bytes = await docx();
  assert.equal(detectSource("Quartalsbericht.docx", bytes, await zipEntries(bytes)), "word");
  const preview = await importFromSource(owner, wid, space, { name: "Quartalsbericht.docx", bytes }, { source: "word", dryRun: true });
  assert.equal(preview.source, "word");
  assert.equal(preview.pages, 1);
  assert.equal(preview.files, 1);
  assert.deepEqual(preview.warnings, []);
  const result = await importFromSource(owner, wid, space, { name: "Quartalsbericht.docx", bytes }, { source: "word" });
  assert.equal(result.rootIds.length, 1);
  const page = (await pageByTitle("Quartalsbericht"))!;
  const html = (await pageHtml(page.id)).replace(/ data-block-id="[^"]*"/g, "");
  assert.match(html, /<h1>Bericht<\/h1>/);
  assert.match(html, /<strong>Fett<\/strong>/);
  assert.match(html, /<ol><li><p>Erstens<\/p>/);
  assert.match(html, /<td colspan="2"/);
  assert.match(html, /<img src="\/api\/files\//);
  // A Word file without its extension (recognised from word/document.xml).
  const unnamed = await importFromSource(owner, wid, space, { name: "Ohne Endung", bytes }, { source: "word", dryRun: true });
  assert.equal(unnamed.pages, 1);
  // The Google Docs source still takes a .docx.
  assert.equal((await importFromSource(owner, wid, space, { name: "Bericht.docx", bytes }, { source: "gdocs", dryRun: true })).pages, 1);
});

test("a ZIP with folders and two .docx becomes a page tree", async () => {
  const one_ = await docx();
  const zip = await writeZip(
    new Map([
      ["Abteilung/Protokolle/Sitzung Mai.docx", one_],
      ["Abteilung/Leitfaden.docx", one_],
      ["Abteilung/~$itfaden.docx", Buffer.from("lock")],
    ]),
  );
  assert.equal(detectSource("Word.zip", zip, await zipEntries(zip)), "word");
  const preview = await importFromSource(owner, wid, space, { name: "Word.zip", bytes: zip }, { dryRun: true });
  assert.equal(preview.source, "word");
  assert.equal(preview.pages, 2);
  // The single top folder of the ZIP is dropped; Protokolle stays.
  assert.equal(preview.folders, 1);
  await importFromSource(owner, wid, space, { name: "Word.zip", bytes: zip }, { source: "word" });
  const folder = (await pageByTitle("Protokolle"))!;
  assert.equal((await pageByTitle("Sitzung Mai"))!.parent_id, folder.id);
  assert.equal((await pageByTitle("Leitfaden"))!.parent_id, folder.parent_id, "Leitfaden sits beside the folder");
  assert.equal(await pageByTitle("~$itfaden"), undefined, "Word's lock file is left out");
  assert.match(await pageHtml((await pageByTitle("Leitfaden"))!.id), /Fett/);
});

test(".doc, .one, .onetoc2 and .onepkg are refused with what to do instead", async () => {
  assert.equal(legacyOffice("Alt.doc", OLE2), "doc");
  assert.equal(legacyOffice("ohne-endung", OLE2), "doc");
  assert.equal(legacyOffice("Tabelle.xls", OLE2), null, "other OLE2 files are not Word");
  assert.equal(legacyOffice("Notizen.one", ONE), "onenote");
  assert.equal(legacyOffice("upload.bin", ONE), "onenote");
  assert.equal(legacyOffice("upload.bin", ONETOC2), "onenote");
  assert.equal(legacyOffice("Notizbuch.onepkg", CAB), "onenote");
  assert.equal(legacyOffice("Notizbuch", CAB), "onenote");
  assert.equal(legacyOffice("Umbenannt.doc", await docx()), null, "a .docx called .doc is read");
  for (const source of ["auto", "word", "gdocs"] as const) {
    await assert.rejects(parseImport("Alt.doc", OLE2, source), (e: Error & { status?: number }) => e.message === DOC_REFUSAL && e.status === 400);
    await assert.rejects(parseImport("Abschnitt.one", ONE, source), (e: Error) => e.message === ONENOTE_REFUSAL);
    await assert.rejects(parseImport("Inhalt.onetoc2", ONETOC2, source), (e: Error) => e.message === ONENOTE_REFUSAL);
    await assert.rejects(parseImport("Notizbuch.onepkg", CAB, source), (e: Error) => e.message === ONENOTE_REFUSAL);
  }
  // Without a telling name, from the first bytes.
  await assert.rejects(parseImport("upload", OLE2), (e: Error) => e.message === DOC_REFUSAL);
  await assert.rejects(parseImport("upload", ONE), (e: Error) => e.message === ONENOTE_REFUSAL);
  // A ZIP of nothing but such files.
  const zip = await writeZip(new Map([["Alt.doc", OLE2]]));
  await assert.rejects(parseImport("Alt.zip", zip), (e: Error) => e.message === DOC_REFUSAL);
  await assert.rejects(parseImport("Notizen.zip", await writeZip(new Map([["Notizen.one", ONE]])), "word"), (e: Error) => e.message === ONENOTE_REFUSAL);
  // In English.
  assert.match(englishMessage(DOC_REFUSAL), /^Flowplan cannot read older Word files \(\.doc\)\. Open the file in Word, LibreOffice or Pages and save it as \.docx\.$/);
  assert.match(englishMessage(ONENOTE_REFUSAL), /^Flowplan cannot read OneNote files .*File → Export.*“Microsoft Word”/);
  // Other Word input is not a ZIP: a short hint instead of a broken page.
  await assert.rejects(parseImport("text.txt", Buffer.from("Hallo"), "word"), /Word-Datei \(\.docx\) oder ein ZIP/);
});

test("a ZIP mixing .docx with .doc and OneNote imports the .docx and lists the rest", async () => {
  const zip = await writeZip(
    new Map([
      ["Gemischt/Neu.docx", await docx()],
      ["Gemischt/Alt.doc", OLE2],
      ["Gemischt/Abschnitt.one", ONE],
    ]),
  );
  assert.equal(detectSource("Gemischt.zip", zip, await zipEntries(zip)), "word");
  const preview = await importFromSource(owner, wid, space, { name: "Gemischt.zip", bytes: zip }, { dryRun: true });
  assert.equal(preview.pages, 1);
  assert.deepEqual(preview.warnings.sort(), [
    "Abschnitt.one: OneNote-Datei übersprungen – bitte in OneNote als Word-Dokument (.docx) exportieren.",
    "Alt.doc: ältere Word-Datei (.doc) übersprungen – bitte in Word, LibreOffice oder Pages als .docx speichern.",
  ]);
  assert.equal(englishMessage(preview.warnings[1]), "Alt.doc: older Word file (.doc) skipped – please save it as .docx in Word, LibreOffice or Pages.");
  assert.equal(englishMessage(preview.warnings[0]), "Abschnitt.one: OneNote file skipped – please export it from OneNote as a Word document (.docx).");
  const result = await importFromSource(owner, wid, space, { name: "Gemischt.zip", bytes: zip });
  assert.equal(result.pages, 1);
  assert.ok(await pageByTitle("Neu"));
  assert.equal(await pageByTitle("Alt"), undefined);
});
