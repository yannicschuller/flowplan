import { test, expect, type Page } from "@playwright/test";
import { ZipFile } from "yazl";

// The spreadsheet viewer (#402): an XLSX, a CSV and an old XLS dropped into
// a document become cards; the viewer shows the cells with column letters
// and row numbers, its sheet tabs switch sheets, the filter narrows the
// rows, a click on a column letter sorts the view; a long CSV is cut at
// 5,000 rows with a note and scrolls with only the rows in view rendered.

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const row = (n: number, cells: string) => `<row r="${n}">${cells}</row>`;
async function workbook() {
  const sheets = {
    Januar:
      row(1, `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>`) +
      row(2, `${inline("A2", "Nord")}<c r="B2"><v>1200</v></c><c r="C2" s="1"><v>46346</v></c>`) +
      row(3, `${inline("A3", "Süd")}<c r="B3"><v>950.5</v></c><c r="C3" s="1"><v>46347</v></c>`) +
      row(4, `${inline("A4", "West")}<c r="B4"><f>B2+B3</f><v>2150.5</v></c><c r="C4" t="b"><v>1</v></c>`),
    Februar: row(1, `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`) + row(2, `${inline("A2", "Ost")}<c r="B2"><v>77</v></c>`),
  };
  const names = Object.keys(sheets);
  const z = new ZipFile();
  const add = (name: string, xml: string) => z.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${xml}`), name);
  add("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml", `<workbook ${NS}><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  add(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  );
  add("xl/sharedStrings.xml", `<sst ${NS}><si><t>Region</t></si><si><t>Umsatz</t></si><si><t>Datum</t></si></sst>`);
  add("xl/styles.xml", `<styleSheet ${NS}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  Object.values(sheets).forEach((rows, i) => add(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`));
  z.end();
  const chunks: Buffer[] = [];
  for await (const chunk of z.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const CSV = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Stadt;Einwohner\nKöln;1084831\nBonn;336465\nAachen;261000\n")]);
const LONG = Buffer.from(["Nr,Wert", ...Array.from({ length: 6000 }, (_, i) => `${i + 1},Zeile ${i + 1}`)].join("\n"));

// Files dropped onto the document, as from the desktop.
async function drop(page: Page, files: { name: string; type: string; data: Buffer }[]) {
  await page
    .locator(".page-content .ProseMirror")
    .first()
    .evaluate((el, list) => {
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.left + 20, clientY: box.bottom - 10, bubbles: true, cancelable: true, dataTransfer: data };
      el.dispatchEvent(new DragEvent("dragover", at));
      el.dispatchEvent(new DragEvent("drop", at));
    }, files.map((f) => ({ ...f, data: f.data.toString("base64") })));
}

test("spreadsheets dropped into a document: cards, the viewer with sheets, filter and sort", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Tabellen ${info.project.name} ${Date.now()}`, kind: "document" },
  });
  const p = await response.json();
  await page.goto(`/#page=${p.id}`);
  const text = page.locator(".page-content .ProseMirror").first();
  await expect(text).toBeVisible({ timeout: 20_000 });
  await text.click();
  await page.keyboard.type("Zahlen:");
  await page.keyboard.press("Enter");
  // One at a time, so the cards come in this order.
  await drop(page, [{ name: "umsatz.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: await workbook() }]);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const book = editor.getByRole("button", { name: "Vorschau von „umsatz.xlsx“ öffnen" });
  await expect(book).toBeVisible({ timeout: 20_000 });
  await expect(book).toContainText("Tabelle · Vorschau öffnen");
  await drop(page, [{ name: "staedte.csv", type: "text/csv", data: CSV }]);
  const list = editor.getByRole("button", { name: "Vorschau von „staedte.csv“ öffnen" });
  await expect(list).toBeVisible({ timeout: 20_000 });
  await drop(page, [{ name: "alt.xls", type: "application/vnd.ms-excel", data: Buffer.from("d0cf11e0a1b11ae1", "hex") }]);
  // The old format: only the download, which the card says.
  const old = editor.getByRole("link", { name: "„alt.xls“ herunterladen" });
  await expect(old).toBeVisible({ timeout: 20_000 });
  await expect(old).toContainText("Excel 97–2003 · nur Download");
  await expect(old).toHaveAttribute("download", "alt.xls");

  // The workbook: cells as Excel shows them, letters and row numbers.
  await book.click();
  const viewer = page.getByRole("dialog", { name: "umsatz.xlsx" });
  await expect(viewer).toBeVisible();
  const grid = viewer.locator("table.sheet-grid");
  await expect(grid).toBeVisible({ timeout: 15_000 });
  await expect(grid.locator(".sheet-letters th button")).toHaveText(["A", "B", "C"]);
  await expect(grid.locator(".sheet-head th")).toHaveText(["1", "Region", "Umsatz", "Datum"]);
  const body = grid.locator("tbody tr:not(.sheet-spacer)");
  await expect(body).toHaveCount(3);
  await expect(body.nth(0).locator("th, td")).toHaveText(["2", "Nord", "1200", "2026-11-20"]);
  await expect(body.nth(2).locator("td")).toHaveText(["West", "2150.5", "TRUE"]);
  await expect(viewer.getByRole("status")).toHaveText("3 Zeilen");
  await expect(viewer.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("download", "umsatz.xlsx");

  // The filter narrows the rows, case and accents aside.
  const filter = viewer.getByRole("searchbox", { name: "Zeilen filtern" });
  await filter.fill("sud");
  await expect(body).toHaveCount(1);
  await expect(body.first().locator("td").first()).toHaveText("Süd");
  await expect(viewer.getByRole("status")).toHaveText("1 von 3 Zeilen");
  await filter.fill("");
  await expect(body).toHaveCount(3);
  // A click on a column letter sorts the view: up, down, as in the file.
  const umsatz = grid.locator(".sheet-letters th").nth(2);
  await umsatz.getByRole("button").click();
  await expect(umsatz).toHaveAttribute("aria-sort", "ascending");
  await expect(body.locator("td:first-of-type")).toHaveText(["Süd", "Nord", "West"]);
  await umsatz.getByRole("button").click();
  await expect(umsatz).toHaveAttribute("aria-sort", "descending");
  await expect(body.locator("td:first-of-type")).toHaveText(["West", "Nord", "Süd"]);
  await umsatz.getByRole("button").click();
  await expect(umsatz).toHaveAttribute("aria-sort", "none");

  // Sheet tabs switch the sheet.
  const tabs = viewer.getByRole("tablist", { name: "Tabellenblätter" });
  await expect(tabs.getByRole("tab")).toHaveText(["Januar", "Februar"]);
  await expect(tabs.getByRole("tab", { name: "Januar" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Februar" }).click();
  await expect(tabs.getByRole("tab", { name: "Februar" })).toHaveAttribute("aria-selected", "true");
  await expect(body).toHaveCount(1);
  await expect(body.first().locator("td")).toHaveText(["Ost", "77"]);
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // The CSV: semicolons, with a byte order mark.
  await list.click();
  const csv = page.getByRole("dialog", { name: "staedte.csv" });
  await expect(csv.locator(".sheet-head th")).toHaveText(["1", "Stadt", "Einwohner"], { timeout: 15_000 });
  await expect(csv.locator("tbody tr:not(.sheet-spacer)").first().locator("td")).toHaveText(["Köln", "1084831"]);
  await expect(csv.getByRole("tablist")).toHaveCount(0);
  // Without the header row the first line is a row like the others.
  await csv.getByRole("button", { name: "Kopfzeile" }).click();
  await expect(csv.locator(".sheet-head")).toHaveCount(0);
  await expect(csv.getByRole("status")).toHaveText("4 Zeilen");
  await csv.getByRole("button", { name: "Schließen" }).click();
  await expect(csv).toBeHidden();

  // A long CSV: cut at 5,000 rows with a note; only the rows in view are there.
  await drop(page, [{ name: "lang.csv", type: "text/csv", data: LONG }]);
  const long = editor.getByRole("button", { name: "Vorschau von „lang.csv“ öffnen" });
  await expect(long).toBeVisible({ timeout: 20_000 });
  await long.click();
  const big = page.getByRole("dialog", { name: "lang.csv" });
  await expect(big.getByText("Gezeigt werden höchstens die ersten 5.000 Zeilen und 200 Spalten")).toBeVisible({ timeout: 15_000 });
  await expect(big.getByRole("status")).toHaveText("4.999 Zeilen");
  const rendered = big.locator("tbody tr:not(.sheet-spacer)");
  expect(await rendered.count()).toBeLessThan(200);
  await big.locator(".sheet-viewer-scroll").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(big.locator("tbody th.sheet-number", { hasText: /^5000$/ })).toBeVisible();
  expect(await rendered.count()).toBeLessThan(200);
  await big.getByRole("searchbox", { name: "Zeilen filtern" }).fill("Zeile 4321");
  await expect(rendered).toHaveCount(1);
  await expect(rendered.first().locator("th")).toHaveText("4322");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(big).toBeHidden();
  expect(errors).toEqual([]);
});
