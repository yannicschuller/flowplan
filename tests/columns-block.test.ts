// The columns block (lib/columns-block.ts): schema and stored HTML with the
// columns' widths, the sanitizer, the layout kept valid after changes (no
// nesting, at least two columns, a paragraph in every column), removing an
// empty column, resizing, the exports, the search text, and two editors
// changing one layout at the same time (Yjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-columns-block-"));
process.env.APP_URL = "https://flowplan.example.test";
const { EditorState, TextSelection } = await import("@tiptap/pm/state");
type Transaction = import("@tiptap/pm/state").Transaction;
const { updateYFragment, yXmlFragmentToProseMirrorRootNode } = await import("y-prosemirror");
const { documentSchema } = await import("../lib/document-schema");
const { applyDocumentUpdate, cleanHtml, htmlJson, jsonHtml, htmlState, stateHtml } = await import("../lib/document-server");
const { columnShares, columnWidth, hasNestedColumns, removeEmptyColumn, resizedWidths, setColumnWidths, tidyColumns } = await import("../lib/columns-block");
const { columnBlocks, documentBlocks } = await import("../lib/document-blocks");
const { blocksToColumns } = await import("../lib/block-turn");
const { htmlToMarkdown } = await import("../lib/markdown");
const { documentText } = await import("../lib/search-index");
const { documentXhtml } = await import("../lib/export-xhtml");
const { documentJira } = await import("../lib/export-jira");
const { documentConfluence } = await import("../lib/export-confluence");
const { buildDocx } = await import("../lib/export-docx");
const { readExportZip } = await import("./helpers/read-export-zip");
const { assertWellFormedXml } = await import("./helpers/xml-check");

type PMNode = ReturnType<typeof schema.nodeFromJSON>;
const schema = documentSchema();
const node = (html: string) => schema.nodeFromJSON(htmlJson(cleanHtml(html)));
const stateOf = (html: string) => EditorState.create({ schema, doc: node(html) });
const col = (inner: string, width?: number) => `<div data-column="true"${width ? ` data-width="${width}"` : ""}>${inner}</div>`;
const cols = (...columns: string[]) => `<div data-columns="true">${columns.join("")}</div>`;
// The document as nested names and texts.
const shape = (doc: PMNode): unknown =>
  doc.content.content.map(function map(n: PMNode): unknown {
    if (n.isTextblock) return n.textContent;
    const children: unknown[] = [];
    n.forEach((c) => children.push(map(c)));
    return { [n.type.name]: children };
  });
const textPos = (doc: PMNode, text: string) => {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isTextblock && n.textContent === text) at = pos + 1;
  });
  return at;
};

test("schema: columns hold two or three columns, widths survive storage and HTML cleaning", () => {
  const html = `<div data-columns="true" data-block-id="cols1234">${col("<p>A</p>", 30)}${col("<h2>B</h2><p>b</p>", 70)}</div>`;
  const doc = node(html);
  const layout = doc.firstChild!;
  assert.equal(layout.type.name, "columns");
  assert.equal(layout.attrs.blockId, "cols1234");
  assert.deepEqual([layout.child(0).attrs.width, layout.child(1).attrs.width], [30, 70]);
  const out = jsonHtml(doc.toJSON());
  assert.match(out, /<div data-block-id="cols1234" data-columns="true" class="editor-columns"><div data-width="30" data-column="true" class="editor-column"><p>A<\/p><\/div><div data-width="70" data-column="true" class="editor-column">/);
  // Stored as Yjs and back: the same.
  const stored = stateHtml((() => {
    const d = new Y.Doc();
    Y.applyUpdate(d, htmlState(html));
    return d;
  })());
  assert.equal(stored, cleanHtml(out));
  // Only whole percentages within the limits; equal shares without.
  assert.equal(columnWidth("19"), null);
  assert.equal(columnWidth("81"), null);
  assert.equal(columnWidth("abc"), null);
  assert.equal(columnWidth(null), null);
  assert.equal(columnWidth("45"), 45);
  assert.doesNotMatch(cleanHtml(cols(col("<p>A</p>", 5), col("<p>B</p>"))), /data-width="/);
  assert.doesNotMatch(cleanHtml('<div data-columns="true"><div data-column="true" data-width="50" style="width: 900px"><p>A</p></div></div>'), /style/);
  assert.deepEqual(columnShares(node(cols(col("<p>A</p>"), col("<p>B</p>"), col("<p>C</p>"))).firstChild!).map(Math.round), [33, 33, 33]);
  // A width beside a column without one: the stylesheet's equal share.
  assert.deepEqual(columnShares(node(cols(col("<p>A</p>", 25), col("<p>B</p>"))).firstChild!).map(Math.round), [33, 67]);
});

test("resizing: only the columns at the gap change, within 20–80 %, summing to 100", () => {
  assert.deepEqual(resizedWidths([50, 50], 0, 30), [30, 70]);
  assert.deepEqual(resizedWidths([50, 50], 0, 5), [20, 80]);
  assert.deepEqual(resizedWidths([50, 50], 0, 95), [80, 20]);
  // Three equal columns: the one away from the gap keeps its third.
  assert.deepEqual(resizedWidths([100 / 3, 100 / 3, 100 / 3], 1, 20), [34, 20, 46]);
  assert.deepEqual(resizedWidths([100 / 3, 100 / 3, 100 / 3], 0, 40.4), [40, 27, 33]);
  // Not past the neighbour's minimum.
  assert.deepEqual(resizedWidths([100 / 3, 100 / 3, 100 / 3], 0, 70), [47, 20, 33]);
  // Set on the layout, and back to equal widths.
  let s = stateOf(cols(col("<p>A</p>"), col("<p>B</p>")));
  s = s.apply(setColumnWidths(s.tr, 0, [35, 65]));
  assert.match(jsonHtml(s.doc.toJSON()), /data-width="35"[^]*data-width="65"/);
  s = s.apply(setColumnWidths(s.tr, 0, null));
  assert.doesNotMatch(jsonHtml(s.doc.toJSON()), /data-width/);
});

test("the layout stays valid: no columns in columns, at least two columns, a paragraph in every column", () => {
  // Nested columns become their blocks one after another.
  const nested = stateOf(cols(col(`<p>A</p>${cols(col("<p>x</p>"), col("<p>y</p>"))}`), col("<p>B</p>")));
  assert.equal(hasNestedColumns(nested.doc), true);
  const flat = nested.apply(tidyColumns(nested)!);
  assert.deepEqual(shape(flat.doc), [{ columns: [{ column: ["A", "x", "y"] }, { column: ["B"] }] }]);
  assert.equal(hasNestedColumns(flat.doc), false);
  // Also in a callout inside a column.
  const deep = stateOf(cols(col(`<aside data-callout="note">${cols(col("<p>x</p>"), col("<p>y</p>"))}</aside>`), col("<p>B</p>")));
  // (and the column, holding only the callout now, gets its paragraph).
  assert.deepEqual(shape(deep.apply(tidyColumns(deep)!).doc), [{ columns: [{ column: [{ callout: ["x", "y"] }, ""] }, { column: ["B"] }] }]);
  // A layout with one column left (as Yjs can leave it) dissolves.
  const one = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [schema.nodes.columns.create(null, [schema.nodes.column.create(null, [schema.nodes.paragraph.create(null, schema.text("Only"))])])]),
  });
  assert.deepEqual(shape(one.apply(tidyColumns(one)!).doc), ["Only"]);
  // A column with only a PDF gets a line to write in below it.
  const pdf = '<div data-pdf="/api/files/00000000-0000-4000-8000-000000000001" data-title="a.pdf"><a href="/api/files/00000000-0000-4000-8000-000000000001">a.pdf</a></div>';
  const files = stateOf(cols(col(pdf), col("<p>B</p>")));
  const tidied = files.apply(tidyColumns(files)!).doc.firstChild!;
  assert.deepEqual(
    [tidied.child(0).childCount, tidied.child(0).child(0).attrs.kind, tidied.child(0).child(1).type.name],
    [2, "pdf", "paragraph"],
  );
  // A valid layout is left alone.
  assert.equal(tidyColumns(stateOf(cols(col("<p>A</p>"), col("<p>B</p>")))), null);
});

test("the tidying plugin fixes this person's changes, not other people's", async () => {
  const { columnsTidyPlugin } = await import("../lib/columns-block");
  const { ySyncPluginKey } = await import("@tiptap/y-tiptap");
  const s = EditorState.create({ schema, doc: node(cols(col("<p>A</p>"), col("<p>B</p>"))), plugins: [columnsTidyPlugin()] });
  const inner = node(cols(col("<p>x</p>"), col("<p>y</p>"))).firstChild!;
  const at = textPos(s.doc, "A") + 1;
  // Pasted into a column: flattened right away.
  const own = s.applyTransaction(s.tr.insert(at, inner)).state;
  assert.equal(hasNestedColumns(own.doc), false);
  assert.deepEqual(shape(own.doc), [{ columns: [{ column: ["A", "x", "y"] }, { column: ["B"] }] }]);
  // The same change from someone else (Yjs) stays as it came.
  const remote = s.applyTransaction(s.tr.insert(at, inner).setMeta(ySyncPluginKey, { isChangeOrigin: true })).state;
  assert.equal(hasNestedColumns(remote.doc), true);
});

test("Backspace in an empty column removes it; with one column left the blocks flow back", () => {
  const at = (s: InstanceType<typeof EditorState>, pos: number) => s.apply(s.tr.setSelection(TextSelection.create(s.doc, pos)));
  const press = (s: InstanceType<typeof EditorState>) => {
    let next = s;
    const done = removeEmptyColumn(s, (tr) => (next = s.apply(tr)));
    return { done, state: next };
  };
  // Two columns, the right one emptied: the left one's blocks flow back.
  const two = stateOf(`<p>Vor</p>${cols(col("<p>A</p><p>A2</p>"), col("<p></p>"))}<p>Nach</p>`);
  let emptyAt = -1;
  two.doc.descendants((n, pos) => {
    if (n.type.name === "paragraph" && !n.content.size && emptyAt < 0) emptyAt = pos + 1;
  });
  const merged = press(at(two, emptyAt));
  assert.equal(merged.done, true);
  assert.deepEqual(shape(merged.state.doc), ["Vor", "A", "A2", "Nach"]);
  assert.equal(merged.state.selection.$from.parent.textContent, "A2");
  // Three columns: the middle one goes, the others stay with their widths.
  const three = stateOf(cols(col("<p>A</p>", 25), col("<p></p>", 25), col("<p>C</p>", 50)));
  let middle = -1;
  three.doc.descendants((n, pos) => {
    if (n.type.name === "paragraph" && !n.content.size && middle < 0) middle = pos + 1;
  });
  const removed = press(at(three, middle));
  assert.deepEqual(shape(removed.state.doc), [{ columns: [{ column: ["A"] }, { column: ["C"] }] }]);
  assert.deepEqual(columnShares(removed.state.doc.firstChild!).map(Math.round), [33, 67]);
  // Not in a column with text, nor outside columns.
  assert.equal(press(at(three, textPos(three.doc, "A"))).done, false);
  assert.equal(press(at(stateOf("<p></p>"), 1)).done, false);
});

test("columns are never nested by dropping beside a block or turning blocks into columns", () => {
  const s = stateOf(`${cols(col('<aside data-callout="note"><p>In</p></aside>'), col("<p>B</p>"))}<p>C</p>`);
  const find = (text: string) => documentBlocks(s.doc).find((b) => b.node.type.name === "paragraph" && b.node.textContent === text)!.pos;
  assert.throws(() => columnBlocks(s, [find("C")], find("In"), "right"), /verschachteln/);
  // A layout itself does not go into a column.
  const layout = documentBlocks(s.doc).find((b) => b.node.type.name === "columns")!;
  const withOther = stateOf(`${cols(col("<p>A</p>"), col("<p>B</p>"))}<p>C</p>`);
  const otherLayout = documentBlocks(withOther.doc).find((b) => b.node.type.name === "columns")!;
  const c = documentBlocks(withOther.doc).find((b) => b.node.textContent === "C")!;
  assert.throws(() => columnBlocks(withOther, [otherLayout.pos], c.pos, "right"), /verschachteln/);
  assert.ok(layout);
  // Turning blocks that hold columns into columns is not offered.
  assert.equal(blocksToColumns(withOther.tr, 0, withOther.doc.content.size, 2), false);
  // A new column in a resized layout: equal widths again.
  const resized = stateOf(`${cols(col("<p>A</p>", 30), col("<p>B</p>", 70))}<p>C</p>`);
  const target = documentBlocks(resized.doc).find((b) => b.node.textContent === "B" && b.node.type.name === "paragraph")!;
  const cBlock = documentBlocks(resized.doc).find((b) => b.node.textContent === "C")!;
  const added = resized.apply(columnBlocks(resized, [cBlock.pos], target.pos, "right"));
  assert.deepEqual(shape(added.doc), [{ columns: [{ column: ["A"] }, { column: ["B"] }, { column: ["C"] }] }]);
  assert.doesNotMatch(jsonHtml(added.doc.toJSON()), /data-width/);
});

const SAMPLE = `<p>Vor</p>${cols(col("<h3>Links</h3><p>Erster <strong>Text</strong></p>", 40), col("<ul><li><p>Punkt</p></li></ul>", 60))}<p>Nach</p>`;

test("search finds the text in every column, word by word", () => {
  const text = documentText(SAMPLE);
  for (const word of ["Vor", "Links", "Erster", "Text", "Punkt", "Nach"]) assert.match(text, new RegExp(`\\b${word}\\b`));
  assert.doesNotMatch(text, /TextPunkt|LinksErster/);
});

test("exports: Markdown one column after another, PDF side by side with the widths, Word as a table without borders", async () => {
  const md = htmlToMarkdown(SAMPLE, { url: (u: string) => u, linked: () => null });
  assert.match(md, /Vor\n\n\*\*Spalte 1\*\*\n\n### Links\n\nErster \*\*Text\*\*\n\n\*\*Spalte 2\*\*\n\n- Punkt\n\nNach/);
  const xhtml = documentXhtml(SAMPLE, { url: (u) => u, image: () => null });
  assert.match(xhtml, /<div class="columns"><div class="column" data-width="40"><h3>Links<\/h3>[^]*<\/div><div class="column" data-width="60"><ul>/);
  // Equal columns carry no widths.
  assert.match(documentXhtml(cols(col("<p>A</p>"), col("<p>B</p>")), { url: (u) => u, image: () => null }), /<div class="columns"><div class="column"><p>A<\/p><\/div><div class="column"><p>B<\/p><\/div><\/div>/);
  assert.match(documentJira(SAMPLE, { url: (u) => u, image: () => null }), /Vor\n\nh3\. Links\n\nErster \*Text\*\n\n\* Punkt\n\nNach/);
  assert.match(documentConfluence(SAMPLE, { url: (u) => u, image: () => null }), /<p>Vor<\/p><h3>Links<\/h3><p>Erster <strong>Text<\/strong><\/p><ul><li>[^]*Punkt[^]*<p>Nach<\/p>/);
  const bytes = await buildDocx({ title: "T", sections: [{ title: "T", html: SAMPLE }], file: () => null, url: (raw) => raw });
  const word = (await readExportZip(bytes)).get("word/document.xml")!.toString("utf8");
  assertWellFormedXml(word, "document.xml");
  const table = /<w:tbl><w:tblPr><w:tblW w:w="9072" w:type="dxa"\/><w:tblBorders>[^]*?<\/w:tbl>/.exec(word)?.[0] ?? "";
  assert.match(table, /<w:top w:val="nil"\/>/);
  assert.match(table, /<w:gridCol w:w="3628"\/><w:gridCol w:w="5443"\/>/);
  assert.match(table, /<w:tc><w:tcPr><w:tcW w:w="3628" w:type="dxa"\/><\/w:tcPr><w:p>[^]*Links[^]*Erster[^]*<\/w:tc><w:tc><w:tcPr><w:tcW w:w="5443" w:type="dxa"\/><\/w:tcPr>[^]*Punkt[^]*<\/w:tc><\/w:tr><\/w:tbl>/);
  assert.match(word, /Vor[^]*<w:tbl>[^]*Nach/);
  // A table in a column still ends its cell with a paragraph.
  const inner = await buildDocx({ title: "T", sections: [{ title: "T", html: cols(col("<table><tr><td><p>x</p></td></tr></table>"), col("<p>y</p>")) }], file: () => null, url: (raw) => raw });
  const innerWord = (await readExportZip(inner)).get("word/document.xml")!.toString("utf8");
  assertWellFormedXml(innerWord, "document.xml");
  assert.doesNotMatch(innerWord, /<\/w:tbl><\/w:tc>/);
});

/* ---------- Two editors on one layout (Yjs) ---------- */

// An editor bound to its own copy of the stored page, the way the sync
// plugin writes every change (updateYFragment); its updates for the others.
function editor(base: Uint8Array, client: number) {
  const ydoc = new Y.Doc();
  ydoc.clientID = client;
  Y.applyUpdate(ydoc, base);
  const type = ydoc.getXmlFragment("default");
  const meta = { mapping: new Map(), isOMark: new Map() } as unknown as Parameters<typeof updateYFragment>[3];
  let state = EditorState.create({ schema, doc: yXmlFragmentToProseMirrorRootNode(type, schema) });
  const updates: Uint8Array[] = [];
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") updates.push(update);
  });
  return {
    updates,
    get state() {
      return state;
    },
    change(make: (s: InstanceType<typeof EditorState>) => Transaction) {
      state = state.apply(make(state));
      ydoc.transact(() => updateYFragment(ydoc, type, state.doc, meta));
    },
    receive(others: Uint8Array[]) {
      for (const update of others) Y.applyUpdate(ydoc, update, "remote");
      state = EditorState.create({ schema, doc: yXmlFragmentToProseMirrorRootNode(type, schema) });
    },
    html: () => stateHtml(ydoc),
  };
}
const server = (base: Uint8Array, updates: Uint8Array[]) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  for (const update of updates) applyDocumentUpdate(doc, update);
  return stateHtml(doc);
};

test("Yjs: two editors writing in different columns both keep their text", () => {
  const base = htmlState(`<p>Vor</p>${cols(col("<p>Links</p>"), col("<p>Rechts</p>"))}`);
  const a = editor(base, 101),
    b = editor(base, 202);
  a.change((s) => s.tr.insertText(" von A", textPos(s.doc, "Links") + "Links".length));
  b.change((s) => s.tr.insertText(" von B", textPos(s.doc, "Rechts") + "Rechts".length));
  b.change((s) => s.tr.insert(textPos(s.doc, "Rechts von B") + "Rechts von B".length + 1, schema.nodes.paragraph.create(null, schema.text("Neu"))));
  const html = server(base, [...a.updates, ...b.updates]);
  assert.equal(server(base, [...b.updates, ...a.updates]), html);
  a.receive(b.updates);
  b.receive(a.updates);
  assert.equal(a.html(), html);
  assert.equal(b.html(), html);
  assert.deepEqual(shape(node(html)), ["Vor", { columns: [{ column: ["Links von A"] }, { column: ["Rechts von B", "Neu"] }] }]);
});

test("Yjs: one editor resizes while the other types – both changes stay, in any order", () => {
  const base = htmlState(cols(col("<p>Links</p>"), col("<p>Rechts</p>")));
  const a = editor(base, 303),
    b = editor(base, 404);
  a.change((s) => setColumnWidths(s.tr, 0, [30, 70]));
  b.change((s) => s.tr.insertText("Text ", textPos(s.doc, "Links")));
  b.change((s) => s.tr.insertText("!", textPos(s.doc, "Rechts") + "Rechts".length));
  const html = server(base, [...a.updates, ...b.updates]);
  assert.equal(server(base, [...b.updates, ...a.updates]), html);
  assert.match(html, /<div data-width="30" data-column="true" class="editor-column"><p>Text Links<\/p><\/div><div data-width="70" data-column="true" class="editor-column"><p>Rechts!<\/p><\/div>/);
  // Resized again while a third column comes in: the new one shares equally.
  const base2 = htmlState(cols(col("<p>A</p>"), col("<p>B</p>")));
  const c = editor(base2, 505),
    d = editor(base2, 606);
  c.change((s) => setColumnWidths(s.tr, 0, [25, 75]));
  d.change((s) => s.tr.insert(s.doc.firstChild!.nodeSize - 1, schema.nodes.column.create(null, schema.nodes.paragraph.create(null, schema.text("C")))));
  const both = server(base2, [...c.updates, ...d.updates]);
  assert.equal(server(base2, [...d.updates, ...c.updates]), both);
  const layout = node(both).firstChild!;
  assert.equal(layout.childCount, 3);
  assert.deepEqual([layout.child(0).attrs.width, layout.child(1).attrs.width, layout.child(2).attrs.width], [25, 75, null]);
});
