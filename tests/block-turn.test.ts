// "Umwandeln in" of the block menu (#238): toggle headings, a toggle into
// other blocks (#244), block equations, columns and block colours – and
// how toggle headings and block colours go through storage and Markdown.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-turn-"));
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
const { toggleToBlock, blockToToggle, blockToMath, blocksToColumns, setBlockColors } = await import("../lib/block-turn");
const { blockColor } = await import("../lib/block-colors");
const { htmlState, stateHtml, cleanHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");

const schema = documentSchema();
const p = (text: string, attrs: Record<string, unknown> | null = null) => schema.nodes.paragraph.create(attrs, text ? schema.text(text) : undefined);
const toggle = (title: string, attrs: Record<string, unknown>, ...content: PMNode[]) =>
  schema.nodes.toggle.create({ title, ...attrs }, content.length ? content : [p("")]);
const docState = (...nodes: PMNode[]) => EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes) });
const types = (doc: PMNode) => doc.content.content.map((n) => n.type.name);
const roundTrip = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};

test("a toggle becomes text, a heading, a list, a quote, a callout or code: title first, content after it, one step (#244)", () => {
  const make = () => docState(p("Intro"), toggle("Titel", { blockId: "tog12345" }, p("Eins"), p("Zwei")), p("Ende"));
  const pos = 7;
  for (const [kind, first] of [
    [{ type: "paragraph" }, "paragraph"],
    [{ type: "heading", level: 2 }, "heading"],
    [{ type: "bulletList" }, "bulletList"],
    [{ type: "orderedList" }, "orderedList"],
    [{ type: "taskList" }, "taskList"],
    [{ type: "blockquote" }, "blockquote"],
    [{ type: "callout" }, "callout"],
    [{ type: "codeBlock" }, "codeBlock"],
  ] as const) {
    const s = make();
    const trn = s.tr;
    assert.equal(toggleToBlock(trn, pos, kind), true, first);
    assert.equal(trn.steps.length, 1, `${first}: one step`);
    assert.deepEqual(types(trn.doc), ["paragraph", first, "paragraph", "paragraph", "paragraph"], first);
    const made = trn.doc.child(1);
    assert.equal(made.textContent, "Titel", first);
    assert.equal(made.attrs.blockId, "tog12345", `${first}: links to the block keep working`);
    assert.deepEqual(trn.doc.content.content.slice(2).map((n) => n.textContent), ["Eins", "Zwei", "Ende"]);
    assert.equal(trn.doc.resolve(trn.selection.from).parent.textContent, "Titel", `${first}: the caret in the title`);
    if (first === "heading") assert.equal(made.attrs.level, 2);
  }
  // A fresh toggle (an empty paragraph inside) leaves only its title.
  const fresh = docState(toggle("Nur Titel", {}));
  const trn = fresh.tr;
  assert.equal(toggleToBlock(trn, 0, { type: "paragraph" }), true);
  assert.deepEqual(trn.doc.content.content.map((n) => n.textContent), ["Nur Titel"]);
  // Not a toggle: nothing.
  assert.equal(toggleToBlock(make().tr, 0, { type: "paragraph" }), false);
});

test("toggle headings: from a paragraph, a heading or a toggle, and back to a plain toggle", () => {
  const s = docState(p("Absatz"), schema.nodes.heading.create({ level: 3, blockId: "hea12345" }, schema.text("Kopf")), toggle("T", {}));
  let trn = s.tr;
  assert.equal(blockToToggle(trn, 0, 2), true);
  assert.equal(trn.doc.child(0).type.name, "toggle");
  assert.equal(trn.doc.child(0).attrs.heading, 2);
  assert.equal(trn.doc.child(0).attrs.title, "Absatz");
  trn = s.tr;
  assert.equal(blockToToggle(trn, 8, 3), true);
  const fromHeading = trn.doc.child(1);
  assert.equal(fromHeading.type.name, "toggle");
  assert.equal(fromHeading.attrs.title, "Kopf");
  assert.equal(fromHeading.attrs.heading, 3);
  assert.equal(fromHeading.attrs.blockId, "hea12345");
  trn = s.tr;
  const togglePos = s.doc.child(0).nodeSize + s.doc.child(1).nodeSize;
  assert.equal(blockToToggle(trn, togglePos, 4), true);
  assert.equal(trn.doc.child(2).attrs.heading, 4);
  assert.equal(blockToToggle(trn, togglePos, null), true);
  assert.equal(trn.doc.child(2).attrs.heading, null);
  // Out of range levels are plain toggles.
  trn = s.tr;
  assert.equal(blockToToggle(trn, togglePos, 6), true);
  assert.equal(trn.doc.child(2).attrs.heading, null);
});

test("toggle headings and block colours survive storage, HTML cleaning and Markdown", () => {
  const html =
    '<details data-heading="2"><summary>Kapitel</summary><div><p>Inhalt</p></div></details>' +
    '<p data-block-color="red">Rot</p><h3 data-block-color="blue-background">Blau</h3>' +
    '<ul><li data-block-color="green"><p>Grün</p></li><li><p>Normal</p></li></ul>' +
    '<blockquote data-block-color="purple"><p>Zitat</p></blockquote><p data-block-color="evil;color:red">Falsch</p>';
  const stored = roundTrip(html);
  assert.match(stored, /<details data-heading="2"/);
  assert.match(stored, /<p data-block-color="red">Rot<\/p>/);
  assert.match(stored, /<h3 data-block-color="blue-background">Blau<\/h3>/);
  assert.match(stored, /<li data-block-color="green">/);
  assert.match(stored, /<blockquote data-block-color="purple">/);
  assert.doesNotMatch(stored, /evil/);
  const cleaned = cleanHtml(html);
  assert.match(cleaned, /data-heading="2"/);
  assert.match(cleaned, /<p data-block-color="red">/);
  assert.doesNotMatch(cleaned, /evil/);

  const markdown = htmlToMarkdown(stored, { url: (u: string) => u, linked: () => null });
  assert.match(markdown, /<summary><h2>Kapitel<\/h2><\/summary>/);
  assert.match(markdown, /<!-- flowplan:color red -->\n\nRot/);
  assert.match(markdown, /<!-- flowplan:color blue-background -->\n\n### Blau/);
  assert.match(markdown, /- Grün <!-- flowplan:color green -->/);
  const back = roundTrip(markdownToHtml(markdown));
  assert.match(back, /<details data-heading="2"[^>]*><summary>Kapitel<\/summary>/);
  assert.match(back, /<p data-block-color="red">Rot<\/p>/);
  assert.match(back, /<h3 data-block-color="blue-background">Blau<\/h3>/);
  assert.match(back, /<li data-block-color="green"><p>Grün<\/p><\/li><li><p>Normal<\/p><\/li>/);
  assert.match(back, /<blockquote data-block-color="purple">/);
  // A task item's colour too.
  const task = roundTrip(markdownToHtml("- [ ] Aufgabe <!-- flowplan:color orange --> 📅 2026-05-04"));
  assert.match(task, /data-block-color="orange"/);
  assert.match(task, /Aufgabe/);
  assert.match(task, /data-due="2026-05-04"/);
  assert.doesNotMatch(task, /flowplan:color/);
  // A toggle heading written by hand (GitHub style).
  assert.match(roundTrip(markdownToHtml("<details>\n<summary><h3>Hand</h3></summary>\n\nText\n\n</details>")), /<details data-heading="3"[^>]*><summary>Hand<\/summary>/);
});

test("block colours: names only, lists through their items, default clears", () => {
  assert.equal(blockColor("red"), "red");
  assert.equal(blockColor("red-background"), "red-background");
  for (const bad of ["", "teal", "red-text", "red-background-x", "#ff0000", null, 3]) assert.equal(blockColor(bad), null);
  const list = schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, p("a")), schema.nodes.listItem.create(null, p("b"))]);
  const s = docState(p("Text"), list);
  const trn = s.tr;
  assert.equal(setBlockColors(trn, [0, 6], "yellow-background"), true);
  assert.equal(trn.doc.child(0).attrs.blockColor, "yellow-background");
  trn.doc.child(1).forEach((item) => assert.equal(item.attrs.blockColor, "yellow-background"));
  assert.equal(setBlockColors(trn, [0], null), true);
  assert.equal(trn.doc.child(0).attrs.blockColor, null);
  assert.equal(setBlockColors(trn, [0], "nope"), false);
});

test("block equations and columns", () => {
  const s = docState(p("a^2 + b^2"), p("Zwei"), p("Drei"));
  let trn = s.tr;
  assert.equal(blockToMath(trn, 0), true);
  assert.equal(trn.doc.child(0).type.name, "mathBlock");
  assert.equal(trn.doc.child(0).attrs.expression, "a^2 + b^2");
  // Three blocks into two columns: two left, one right.
  trn = s.tr;
  assert.equal(blocksToColumns(trn, 0, s.doc.content.size, 2), true);
  assert.deepEqual(types(trn.doc), ["columns"]);
  const columns = trn.doc.child(0);
  assert.deepEqual([columns.child(0).childCount, columns.child(1).childCount], [2, 1]);
  // One block into three columns: two empty columns beside it.
  trn = s.tr;
  assert.equal(blocksToColumns(trn, 0, s.doc.child(0).nodeSize, 3), true);
  assert.equal(trn.doc.child(0).childCount, 3);
  assert.equal(trn.doc.child(0).child(2).textContent, "");
  // More than the columns the editor allows: refused.
  assert.equal(blocksToColumns(s.tr, 0, s.doc.content.size, 4), false);
});
