// The parsers of uploaded files stay linear on crafted input (#470, #478):
// each case is a small input of a shape that used to cost quadratic time
// (seconds with the old code) and must now finish well within a bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-linear-"));
const { writeZip } = await import("../lib/archive");
const { officeText } = await import("../lib/office-text");
const { sharedStrings, sheetRows, dateStyles, isDateFormat } = await import("../lib/sheet-xlsx");

// Generous for slow CI machines; the old code took several seconds per case.
const BOUND_MS = 2000;
async function within<T>(label: string, work: () => T | Promise<T>) {
  const start = performance.now();
  const result = await work();
  const ms = performance.now() - start;
  assert.ok(ms < BOUND_MS, `${label} took ${Math.round(ms)} ms`);
  return result;
}
const zip = (files: Record<string, string>) => writeZip(new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
const N = 40_000;

test("Office text extraction is linear on unclosed tags (#470)", async () => {
  // The first ZIP read opens the database (its limit is a setting); not timed.
  await officeText(await zip({ "word/document.xml": "" }), "docx");
  const xlsx = await zip({ "xl/worksheets/sheet1.xml": "<t ".repeat(N) });
  assert.equal(await within("xlsx", () => officeText(xlsx, "xlsx")), "");
  const docx = await zip({ "word/document.xml": "<w:p ".repeat(N) + "<w:t>Ende</w:t>" });
  assert.equal(await within("docx", () => officeText(docx, "docx")), "Ende");
  const odt = await zip({ "content.xml": "<office:body>" + "<text:s ".repeat(N) + "<".repeat(N) + "Text" });
  // Malformed markup stays as text (cut at the index's limit); what counts is the time.
  assert.equal(typeof (await within("odt", () => officeText(odt, "odt"))), "string");
  // A long run of white space without a line break.
  const spaces = await zip({ "word/document.xml": `<w:t>a${"&#13;".repeat(N)}b</w:t>` });
  assert.equal(await within("white space", () => officeText(spaces, "docx")), `a${"\r".repeat(N)}b`);
});

test("Office text keeps its paragraphs and white space handling", async () => {
  const docx = await zip({
    "word/document.xml": '<w:p><w:t xml:space="preserve">  Eins  </w:t></w:p>\r\n<w:p></w:p><w:p><w:t>Zwei\tdrei</w:t></w:p>',
  });
  assert.equal(await officeText(docx, "docx"), "Eins\nZwei drei");
});

test("The spreadsheet preview parser is linear on crafted XML (#470)", async () => {
  const ctx = { strings: [], dates: [], date1904: false };
  await within("rows unclosed", () => sheetRows("<sheetData>" + "<row>".repeat(N), ctx));
  await within("rows open tags", () => sheetRows("<sheetData>" + "<row ".repeat(N), ctx));
  await within("cells unclosed", () => sheetRows("<sheetData><row>" + "<c>".repeat(N) + "</row>", ctx));
  await within("attributes", () => sheetRows(`<sheetData><row ${"a".repeat(N * 3)}/></sheetData>`, ctx));
  await within("strings", () => sharedStrings("<si>".repeat(N)));
  await within("phonetic", () => sharedStrings("<si>" + "<rPh>".repeat(N) + "</si>"));
  await within("inline string", () => sheetRows('<sheetData><row><c t="inlineStr">' + "<is>".repeat(N) + "</c></row>", ctx));
  await within("styles", () => dateStyles("<cellXfs>".repeat(N) + "<numFmt ".repeat(N)));
  await within("format code", () => isDateFormat(200, "[".repeat(N * 3)));
});

test("The spreadsheet preview still reads well-formed sheets", () => {
  const strings = sharedStrings('<sst><si><t>Name</t></si><si><r><t>Ri</t></r><r><t xml:space="preserve">ch</t></r><rPh><t>x</t></rPh></si><si/></sst>');
  assert.deepEqual(strings, ["Name", "Rich", ""]);
  const dates = dateStyles('<numFmts><numFmt numFmtId="164" formatCode="[$-407]dd.mm.yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>');
  assert.deepEqual(dates, [false, true]);
  const rows = sheetRows(
    '<x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>1</x:v></x:c><x:c r="B1" s="1"><x:v>46000</x:v></x:c><x:c r="C1"/></x:row><x:row r="3"><x:c r="B3" t="inlineStr"><x:is><x:t>inline</x:t></x:is></x:c></x:row><x:row r="4"/></x:sheetData>',
    { strings, dates, date1904: false },
  );
  assert.deepEqual(rows.rows, [["Rich", "2025-12-09"], [], ["", "inline"]]);
});
