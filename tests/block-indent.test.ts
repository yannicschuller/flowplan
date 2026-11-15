// Indent / outdent from the block menu and the toolbar (#302,
// lib/block-indent.ts): they press Tab / Shift+Tab, and say beforehand
// exactly when the keys would move something – list and task items,
// paragraphs and headings, blocks after a toggle; not code or tables.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-indent-"));

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser", "KeyboardEvent"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
if (!("requestAnimationFrame" in g)) g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
after(async () => {
  await win.happyDOM.close();
});

const { documentExtensions } = await import("../lib/document-schema");
const { canShiftText, canShiftBlocks, followBlocks, pressTab } = await import("../lib/block-indent");
const { documentBlocks } = await import("../lib/document-blocks");
const { Editor } = await import("@tiptap/core");

function editorWith(html: string) {
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  return new Editor({ element: element as unknown as HTMLElement, extensions: documentExtensions, content: html });
}
function at(doc: PMNode, text: string, offset = 1) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) found = pos + node.text.indexOf(text) + offset;
    return true;
  });
  assert.ok(found >= 0, `text ${text}`);
  return found;
}

const DOC =
  "<ul><li><p>one</p></li><li><p>two</p><ul><li><p>deep</p></li></ul></li></ul>" +
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>taskA</p></li><li data-type="taskItem" data-checked="false"><p>taskB</p></li></ul>' +
  "<p>plain</p><h2>title</h2><p data-indent=\"8\">deepest</p>" +
  "<details><summary>T</summary><div><p>inside</p></div></details><p>afterToggle</p>" +
  "<pre><code>codeText</code></pre>" +
  "<table><tbody><tr><td><p>cellA</p></td><td><p>cellB</p></td></tr></tbody></table><p>end</p>";
const WORDS = ["one", "two", "deep", "taskA", "taskB", "plain", "title", "deepest", "inside", "afterToggle", "codeText", "cellA", "end"];

test("the check says exactly when Tab / Shift+Tab move something, at every kind of block", () => {
  const expected: Record<string, [boolean, boolean]> = {
    // [indent, outdent]
    one: [false, true], // the first item cannot sink; a top-level item lifts out of its list
    two: [true, true],
    deep: [false, true],
    taskA: [false, true],
    taskB: [true, true],
    plain: [true, false],
    title: [true, false],
    deepest: [false, true], // at the deepest indent already
    inside: [true, true], // nests into nothing, but takes a visual indent / lifts out of the toggle
    afterToggle: [true, false],
    codeText: [false, false],
    cellA: [false, false],
    end: [true, false],
  };
  for (const word of WORDS)
    for (const out of [false, true]) {
      const editor = editorWith(DOC);
      editor.commands.setTextSelection(at(editor.state.doc, word));
      const can = canShiftText(editor.state, out);
      const before = editor.state.doc;
      pressTab(editor.view, out);
      const moved = !editor.state.doc.eq(before);
      // In code Tab indents the lines' text, in tables it goes to the next
      // cell: no block moves there.
      if (!["codeText", "cellA"].includes(word)) assert.equal(can, moved, `${word} ${out ? "outdent" : "indent"}: check ${can}, keys ${moved}`);
      assert.equal(can, expected[word][out ? 1 : 0], `${word} ${out ? "outdent" : "indent"}`);
      editor.destroy();
    }
});

test("several items at once: a selection over them sinks them together", () => {
  const editor = editorWith("<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>");
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at(editor.state.doc, "b"), at(editor.state.doc, "c"))));
  assert.ok(canShiftText(editor.state, false));
  pressTab(editor.view, false);
  const items: string[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "listItem") items.push(`${editor.state.doc.resolve(pos).depth}:${node.firstChild?.textContent}`);
  });
  assert.deepEqual(items, ["1:a", "3:b", "3:c"], "b and c both one level deeper, under a");
  editor.destroy();
});

test("chosen blocks: the check covers their text, as Tab on chosen blocks does", () => {
  const editor = editorWith("<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul><pre><code>x</code></pre><p>p</p>");
  const blocks = documentBlocks(editor.state.doc);
  const pos = (text: string) => blocks.find((b) => b.node.firstChild?.textContent === text && b.node.type.name === "listItem")!.pos;
  assert.equal(canShiftBlocks(editor.state, [pos("a")], false), false, "the first item cannot sink");
  assert.equal(canShiftBlocks(editor.state, [pos("b"), pos("c")], false), true);
  assert.equal(canShiftBlocks(editor.state, [pos("a"), pos("b")], true), true, "top-level items lift out of the list");
  const code = blocks.find((b) => b.node.type.name === "codeBlock")!.pos;
  assert.equal(canShiftBlocks(editor.state, [code], false), false, "code keeps its own Tab");
  assert.equal(canShiftBlocks(editor.state, [code, code + 999], false), false, "no valid range: nothing");
  editor.destroy();
});

test("chosen blocks are found again where the keys moved them", () => {
  const editor = editorWith("<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul><p>p</p>");
  const item = (text: string) => documentBlocks(editor.state.doc).find((b) => b.node.type.name === "listItem" && b.node.firstChild?.textContent === text)!.pos;
  const chosen = [item("b"), item("c")];
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at(editor.state.doc, "b"), at(editor.state.doc, "c"))));
  const after = followBlocks(editor, chosen, () => pressTab(editor.view, false));
  assert.deepEqual(after, [item("b"), item("c")], "the items, now inside a");
  assert.ok(after.every((pos) => editor.state.doc.resolve(pos).depth === 3), "one level deeper");
  const back = followBlocks(editor, after, () => pressTab(editor.view, true));
  assert.deepEqual(back, [item("b"), item("c")]);
  editor.destroy();
});
