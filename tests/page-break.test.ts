// The page break block (#216): schema, storage, Markdown export and import,
// Word, the combined print view and e-books.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-break-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { htmlState, htmlJson, jsonHtml, cleanHtml, stateHtml } = await import("../lib/document-server");
const { documentSchema } = await import("../lib/document-schema");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { exportDocx } = await import("../lib/export-docx");
const { exportEpub } = await import("../lib/export-epub");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { readExportZip } = await import("./helpers/read-export-zip");
const { assertWellFormedXml } = await import("./helpers/xml-check");
const { isPageBreakStyle } = await import("../lib/page-break-node");
const { prosemirrorJSONToYDoc } = await import("y-prosemirror");

const BREAK = /<div[^>]*(data-page-break(="")?[^>]*class="page-break"|class="page-break"[^>]*data-page-break)[^>]*><\/div>/;
const ctx = { url: (url: string) => url, linked: () => null };

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Autorin", "autorin@example.test");
const owner = { id: uid, name: "Autorin", email: "autorin@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
const wid = await createWorkspace(owner.id, "Umbruch");
const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Texte" })) as { id: string }).id;
const page = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Bericht", kind: "document" })) as { id: string }).id;
const html = `<p>Erste Seite</p><div data-page-break="" class="page-break"></div><p>Zweite Seite</p>`;
await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), page);

test("the page break is an atom block of the document schema and survives storage and collaboration", () => {
  const schema = documentSchema();
  const type = schema.nodes.pageBreak;
  assert.ok(type, "pageBreak is in the schema");
  assert.equal(type.isAtom, true);
  assert.equal(type.isBlock, true);
  const json = htmlJson(cleanHtml(html)) as { content: { type: string }[] };
  assert.deepEqual(json.content.map((n) => n.type), ["paragraph", "pageBreak", "paragraph"]);
  assert.match(jsonHtml(json), BREAK);
  // Through the Yjs state (collaborative editing) and back.
  const doc = prosemirrorJSONToYDoc(schema, json, "default");
  assert.match(stateHtml(doc), BREAK);
  doc.destroy();
});

test("pasted or imported HTML with a page break style becomes the block", () => {
  for (const style of ["page-break-after: always", "page-break-before:always", "break-after: page"]) {
    const cleaned = cleanHtml(`<p>A</p><div style="${style}"></div><p>B</p>`);
    const json = htmlJson(cleaned) as { content: { type: string }[] };
    assert.deepEqual(json.content.map((n) => n.type), ["paragraph", "pageBreak", "paragraph"], style);
  }
  assert.equal(isPageBreakStyle("page-break-after: avoid"), false);
  assert.equal(isPageBreakStyle("break-inside: avoid"), false);
  assert.equal(isPageBreakStyle("color: red; page-break-before: always"), true);
});

test("Markdown export writes the page break div, the import reads it and \\pagebreak / \\newpage back", () => {
  const md = htmlToMarkdown(html, ctx);
  assert.match(md, /Erste Seite\n\n<div style="page-break-after: always"><\/div>\n\nZweite Seite/);
  const back = markdownToHtml(md);
  assert.match(back, BREAK);
  for (const source of ["Eins\n\n\\pagebreak\n\nZwei", "Eins\n\n\\newpage\n\nZwei", "Eins\n\n<div style=\"page-break-before: always\"></div>\n\nZwei"]) {
    const json = htmlJson(markdownToHtml(source)) as { content: { type: string }[] };
    assert.deepEqual(json.content.map((n) => n.type), ["paragraph", "pageBreak", "paragraph"], source);
  }
  // In code it stays text.
  const code = markdownToHtml("```\n\\pagebreak\n```");
  assert.doesNotMatch(code, /page-break/);
  assert.match(code, /\\pagebreak/);
  // Other raw HTML is still shown as text.
  assert.doesNotMatch(markdownToHtml('<div style="color: red"></div>'), /<div/);
});

test("Word gets a real page break, the print view and e-books a break after the block", async () => {
  const docx = await exportDocx(owner, { pageId: page });
  const parts = await readExportZip(docx.bytes);
  const document = parts.get("word/document.xml")!.toString("utf8");
  assertWellFormedXml(document, "document.xml");
  assert.match(document, /Erste Seite.*<w:br w:type="page"\/>.*Zweite Seite/s);

  const print = (await exportPrintHtml(owner, { pageId: page })).html;
  assert.match(print, /Erste Seite<\/p><div class="page-break"><\/div><p>Zweite Seite/);
  assert.match(print, /\.print-book \.page-break \{ break-after: page; page-break-after: always;/);

  const epub = await exportEpub(owner, { pageId: page });
  const book = await readExportZip(epub.bytes);
  const chapter = [...book.entries()].find(([name]) => /\.xhtml$/.test(name) && /Erste Seite/.test(name === "" ? "" : book.get(name)!.toString("utf8")));
  assert.ok(chapter, "a chapter holds the text");
  const text = chapter[1].toString("utf8");
  assertWellFormedXml(text, chapter[0]);
  assert.match(text, /<div class="page-break"><\/div>/);
});
