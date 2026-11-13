// Tab / Shift+Tab nest blocks into toggles and take them out again (#246):
// blocks after a toggle, a toggle's own title (also into a list item), list
// items at a toggle's edges, one undo step each, the visual indent where
// there is nothing to nest into, block selections, and Markdown of nested
// toggles.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { DOMParser as PMParser, type Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-toggle-nesting-"));
process.env.APP_URL = "https://flowplan.example.test";

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser", "KeyboardEvent"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
if (!("requestAnimationFrame" in g)) g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
after(async () => {
  await win.happyDOM.close();
});

const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { nestSelection, nestBlocks, nestToggle } = await import("../lib/toggle-nesting");
const { toggleBlocksPlugin, toggleKey, isToggleClosed } = await import("../lib/toggle-view");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");

const schema = documentSchema();
const p = (text: string, attrs: Record<string, unknown> | null = null) => schema.nodes.paragraph.create(attrs, text ? schema.text(text) : undefined);
const toggle = (title: string, ...content: PMNode[]) => schema.nodes.toggle.create({ title, blockId: null }, content.length ? content : [p("")]);
const list = (name: "bulletList" | "orderedList", ...texts: string[]) =>
  schema.nodes[name].create(null, texts.map((t) => schema.nodes.listItem.create(null, p(t))));

// The document as a compact outline: toggles as T(title)[…], lists as
// UL[…]/OL[…], items as li(…), paragraphs as their text.
function outline(node: PMNode): string {
  const kids = () => node.content.content.map(outline).join(", ");
  switch (node.type.name) {
    case "doc":
      return kids();
    case "toggle":
      return `T(${node.attrs.title})[${kids()}]`;
    case "bulletList":
      return `UL[${kids()}]`;
    case "orderedList":
      return `OL[${kids()}]`;
    case "listItem":
      return `li(${kids()})`;
    case "blockquote":
      return `Q[${kids()}]`;
    case "codeBlock":
      return `code(${node.textContent})`;
    default:
      return node.attrs.indent ? `${node.textContent}>${node.attrs.indent}` : node.textContent;
  }
}
// The position just inside the text `text` (+ offset).
function at(doc: PMNode, text: string, offset = 0) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text) + offset;
    return true;
  });
  assert.ok(found >= 0, `text ${text}`);
  return found;
}
// The position of the toggle titled `title`.
function toggleAt(doc: PMNode, title: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.type.name === "toggle" && node.attrs.title === title) found = pos;
    return true;
  });
  assert.ok(found >= 0, `toggle ${title}`);
  return found;
}
const stateOf = (nodes: PMNode[], caret?: string, offset = 0) => {
  const doc = schema.nodes.doc.create(null, nodes);
  const state = EditorState.create({ schema, doc, plugins: [history(), toggleBlocksPlugin()] });
  return caret === undefined ? state : state.apply(state.tr.setSelection(TextSelection.create(doc, at(doc, caret, offset))));
};
const press = (state: EditorState, out = false) => {
  const trn = nestSelection(state, out);
  return trn ? state.apply(trn) : null;
};

test("Tab on a paragraph right after a toggle moves it in as its last block; the caret stays in its text", () => {
  const s0 = stateOf([toggle("A", p("inside")), p("next"), p("later")], "next", 2);
  const s1 = press(s0)!;
  assert.ok(s1);
  assert.equal(outline(s1.doc), "T(A)[inside, next], later");
  assert.equal(s1.selection.from, at(s1.doc, "next", 2), "the caret in the same place of the moved text");
  // One undo step brings it back.
  let back: EditorState | null = null;
  undo(s1, (trn) => (back = s1.apply(trn)));
  assert.equal(outline(back!.doc), "T(A)[inside], next, later");
});

test("Tab on headings, quotes and toggles after a toggle nests them too; on a later child it nests further", () => {
  const heading = schema.nodes.heading.create({ level: 2 }, schema.text("Titel"));
  const s1 = press(stateOf([toggle("A"), heading], "Titel"))!;
  assert.equal(s1.doc.firstChild!.lastChild!.type.name, "heading");
  const quote = schema.nodes.blockquote.create(null, [p("zitat"), p("zwei")]);
  const s2 = press(stateOf([toggle("A"), quote], "zitat"))!;
  assert.equal(outline(s2.doc), "T(A)[, Q[zitat, zwei]]", "the first line of a quote moves the quote");
  // Inside a toggle: the block after an inner toggle goes into that one.
  const s3 = press(stateOf([toggle("A", p("a"), toggle("B", p("b")), p("c"))], "c"))!;
  assert.equal(outline(s3.doc), "T(A)[a, T(B)[b, c]]");
});

test("Tab into a closed toggle opens it (the caret goes into it)", () => {
  const s0 = stateOf([toggle("A", p("inside")), p("next")]);
  const closed = s0.apply(s0.tr.setMeta(toggleKey, { toggle: 0 }));
  assert.ok(isToggleClosed(closed, 0));
  const withCaret = closed.apply(closed.tr.setSelection(TextSelection.create(closed.doc, at(closed.doc, "next"))));
  const s1 = press(withCaret)!;
  assert.equal(outline(s1.doc), "T(A)[inside, next]");
  assert.equal(isToggleClosed(s1, 0), false);
});

test("Shift+Tab on a toggle's block moves it out to right after the toggle; later blocks stay inside", () => {
  const s0 = stateOf([toggle("A", p("a"), p("b"), p("c")), p("after")], "b", 1);
  const s1 = press(s0, true)!;
  assert.equal(outline(s1.doc), "T(A)[a, c], b, after");
  assert.equal(s1.selection.from, at(s1.doc, "b", 1));
  let back: EditorState | null = null;
  undo(s1, (trn) => (back = s1.apply(trn)));
  assert.equal(outline(back!.doc), "T(A)[a, b, c], after");
  // The only block: the toggle keeps an empty paragraph.
  const s2 = press(stateOf([toggle("A", p("only"))], "only"), true)!;
  assert.equal(outline(s2.doc), "T(A)[], only");
  // Tab and Shift+Tab are each other's undoing.
  const s3 = press(press(stateOf([toggle("A", p("x")), p("y")], "y"))!, true)!;
  assert.equal(outline(s3.doc), "T(A)[x], y");
});

test("nothing to nest into: Tab keeps the visual indent, Shift+Tab takes an indent back before lifting", () => {
  // No toggle before: no transaction, the Indent extension indents.
  assert.equal(nestSelection(stateOf([p("a"), p("b")], "b"), false), null);
  assert.equal(nestSelection(stateOf([toggle("A"), p("x"), p("b")], "b"), false), null);
  // Shift+Tab on an indented paragraph in a toggle: the indent goes first.
  assert.equal(nestSelection(stateOf([toggle("A", p("ind", { indent: 1 }))], "ind"), true), null);
  // At the top level nothing to lift out of.
  assert.equal(nestSelection(stateOf([p("a")], "a"), true), null);
  // An indented block keeps its indent when it moves in (Tab moves one step).
  const s1 = press(stateOf([toggle("A"), p("ind", { indent: 1 })], "ind"))!;
  assert.equal(outline(s1.doc), "T(A)[, ind>1]");
});

test("code blocks and tables keep their own Tab in the text; a block selection nests them", () => {
  const code = schema.nodes.codeBlock.create(null, schema.text("x = 1"));
  const s0 = stateOf([toggle("A"), code], "x = 1");
  assert.equal(nestSelection(s0, false), null);
  const pos = s0.doc.firstChild!.nodeSize;
  const nested = nestBlocks(s0, pos, pos + code.nodeSize, false)!;
  assert.ok(nested);
  assert.equal(outline(nested.tr.doc), "T(A)[, code(x = 1)]");
  assert.deepEqual(nested.into, [0]);
  assert.equal(nested.tr.doc.nodeAt(nested.positions[0])!.type.name, "codeBlock");
  // And out again.
  const s1 = s0.apply(nested.tr);
  const lifted = nestBlocks(s1, nested.positions[0], nested.positions[0] + code.nodeSize, true)!;
  assert.equal(outline(lifted.tr.doc), "T(A)[], code(x = 1)");
  // Several chosen blocks at once.
  const s2 = stateOf([toggle("A"), p("one"), p("two"), p("three")]);
  const from = s2.doc.firstChild!.nodeSize;
  const nested2 = nestBlocks(s2, from, from + p("one").nodeSize + p("two").nodeSize, false)!;
  assert.equal(outline(nested2.tr.doc), "T(A)[, one, two], three");
  assert.equal(nested2.positions.length, 2);
});

test("a selection across neighbouring blocks after a toggle moves them all in", () => {
  const doc = schema.nodes.doc.create(null, [toggle("A"), p("one"), p("two"), p("three")]);
  const base = EditorState.create({ schema, doc, plugins: [history()] });
  const s0 = base.apply(base.tr.setSelection(TextSelection.create(doc, at(doc, "one", 1), at(doc, "two", 2))));
  const s1 = press(s0)!;
  assert.equal(outline(s1.doc), "T(A)[, one, two], three");
  assert.equal(s1.doc.textBetween(s1.selection.from, s1.selection.to), "netw");
});

test("list items: lists keep their own Tab; the first items of a list after a toggle go into it, and come out again", () => {
  // Sinking within the list stays the list's (no transaction here).
  assert.equal(nestSelection(stateOf([toggle("A"), list("bulletList", "a", "b")], "b"), false), null);
  // The first item after a toggle: into it, as a list of its own.
  const s1 = press(stateOf([toggle("A", p("x")), list("bulletList", "a", "b")], "a"))!;
  assert.equal(outline(s1.doc), "T(A)[x, UL[li(a)]], UL[li(b)]");
  assert.equal(s1.selection.from, at(s1.doc, "a"));
  // Joined with a list of the same kind at the toggle's end.
  const s2 = press(stateOf([toggle("A", list("bulletList", "x")), list("bulletList", "a")], "a"))!;
  assert.equal(outline(s2.doc), "T(A)[UL[li(x), li(a)]]");
  // Inside the toggle a list nests as usual (sink: the list's own Tab).
  assert.equal(nestSelection(stateOf([toggle("A", list("bulletList", "x", "y"))], "y"), false), null);
  // Shift+Tab on a top-level item of a list in a toggle: out, after the toggle.
  const s3 = press(stateOf([toggle("A", list("bulletList", "x", "y", "z"))], "y"), true)!;
  assert.equal(outline(s3.doc), "T(A)[UL[li(x)], UL[li(z)]], UL[li(y)]");
  // A nested item lifts within its list (the list's own Shift+Tab).
  const nestedItem = schema.nodes.bulletList.create(null, [
    schema.nodes.listItem.create(null, [p("x"), list("bulletList", "deep")]),
  ]);
  assert.equal(nestSelection(stateOf([toggle("A", nestedItem)], "deep"), true), null);
  // A paragraph in a toggle inside a list item nests and lifts as anywhere.
  const inItem = schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, [p("item"), toggle("B", p("b1")), p("b2")])]);
  const s4 = press(stateOf([inItem], "b2"))!;
  assert.equal(outline(s4.doc), "UL[li(item, T(B)[b1, b2])]");
  const s5 = press(s4, true)!;
  assert.equal(outline(s5.doc), "UL[li(item, T(B)[b1], b2)]");
});

test("Tab in a toggle's title: into the toggle or the list item before it; Shift+Tab out again", () => {
  const s0 = stateOf([toggle("A", p("a")), toggle("B", p("b")), p("end")]);
  const made = nestToggle(s0, toggleAt(s0.doc, "B"), false)!;
  assert.ok(made);
  const s1 = s0.apply(made.tr);
  assert.equal(outline(s1.doc), "T(A)[a, T(B)[b]], end");
  assert.equal(made.positions[0], toggleAt(s1.doc, "B"), "the moved toggle's position, for its title's focus");
  assert.deepEqual(made.into, [0]);
  let back: EditorState | null = null;
  undo(s1, (trn) => (back = s1.apply(trn)));
  assert.equal(outline(back!.doc), "T(A)[a], T(B)[b], end", "one undo step");
  const out = nestToggle(s1, toggleAt(s1.doc, "B"), true)!;
  assert.equal(outline(out.tr.doc), "T(A)[a], T(B)[b], end");
  // Nothing before it: nothing happens (no visual indent for toggles).
  assert.equal(nestToggle(s0, 0, false), null);
  assert.equal(nestToggle(s0, 0, true), null);
  // Into the last item of a list before it, and out of the item again
  // (its list split around it).
  const s2 = stateOf([list("bulletList", "a", "b"), toggle("C", p("c"))]);
  const intoItem = nestToggle(s2, toggleAt(s2.doc, "C"), false)!;
  const s3 = s2.apply(intoItem.tr);
  assert.equal(outline(s3.doc), "UL[li(a), li(b, T(C)[c])]");
  const outOfItem = nestToggle(s3, toggleAt(s3.doc, "C"), true)!;
  assert.equal(outline(outOfItem.tr.doc), "UL[li(a), li(b)], T(C)[c]");
  // From an item in the middle: the list is split.
  const s4 = stateOf([
    schema.nodes.bulletList.create(null, [
      schema.nodes.listItem.create(null, [p("a"), toggle("D")]),
      schema.nodes.listItem.create(null, [p("b")]),
    ]),
  ]);
  const split = nestToggle(s4, toggleAt(s4.doc, "D"), true)!;
  assert.equal(outline(split.tr.doc), "UL[li(a)], T(D)[], UL[li(b)]");
});

// An editor as in the app, keys through its keymap.
async function editorWith(html: string) {
  const { Editor } = await import("@tiptap/core");
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  return new Editor({ element: element as unknown as HTMLElement, extensions: documentExtensions, content: html });
}
// A key as the browser sends it (keyboardShortcut() would keep only the
// steps of the change, not where the caret went).
const key = (editor: { view: import("@tiptap/pm/view").EditorView }, shift = false) =>
  editor.view.someProp("handleKeyDown", (f) => f(editor.view, new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: shift }) as unknown as KeyboardEvent));

test("in the editor: Tab after a toggle nests, elsewhere it indents; list items inside a toggle still sink", async () => {
  const editor = await editorWith("<details><summary>A</summary><div><p>in</p></div></details><p>next</p><p>other</p>");
  const caret = (text: string) => editor.commands.setTextSelection(at(editor.state.doc, text, 1));
  // The editor keeps an empty line at the end of the document.
  const shown = () => outline(editor.state.doc).replace(/(, )+$/, "");
  caret("next");
  key(editor);
  assert.equal(shown(), "T(A)[in, next], other");
  assert.equal(editor.state.selection.from, at(editor.state.doc, "next", 1), "the caret stays in its text");
  caret("other");
  key(editor);
  assert.equal(shown(), "T(A)[in, next, other]");
  key(editor, true);
  assert.equal(shown(), "T(A)[in, next], other");
  key(editor, true);
  assert.equal(shown(), "T(A)[in, next], other", "top level: nothing to lift out of");
  key(editor);
  key(editor);
  assert.equal(shown(), "T(A)[in, next, other>1]", "inside, nothing more to nest into: the visual indent");
  key(editor, true);
  assert.equal(shown(), "T(A)[in, next, other]", "the indent goes first");
  editor.destroy();

  const lists = await editorWith("<details><summary>L</summary><div><ul><li><p>one</p></li><li><p>two</p></li></ul></div></details>");
  lists.commands.setTextSelection(at(lists.state.doc, "two", 1));
  key(lists);
  assert.equal(outline(lists.state.doc).replace(/(, )+$/, ""), "T(L)[UL[li(one, UL[li(two)])]]", "sinkListItem inside a toggle");
  key(lists, true);
  assert.equal(outline(lists.state.doc).replace(/(, )+$/, ""), "T(L)[UL[li(one), li(two)]]");
  lists.destroy();
});

test("nested toggles through Markdown and HTML", () => {
  const html = "<details open><summary>Outer</summary><div><p>a</p><details open><summary>Inner</summary><div><p>b</p></div></details></div></details>";
  const md = htmlToMarkdown(html, { url: (u: string) => u, linked: () => null });
  assert.equal((md.match(/<details>/g) || []).length, 2);
  const back = markdownToHtml(md);
  const dom = new win.DOMParser().parseFromString(`<body>${back}</body>`, "text/html");
  const doc = PMParser.fromSchema(schema).parse(dom.body as unknown as globalThis.Node);
  assert.equal(outline(doc), "T(Outer)[a, T(Inner)[b]]");
});
