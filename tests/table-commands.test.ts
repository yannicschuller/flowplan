// Rows and columns of document tables (#240, lib/table-commands.ts): move,
// duplicate, insert, clear, delete, the header staying the header, cell
// colours as names through storage, cleaning and Markdown, and the
// keyboard's row selection.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-table-commands-"));
process.env.APP_URL = "https://flowplan.example.test";

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
if (!("requestAnimationFrame" in g)) g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
after(async () => {
  await win.happyDOM.close();
});

const { documentSchema } = await import("../lib/document-schema");
const commands = await import("../lib/table-commands");
const { htmlState, stateHtml, cleanHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { CellSelection } = await import("@tiptap/pm/tables");

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const cell = (text: string, attrs: Record<string, unknown> | null = null) => schema.nodes.tableCell.create(attrs, p(text));
const head = (text: string) => schema.nodes.tableHeader.create(null, p(text));
const row = (...cells: PMNode[]) => schema.nodes.tableRow.create(null, cells);
// A table of 3 × 3 with a header row, after a paragraph (the table at 7).
const make = (headerRow = true) =>
  EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [
      p("Intro"),
      schema.nodes.table.create(null, [
        row(...["A", "B", "C"].map((t) => (headerRow ? head(t) : cell(t)))),
        row(cell("a1"), cell("b1"), cell("c1")),
        row(cell("a2"), cell("b2"), cell("c2")),
      ]),
      p("Ende"),
    ]),
  });
const TABLE = 7;
const apply = (state: EditorState, command: (s: EditorState, d?: (tr: Transaction) => void) => boolean) => {
  let next: EditorState | null = null;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  assert.equal(ok, true, "the command applies");
  return next! as EditorState;
};
// The table as text: rows of cells, a header cell marked with "*".
const grid = (state: EditorState) => {
  const table = state.doc.nodeAt(TABLE)!;
  const rows: string[] = [];
  table.forEach((r) => {
    const cells: string[] = [];
    r.forEach((c) => cells.push((c.type.name === "tableHeader" ? "*" : "") + c.textContent));
    rows.push(cells.join(" "));
  });
  return rows;
};

test("rows move by their index; the header row stays the first row", () => {
  let s = make();
  s = apply(s, commands.moveLine(TABLE, "row", 2, 1));
  assert.deepEqual(grid(s), ["*A *B *C", "a2 b2 c2", "a1 b1 c1"]);
  const lines = commands.selectedLines(s);
  assert.deepEqual(lines, { tablePos: TABLE, kind: "row", from: 1, to: 1 }, "the moved row stays selected");
  // The header row moved down: its texts go down, the first row stays the header.
  s = apply(s, commands.moveLine(TABLE, "row", 0, 2));
  assert.deepEqual(grid(s), ["*a2 *b2 *c2", "a1 b1 c1", "A B C"]);
  // Out of range or to itself: nothing.
  assert.equal(commands.moveLine(TABLE, "row", 1, 1)(s), false);
  assert.equal(commands.moveLine(TABLE, "row", 0, 3)(s), false);
  assert.equal(commands.moveLine(0, "row", 0, 1)(s), false, "not a table");
});

test("columns move cell by cell, widths and colours with them", () => {
  let s = make();
  s = apply(s, commands.setCellColor(TABLE, { left: 0, right: 1, top: 0, bottom: 3 }, "red-background"));
  s = apply(s, commands.moveLine(TABLE, "column", 0, 2));
  assert.deepEqual(grid(s), ["*B *C *A", "b1 c1 a1", "b2 c2 a2"]);
  const table = s.doc.nodeAt(TABLE)!;
  assert.equal(table.child(1).child(2).attrs.blockColor, "red-background");
  assert.equal(table.child(1).child(0).attrs.blockColor, null);
  assert.deepEqual(commands.selectedLines(s), { tablePos: TABLE, kind: "column", from: 2, to: 2 });
});

test("merged cells: rows across them and columns do not move", () => {
  const s = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [
      p("Intro"),
      schema.nodes.table.create(null, [row(cell("a", { rowspan: 2 }), cell("b")), row(cell("c")), row(cell("d"), cell("e"))]),
    ]),
  });
  assert.equal(commands.moveLine(TABLE, "row", 2, 0)(s), false);
  assert.equal(commands.moveLine(TABLE, "column", 1, 0)(s), false);
});

test("duplicating copies a row below and a column to the right; header cells stay in the header", () => {
  let s = make();
  s = apply(s, commands.duplicateLine(TABLE, "row", 1));
  assert.deepEqual(grid(s), ["*A *B *C", "a1 b1 c1", "a1 b1 c1", "a2 b2 c2"]);
  assert.deepEqual(commands.selectedLines(s), { tablePos: TABLE, kind: "row", from: 2, to: 2 }, "the copy is selected");
  s = apply(s, commands.duplicateLine(TABLE, "row", 0));
  assert.deepEqual(grid(s)[1], "A B C", "a copy of the header row is a normal row");
  s = make();
  s = apply(s, commands.duplicateLine(TABLE, "column", 1));
  assert.deepEqual(grid(s), ["*A *B *B *C", "a1 b1 b1 c1", "a2 b2 b2 c2"]);
});

test("insert, clear and delete rows and columns", () => {
  let s = make();
  s = apply(s, commands.insertLine(TABLE, "row", 1, "before"));
  assert.deepEqual(grid(s), ["*A *B *C", "  ", "a1 b1 c1", "a2 b2 c2"]);
  s = apply(s, commands.insertLine(TABLE, "column", 2, "after"));
  assert.deepEqual(grid(s)[2], "a1 b1 c1 ");
  s = apply(s, commands.appendLine(TABLE, "row"));
  assert.equal(grid(s).length, 5);
  s = apply(s, commands.appendLine(TABLE, "column"));
  assert.equal(grid(s)[0].split(" ").length, 5);
  s = make();
  s = apply(s, commands.clearCells(TABLE, { left: 0, right: 3, top: 1, bottom: 2 }));
  assert.deepEqual(grid(s), ["*A *B *C", "  ", "a2 b2 c2"]);
  s = apply(s, commands.deleteLine(TABLE, "row", 1));
  assert.deepEqual(grid(s), ["*A *B *C", "a2 b2 c2"]);
  s = apply(s, commands.deleteLine(TABLE, "column", 0));
  assert.deepEqual(grid(s), ["*B *C", "b2 c2"]);
  // Not the last row or column.
  s = apply(s, commands.deleteLine(TABLE, "column", 0));
  assert.equal(commands.deleteLine(TABLE, "column", 0)(s), false);
});

test("the header row and column on and off", () => {
  let s = make(false);
  assert.deepEqual(commands.tableHeaders(commands.tableAt(s.doc, TABLE)!), { row: false, column: false });
  s = apply(s, commands.toggleHeaderLine(TABLE, "row"));
  assert.deepEqual(grid(s)[0], "*A *B *C");
  s = apply(s, commands.toggleHeaderLine(TABLE, "column"));
  assert.deepEqual(grid(s), ["*A *B *C", "*a1 b1 c1", "*a2 b2 c2"]);
  assert.deepEqual(commands.tableHeaders(commands.tableAt(s.doc, TABLE)!), { row: true, column: true });
  s = apply(s, commands.toggleHeaderLine(TABLE, "row"));
  assert.deepEqual(grid(s), ["*A B C", "*a1 b1 c1", "*a2 b2 c2"]);
});

test("selecting a row or column; the whole table is neither", () => {
  let s = make();
  s = apply(s, commands.selectLine(TABLE, "row", 2));
  assert.ok(s.selection instanceof CellSelection);
  assert.deepEqual(commands.selectedLines(s), { tablePos: TABLE, kind: "row", from: 2, to: 2 });
  s = apply(s, commands.selectLine(TABLE, "column", 0));
  assert.deepEqual(commands.selectedLines(s), { tablePos: TABLE, kind: "column", from: 0, to: 0 });
  const table = commands.tableAt(s.doc, TABLE)!;
  const whole = s.apply(s.tr.setSelection(CellSelection.create(s.doc, table.start + table.map.map[0], table.start + table.map.map[8])));
  assert.equal(commands.selectedLines(whole), null);
  assert.equal(commands.selectLine(TABLE, "row", 3)(s), false);
});

test("cell colours: names only, shared or mixed", () => {
  let s = make();
  const rect = { left: 1, right: 3, top: 1, bottom: 2 };
  assert.equal(commands.cellColor(s, TABLE, rect), null);
  s = apply(s, commands.setCellColor(TABLE, rect, "blue"));
  assert.equal(commands.cellColor(s, TABLE, rect), "blue");
  assert.equal(commands.cellColor(s, TABLE, { left: 0, right: 3, top: 1, bottom: 2 }), undefined, "mixed");
  for (const bad of ["teal", "red;color:red", "#ff0000", "red-text"]) assert.equal(commands.setCellColor(TABLE, rect, bad)(s), false, bad);
  s = apply(s, commands.setCellColor(TABLE, rect, null));
  assert.equal(commands.cellColor(s, TABLE, rect), null);
});

test("cell colours survive storage, HTML cleaning and Markdown; anything else is dropped", () => {
  const html =
    "<table><tbody>" +
    '<tr><th data-block-color="gray-background"><p>Kopf</p></th><th><p>Zwei</p></th></tr>' +
    '<tr><td data-block-color="red"><p>rot</p></td><td data-block-color="javascript:alert(1)"><p>x</p></td></tr>' +
    '<tr><td><p>a</p></td><td data-block-color="green-background"><p>grün</p></td></tr>' +
    "</tbody></table>";
  const roundTrip = (input: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, htmlState(input));
    return stateHtml(doc);
  };
  const stored = roundTrip(html);
  assert.match(stored, /<th[^>]* data-block-color="gray-background"/);
  assert.match(stored, /<td[^>]* data-block-color="red"/);
  assert.match(stored, /<td[^>]* data-block-color="green-background"/);
  assert.doesNotMatch(stored, /javascript/);
  const cleaned = cleanHtml(html);
  assert.match(cleaned, /<td data-block-color="red">/);
  assert.doesNotMatch(cleaned, /javascript/);
  // Only a name passes the cleaning (an unknown value leaves the attribute empty).
  assert.doesNotMatch(cleanHtml('<td data-block-color="red;background:url(x)">x</td>'), /data-block-color="|url/);

  const markdown = htmlToMarkdown(stored, { url: (u: string) => u, linked: () => null });
  assert.match(markdown, /<!-- flowplan:cells 0\.0=gray-background 1\.0=red 2\.1=green-background -->\n\| Kopf \| Zwei \|/);
  const back = roundTrip(markdownToHtml(markdown));
  assert.match(back, /<th[^>]* data-block-color="gray-background"[^>]*><p>Kopf<\/p><\/th>/);
  assert.match(back, /<td[^>]* data-block-color="red"[^>]*><p>rot<\/p><\/td>/);
  assert.match(back, /<td[^>]* data-block-color="green-background"[^>]*><p>grün<\/p><\/td>/);
  assert.doesNotMatch(back, /flowplan:cells/);
  // Without a header row (the empty header Markdown needs is dropped again).
  const plain = roundTrip('<table><tbody><tr><td data-block-color="blue"><p>a</p></td><td><p>b</p></td></tr></tbody></table>');
  const plainBack = roundTrip(markdownToHtml(htmlToMarkdown(plain, { url: (u: string) => u, linked: () => null })));
  assert.match(plainBack, /<td[^>]* data-block-color="blue"[^>]*><p>a<\/p><\/td>/);
  // A hand-written marker with nonsense keeps only the valid names.
  const hand = roundTrip(markdownToHtml('<!-- flowplan:cells 0.0=red 0.1=teal -->\n| a | b |\n| --- | --- |\n| c | d |'));
  assert.match(hand, /<th[^>]* data-block-color="red"/);
  assert.doesNotMatch(hand, /teal/);
});
