import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ocr-"));
const { writeZip } = await import("../lib/archive");
const { officeText, officeKind } = await import("../lib/office-text");
const { ocrImage, stopOcr } = await import("../lib/ocr");
const { pdfScanImages, pdfText } = await import("../lib/pdf-text");
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { extractPendingFileTexts } = await import("../lib/file-text");
const { searchWorkspace } = await import("../lib/search-index");
after(() => stopOcr());

const zip = (files: Record<string, string>) =>
  writeZip(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));

test("Office documents yield their text", async () => {
  assert.equal(officeKind("application/octet-stream", "Bericht.DOCX"), "docx");
  assert.equal(officeKind("text/plain", "notiz.txt"), null);
  const docx = await zip({
    "word/document.xml":
      '<w:document><w:body><w:p><w:r><w:t>Angebot für</w:t></w:r><w:r><w:t xml:space="preserve"> Müller &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Zweiter Absatz</w:t></w:r></w:p></w:body></w:document>',
  });
  assert.equal(
    await officeText(docx, "docx"),
    "Angebot für Müller & Co\nZweiter Absatz",
  );
  const xlsx = await zip({
    "xl/sharedStrings.xml":
      "<sst><si><t>Umsatz</t></si><si><t>Kosten</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>1234</v></c></row></sheetData></worksheet>',
  });
  assert.match(
    await officeText(xlsx, "xlsx"),
    /Umsatz[\s\S]*Kosten[\s\S]*1234/,
  );
  const pptx = await zip({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:t>Ausblick</a:t></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:t>Rückblick</a:t></a:p></p:sld>",
  });
  assert.equal(await officeText(pptx, "pptx"), "Rückblick\nAusblick");
  const odt = await zip({
    "content.xml":
      "<office:document-content><office:body><office:text><text:h>Protokoll</text:h><text:p>Teilnehmer: <text:span>Kim</text:span><text:tab/>und Lea</text:p></office:text></office:body></office:document-content>",
  });
  assert.equal(
    await officeText(odt, "odt"),
    "Protokoll\nTeilnehmer: Kim und Lea",
  );
});

test("scanned images and PDFs are recognised", async () => {
  const text = await ocrImage(readFileSync("tests/fixtures/scan.png"));
  assert.match(text, /Rechnung/);
  assert.match(text, /4711/);
  const pdf = readFileSync("tests/fixtures/scan.pdf");
  assert.equal((await pdfText(pdf)).trim(), "");
  const pages = await pdfScanImages(pdf);
  assert.equal(pages.length, 1);
  assert.match(await ocrImage(pages[0]), /Wartungsvertrag/);
});

test("the background extraction makes Office files and scans searchable", async (t) => {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "ocr",
    "ocr@example.test",
  );
  const owner = {
    id: uid,
    name: "ocr",
    email: "ocr@example.test",
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
  const wid = createWorkspace(owner.id, "Scans");
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Ablage",
    }) as { id: string }
  ).id;
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  const attach = (name: string, mime: string, data: Buffer) => {
    const fid = id();
    writeFileSync(join(dir, fid), data);
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      fid,
      page,
      name,
      mime,
      data.length,
      owner.id,
    );
  };
  attach(
    "scan.pdf",
    "application/pdf",
    readFileSync("tests/fixtures/scan.pdf"),
  );
  attach(
    "brief.docx",
    "application/octet-stream",
    await zip({
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Kündigungsbestätigung</w:t></w:r></w:p></w:body></w:document>",
    }),
  );
  while (await extractPendingFileTexts());
  const titles = (q: string) =>
    searchWorkspace(owner, wid, q, { kind: "file" }).map((r) => r.title);
  // Scans are only searchable with text recognition (FLOWPLAN_OCR=0 turns it off).
  if (process.env.FLOWPLAN_OCR === "0")
    t.diagnostic("Texterkennung abgeschaltet – Scan-Suche nicht geprüft.");
  else assert.deepEqual(titles("Wartungsvertrag"), ["scan.pdf"]);
  assert.deepEqual(titles("Kündigungsbestätigung"), ["brief.docx"]);
});
