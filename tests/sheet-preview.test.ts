// The spreadsheet preview (#402): the cells of an uploaded .csv or .xlsx
// file as text – CSV delimiters, encodings and quotes; XLSX shared and
// inline strings, numbers, dates, booleans, formulas' cached values,
// several sheets, empty and merged cells – capped at 5,000 rows × 200
// columns, zip bombs refused or cut, .xls refused (415), the download's
// permissions, the published variant and the document block. The XLSX
// files are built here from minimal XML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { ZipFile } from "yazl";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-sheet-preview-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { readableFile } = await import("../lib/file-access");
const { csvRows, csvText, readSheet, sheetPreviewLimit, sheetPreviewResponse } = await import("../lib/sheet-preview");
const { readXlsx, serialDate, isDateFormat, XLSX_LIMITS } = await import("../lib/sheet-xlsx");
const files = await import("../lib/sheet-files");
const { HttpError } = await import("../lib/auth");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Owner"),
  viewer = await user("Viewer"),
  stranger = await user("Stranger");
const wid = await createWorkspace(owner.id, "Tabellen");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const doc = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Tabellen", kind: "document" })) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
async function file(name: string, content: string | Buffer, mime = "application/octet-stream") {
  const fid = id();
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  writeFileSync(join(uploads, fid), bytes);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, doc, name, mime, bytes.length, owner.id);
  return fid;
}
const refused = async (promise: Promise<unknown>, status: number) =>
  await assert.rejects(promise, (e: unknown) => e instanceof HttpError && e.status === status);
const csv = (text: string | Buffer) => readSheet(typeof text === "string" ? Buffer.from(text) : text, "liste.csv");

/* ---------- An XLSX from minimal XML ---------- */

async function zip(entries: Record<string, string | Buffer>) {
  const z = new ZipFile();
  for (const [name, content] of Object.entries(entries)) z.addBuffer(typeof content === "string" ? Buffer.from(content) : content, name);
  z.end();
  const chunks: Buffer[] = [];
  for await (const chunk of z.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
type Sheet = { name: string; rows: string; hidden?: boolean; extra?: string };
async function xlsx(sheets: Sheet[], options: { strings?: string[] | string; styles?: string; date1904?: boolean } = {}) {
  const entries: Record<string, string | Buffer> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${NS}>${options.date1904 ? `<workbookPr date1904="1"/>` : ""}<sheets>${sheets
      .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ` state="hidden"` : ""} r:id="rId${i + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  };
  sheets.forEach((s, i) => (entries[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.rows}</sheetData>${s.extra ?? ""}</worksheet>`));
  if (options.strings !== undefined)
    entries["xl/sharedStrings.xml"] =
      typeof options.strings === "string" ? options.strings : `<?xml version="1.0"?><sst ${NS}>${options.strings.map((s) => `<si>${s}</si>`).join("")}</sst>`;
  if (options.styles) entries["xl/styles.xml"] = options.styles;
  return await zip(entries);
}

test("names, the preview's address, column letters, the size limit", () => {
  assert.equal(files.sheetKindOf("Liste.CSV"), "csv");
  assert.equal(files.sheetKindOf(" umsatz.xlsx "), "xlsx");
  assert.equal(files.sheetKindOf("alt.xls"), "xls");
  for (const name of ["a.xlsm", "a.csv.zip", "csv", "a.ods", "a.tsv", ""]) assert.equal(files.sheetKindOf(name), null, name);
  assert.equal(files.isPreviewableSheet("a.xls"), false);
  assert.equal(files.isPreviewableSheet("a.xlsx"), true);
  assert.equal(files.sheetPreviewUrl("/api/files/abc"), "/api/files/abc/sheet");
  assert.equal(files.sheetPreviewUrl("/api/share/t/files/abc", 2), "/api/share/t/files/abc/sheet?sheet=2");
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702, 16383].map(files.columnName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA", "XFD"]);
  for (const n of [0, 25, 26, 701, 702, 16383]) assert.equal(files.columnIndex(files.columnName(n)), n);
  assert.equal(files.SHEET_PREVIEW_LIMIT, 20 * 1024 * 1024);
  assert.equal(sheetPreviewLimit(undefined), files.SHEET_PREVIEW_LIMIT);
  assert.equal(sheetPreviewLimit("x"), files.SHEET_PREVIEW_LIMIT);
  assert.equal(sheetPreviewLimit("-1"), files.SHEET_PREVIEW_LIMIT);
  assert.equal(sheetPreviewLimit("2"), 2 * 1024 * 1024);
  assert.equal(sheetPreviewLimit("1000"), 100 * 1024 * 1024);
});

test("CSV: the delimiter is guessed – comma, semicolon, tab, pipe", async () => {
  for (const [delimiter, text] of [
    [",", "Name,Ort,Menge\nAnna,Köln,3\nBen,Bonn,4\n"],
    [";", "Name;Ort;Menge\nAnna;Köln;3,5\nBen;Bonn;4\n"],
    ["\t", "Name\tOrt\tMenge\nAnna\tKöln\t3\nBen\tBonn\t4"],
    ["|", "Name|Ort|Menge\r\nAnna|Köln|3\r\nBen|Bonn|4\r\n"],
  ] as const) {
    const sheet = await csv(text);
    assert.equal(sheet.kind, "csv");
    assert.equal(sheet.delimiter, delimiter, JSON.stringify(text));
    assert.deepEqual(sheet.sheets, [""]);
    assert.equal(sheet.rows.length, 3);
    assert.deepEqual(sheet.rows[0], ["Name", "Ort", "Menge"]);
    assert.equal(sheet.rows[1][1], "Köln");
    assert.equal(sheet.columns, 3);
    assert.equal(sheet.truncated, false);
  }
  // The semicolon's decimal comma stays as written.
  assert.equal((await csv("a;b\n1;3,5\n2;4,25\n")).rows[1][1], "3,5");
});

test("CSV: quoted fields with delimiters, quotes and line breaks; empty lines", async () => {
  const sheet = await csv(`Titel,Notiz\n"Hallo, Welt","Er sagte ""ja"""\n"zwei\nZeilen",\n\nletzte,x\n\n`);
  assert.deepEqual(sheet.rows, [["Titel", "Notiz"], ["Hallo, Welt", 'Er sagte "ja"'], ["zwei\nZeilen", ""], [], ["letzte", "x"]]);
  assert.equal(sheet.columns, 2);
  // Ragged rows: the widest counts.
  const ragged = await csv("a,b\n1,2,3,4\n5\n");
  assert.equal(ragged.columns, 4);
  assert.deepEqual(ragged.rows[2], ["5"]);
  // Nothing at all.
  const empty = await csv("");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.columns, 0);
});

test("CSV encodings: UTF-8 with and without byte order mark, UTF-16, else Windows-1252", async () => {
  const text = "Straße;Größe\nÄpfel;€ 3\n";
  const plain = await csv(Buffer.from(text));
  assert.equal(plain.encoding, "utf-8");
  assert.deepEqual(plain.rows[0], ["Straße", "Größe"]);
  const bom = await csv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
  assert.equal(bom.encoding, "utf-8");
  // The mark is not part of the first cell.
  assert.equal(bom.rows[0][0], "Straße");
  const windows = await csv(Buffer.from([...Buffer.from("Stra", "latin1"), 0xdf, ...Buffer.from("e;Gr", "latin1"), 0xf6, 0xdf, 0x65, 0x0a, 0xc4, ...Buffer.from("pfel;", "latin1"), 0x80, ...Buffer.from(" 3\n", "latin1")]));
  assert.equal(windows.encoding, "windows-1252");
  assert.deepEqual(windows.rows, [["Straße", "Größe"], ["Äpfel", "€ 3"]]);
  const utf16 = await csv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Name\tOrt\nÖzil\tKöln\n", "utf16le")]));
  assert.equal(utf16.encoding, "utf-16le");
  assert.equal(utf16.delimiter, "\t");
  assert.deepEqual(utf16.rows[1], ["Özil", "Köln"]);
  assert.deepEqual(csvText(new Uint8Array(Buffer.from("ok"))), { text: "ok", encoding: "utf-8" });
});

test("CSV caps: 5,000 rows and 200 columns, then truncated", async () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1},x`).join("\n");
  const exact = await csv(lines(files.SHEET_MAX_ROWS));
  assert.equal(exact.rows.length, 5000);
  assert.equal(exact.truncated, false);
  const more = await csv(lines(files.SHEET_MAX_ROWS + 1));
  assert.equal(more.rows.length, 5000);
  assert.equal(more.rows[4999][0], "5000");
  assert.equal(more.truncated, true);
  assert.deepEqual(more.limits, { rows: 5000, columns: 200 });
  const wide = await csv(`${Array.from({ length: 205 }, (_, i) => `c${i}`).join(",")}\n1,2\n`);
  assert.equal(wide.columns, 200);
  assert.equal(wide.rows[0].length, 200);
  assert.equal(wide.rows[0][199], "c199");
  assert.equal(wide.truncated, true);
  // Empty cells beyond the cap are no reason.
  assert.equal(csvRows(`a,b${",".repeat(300)}\n`).truncated, false);
});

test("XLSX: shared strings (rich text joined), inline strings, numbers as stored, booleans, errors, formulas' cached values", async () => {
  const book = await xlsx(
    [
      {
        name: "Daten",
        rows:
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
          `<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2" t="inlineStr"><is><r><t>fett</t></r><r><rPr><b/></rPr><t xml:space="preserve"> und dünn</t></r></is></c><c r="C2"><v>1.5</v></c><c r="D2"><v>0.30000000000000004</v></c><c r="E2"><v>1E-3</v></c></row>` +
          `<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="e"><v>#DIV/0!</v></c><c r="D3"><f>SUM(C2:C2)*2</f><v>3</v></c><c r="E3" t="str"><f>A2&amp;"!"</f><v>inline!</v></c><c r="F3"><f>NOW()</f></c></row>` +
          `<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4" t="s"><v>99</v></c><c r="C4"><v>-42</v></c></row>`,
      },
    ],
    {
      strings: [
        "<t>Name</t>",
        "<r><t>Rich</t></r><r><rPr><i/></rPr><t xml:space=\"preserve\"> Text</t></r>",
        "<t>A &amp; B &lt;c&gt; &#228;</t>",
        "<t>漢字</t><rPh sb=\"0\" eb=\"2\"><t>カンジ</t></rPh>",
      ],
    },
  );
  const sheet = await readSheet(book, "daten.xlsx");
  assert.equal(sheet.kind, "xlsx");
  assert.deepEqual(sheet.sheets, ["Daten"]);
  assert.deepEqual(sheet.rows, [
    ["Name", "Rich Text", "A & B <c> ä"],
    ["inline", "fett und dünn", "1.5", "0.30000000000000004", "1E-3"],
    ["TRUE", "FALSE", "#DIV/0!", "3", "inline!"],
    // A formula without a saved value and a string index that is not there: empty.
    ["漢字", "", "-42"],
  ]);
  assert.equal(sheet.columns, 5);
  assert.equal(sheet.truncated, false);
});

test("XLSX dates: built-in and own date formats as ISO dates, times, the 1904 system; other numbers stay", async () => {
  const styles = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/><numFmt numFmtId="165" formatCode="#,##0.00&quot; Std.&quot;"/><numFmt numFmtId="166" formatCode="[$-407]d\\.\\ mmmm\\ yyyy;@"/><numFmt numFmtId="167" formatCode="[Red]0.00"/></numFmts><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="21"/><xf numFmtId="167"/></cellXfs></styleSheet>`;
  const rows =
    `<row r="1"><c r="A1" s="1"><v>46346</v></c><c r="B1" s="2"><v>46346.604166666664</v></c><c r="C1" s="3"><v>12.5</v></c><c r="D1" s="4"><v>1</v></c><c r="E1" s="5"><v>0.75</v></c><c r="F1" s="6"><v>46346</v></c><c r="G1"><v>46346</v></c></row>` +
    `<row r="2"><c r="A2" s="1"><v>59</v></c><c r="B2" s="1"><v>61</v></c><c r="C2" t="d"><v>2026-11-20T00:00:00Z</v></c><c r="D2" t="d"><v>2026-11-20T14:05:09</v></c><c r="E2" s="2"><v>46346.5000057</v></c></row>`;
  const sheet = await readSheet(await xlsx([{ name: "Termine", rows }], { styles }), "termine.xlsx");
  assert.deepEqual(sheet.rows, [
    ["2026-11-20", "2026-11-20 14:30", "12.5", "1900-01-01", "18:00", "46346", "46346"],
    ["1900-02-28", "1900-03-01", "2026-11-20", "2026-11-20 14:05:09", "2026-11-20 12:00"],
  ]);
  const old = await readSheet(await xlsx([{ name: "Mac", rows: `<row r="1"><c r="A1" s="1"><v>44884</v></c></row>` }], { styles, date1904: true }), "mac.xlsx");
  assert.deepEqual(old.rows, [["2026-11-20"]]);
  assert.equal(serialDate(-1), null);
  assert.equal(serialDate(0.5), "12:00");
  assert.equal(isDateFormat(14), true);
  assert.equal(isDateFormat(2), false);
  assert.equal(isDateFormat(200, "General"), false);
  assert.equal(isDateFormat(200, '0.0" days"'), false);
  assert.equal(isDateFormat(200, "yyyy-mm-dd"), true);
});

test("XLSX: several sheets – names, the one asked for, hidden ones left out; empty and merged cells blank, gaps kept", async () => {
  const book = await xlsx(
    [
      {
        name: "Übersicht",
        // A1:B1 merged: Excel keeps the value in A1, B1 is an empty styled cell.
        rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Zusammen</t></is></c><c r="B1" s="0"/><c r="C1" t="inlineStr"><is><t>C</t></is></c></row><row r="2"/><row r="4"><c r="B4"><v>7</v></c><c r="D4"><v>8</v></c></row>`,
        extra: `<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>`,
      },
      { name: "Geheim", hidden: true, rows: `<row r="1"><c r="A1"><v>1</v></c></row>` },
      { name: "Zahlen &amp; Co", rows: `<row><c><v>1</v></c><c><v>2</v></c></row><row><c t="inlineStr"><is><t>ohne r</t></is></c></row>` },
    ],
    { strings: [] },
  );
  const first = await readSheet(book, "mappe.xlsx", 0);
  assert.deepEqual(first.sheets, ["Übersicht", "Zahlen & Co"]);
  assert.equal(first.sheet, 0);
  assert.deepEqual(first.rows, [["Zusammen", "", "C"], [], [], ["", "7", "", "8"]]);
  assert.equal(first.columns, 4);
  const second = await readSheet(book, "mappe.xlsx", 1);
  assert.equal(second.sheet, 1);
  assert.deepEqual(second.rows, [["1", "2"], ["ohne r"]]);
  // A sheet number beyond the last: the last.
  assert.equal((await readSheet(book, "mappe.xlsx", 7)).sheet, 1);
  // Without shared strings and styles, an empty sheet.
  const empty = await readSheet(await xlsx([{ name: "Leer", rows: "" }]), "leer.xlsx");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.columns, 0);
});

test("XLSX caps: 5,000 rows and 200 columns, then truncated", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join("");
  const exact = await readSheet(await xlsx([{ name: "S", rows: rows(5000) }]), "s.xlsx");
  assert.equal(exact.rows.length, 5000);
  assert.equal(exact.truncated, false);
  const more = await readSheet(await xlsx([{ name: "S", rows: rows(5001) }]), "s.xlsx");
  assert.equal(more.rows.length, 5000);
  assert.equal(more.rows[4999][0], "5000");
  assert.equal(more.truncated, true);
  const wide = await readSheet(await xlsx([{ name: "S", rows: `<row r="1"><c r="A1"><v>1</v></c><c r="GR1"><v>200</v></c><c r="GS1"><v>201</v></c></row>` }]), "s.xlsx");
  assert.equal(wide.columns, 200);
  assert.equal(wide.rows[0][199], "200");
  assert.equal(wide.truncated, true);
});

test("zip bombs: parts over their cap are refused unread, a sheet over its cap is read only up to it", async () => {
  // 100 MB of shared strings, packed to a few hundred KB: refused by the
  // declared size before anything is unpacked.
  const huge = Buffer.alloc(100 * 1024 * 1024, 0x20);
  const bomb = await xlsx([{ name: "S", rows: "" }], { strings: Buffer.concat([Buffer.from(`<sst ${NS}><si><t>`), huge]).toString("latin1") });
  assert.ok(bomb.length < 2 * 1024 * 1024);
  await refused(readSheet(bomb, "bombe.xlsx"), 413);
  // A sheet larger than its cap: only its beginning is read, the rows in it
  // are shown, the last incomplete one is left out, and it says so.
  const rows = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join("");
  const book = await xlsx([{ name: "S", rows }]);
  const cut = await readXlsx(book, 0, { ...XLSX_LIMITS, sheetBytes: 20_000 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.rows.length > 100 && cut.rows.length < 3000, String(cut.rows.length));
  assert.deepEqual(cut.rows[cut.rows.length - 1], [String(cut.rows.length)]);
  // All parts together share one budget.
  await refused(readXlsx(book, 0, { ...XLSX_LIMITS, totalBytes: 600 }), 413);
  // Not a ZIP, or no workbook in it.
  await refused(readSheet(Buffer.from("not a zip"), "x.xlsx"), 422);
  await refused(readSheet(await zip({ "a.txt": "x" }), "x.xlsx"), 422);
});

test("the route: the download's permissions, .xls and other files refused, the size limit", async () => {
  const get = (q = "") => new Request(`http://localhost/api/files/x/sheet${q}`);
  const preview = async (as: Identity, fid: string, q = "") => await sheetPreviewResponse(get(q), await readableFile(as, fid));
  const book = await file("mappe.xlsx", await xlsx([{ name: "Eins", rows: `<row r="1"><c r="A1"><v>1</v></c></row>` }, { name: "Zwei", rows: `<row r="1"><c r="A1"><v>2</v></c></row>` }]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const response = await preview(viewer, book, "?sheet=1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body.sheets, ["Eins", "Zwei"]);
  assert.deepEqual(body.rows, [["2"]]);
  // Nonsense sheet numbers: the first.
  assert.equal((await (await preview(owner, book, "?sheet=-3")).json()).sheet, 0);
  assert.equal((await (await preview(owner, book, "?sheet=abc")).json()).sheet, 0);
  await refused(preview(stranger, book), 403);
  await refused(readableFile(stranger, book), 403);
  await refused(preview(owner, id()), 404);
  const list = await file("liste.csv", "a,b\n1,2\n", "text/csv");
  assert.deepEqual((await (await preview(owner, list)).json()).rows, [["a", "b"], ["1", "2"]]);
  // Old Excel files and anything else: 415, with the reason.
  await refused(preview(owner, await file("alt.xls", Buffer.from("d0cf11e0a1b11ae1", "hex"), "application/vnd.ms-excel")), 415);
  await assert.rejects(readSheet(Buffer.alloc(0), "alt.xls"), /97–2003/);
  await refused(preview(owner, await file("notiz.txt", "a,b")), 415);
  const previous = process.env.FLOWPLAN_SHEET_PREVIEW_MB;
  process.env.FLOWPLAN_SHEET_PREVIEW_MB = "0.0001";
  try {
    await assert.rejects(preview(owner, await file("gross.csv", "x,".repeat(200))), (e: unknown) => e instanceof HttpError && e.status === 413 && /0 MB|0\.\d MB/.test(e.message));
  } finally {
    if (previous === undefined) delete process.env.FLOWPLAN_SHEET_PREVIEW_MB;
    else process.env.FLOWPLAN_SHEET_PREVIEW_MB = previous;
  }
});

test("published pages: the preview has the checks of the published file", async () => {
  const { GET } = await import("../app/api/share/[token]/files/[fileId]/sheet/handler");
  const fid = await file("veroeffentlicht.csv", "Name;Wert\nA;1\n");
  const unused = await file("anderes.csv", "x");
  await run("UPDATE documents SET html=? WHERE page_id=?", `<div data-sheet-file="true" data-title="veroeffentlicht.csv" class="sheet-block"><a href="/api/files/${fid}">veroeffentlicht.csv</a></div>`, doc);
  const { token } = (await command(owner, { action: "share.create", pageId: doc, name: "Öffentlich", role: "viewer" })) as { token: string };
  const call = async (fileId: string) => await GET(new Request(`http://localhost/api/share/${token}/files/${fileId}/sheet`), { params: Promise.resolve({ token, fileId }) });
  const shown = await call(fid);
  assert.equal(shown.status, 200);
  assert.deepEqual((await shown.json()).rows, [["Name", "Wert"], ["A", "1"]]);
  assert.equal((await call(unused)).status, 404);
});

test("the document block survives cleaning and saving; only Flowplan files", async () => {
  const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
  const fid = "0f5c6a1e-2b3c-4d5e-8f90-123456789abc";
  const block = `<div data-sheet-file="true" data-title="umsatz.xlsx" class="sheet-block"><a href="/api/files/${fid}">umsatz.xlsx</a></div>`;
  const clean = cleanHtml(`<p>Vorher</p>${block}<p>Nachher</p>`);
  assert.match(clean, /data-sheet-file="true"/);
  const saved = new Y.Doc();
  Y.applyUpdate(saved, htmlState(clean));
  assert.match(stateHtml(saved), new RegExp(`<div data-sheet-file="true" data-title="umsatz.xlsx" class="sheet-block"><a href="/api/files/${fid}"[^>]*>umsatz.xlsx</a></div>`));
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, htmlState(`<div data-sheet-file="true" data-title="x.csv"><a href="https://example.com/x.csv">x.csv</a></div>`));
  assert.doesNotMatch(stateHtml(foreign), /data-sheet-file/);
});

test("the viewer's filter and sort: any cell, ignoring case and accents; numbers as numbers, empty cells last", () => {
  const rows = [["Name", "Menge"], ["Äpfel", "10"], ["birnen", "9"], ["Kiwi", ""], ["apfelsaft", "100"], ["Zitrone", "-1"]];
  assert.deepEqual(files.filterRows(rows, "apf", 1), [1, 4]);
  assert.deepEqual(files.filterRows(rows, "  ", 1), [1, 2, 3, 4, 5]);
  assert.deepEqual(files.filterRows(rows, "name"), [0]);
  const all = [1, 2, 3, 4, 5];
  assert.deepEqual(files.sortRows(rows, all, 1, false), [5, 2, 1, 4, 3]);
  assert.deepEqual(files.sortRows(rows, all, 1, true), [4, 1, 2, 5, 3]);
  assert.deepEqual(files.sortRows(rows, all, 0, false), [1, 4, 2, 3, 5]);
  assert.equal(files.compareCells("Item 2", "Item 10") < 0, true);
});
