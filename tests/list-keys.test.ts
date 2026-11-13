// Tab and Enter in lists (#254): Tab where nothing can be indented stays
// in the text, Enter in an empty item lifts that item only, one level per
// Enter (lib/list-tidy.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-list-keys-"));

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
const { Editor } = await import("@tiptap/core");

function editorWith(html: string) {
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  return new Editor({ element: element as unknown as HTMLElement, extensions: documentExtensions, content: html });
}
// A key as the browser sends it; true when the editor took it (the browser
// then does nothing with it, e.g. no focus move).
const press = (editor: InstanceType<typeof Editor>, key: string, shiftKey = false) =>
  !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, new win.KeyboardEvent("keydown", { key, shiftKey }) as unknown as KeyboardEvent));
// Lists as UL[…]/OL[…]/TL[…], items as li(…)/task(…), paragraphs by text
// ("_" when empty).
function outline(node: PMNode): string {
  const kids = () => node.content.content.map(outline).join(", ");
  switch (node.type.name) {
    case "doc":
      return kids();
    case "bulletList":
      return `UL[${kids()}]`;
    case "orderedList":
      return `OL[${kids()}]`;
    case "taskList":
      return `TL[${kids()}]`;
    case "listItem":
      return `li(${kids()})`;
    case "taskItem":
      return `task(${kids()})`;
    case "table":
      return "table";
    default:
      return node.textContent || "_";
  }
}
const shown = (editor: InstanceType<typeof Editor>) => outline(editor.state.doc).replace(/(, _)+$/, "");
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
// The caret in the n-th empty paragraph inside an item.
function emptyItemPos(doc: PMNode) {
  let found = -1;
  doc.descendants((node, pos, parent) => {
    if (found < 0 && node.type.name === "paragraph" && !node.content.size && parent && ["listItem", "taskItem"].includes(parent.type.name)) found = pos + 1;
    return found < 0;
  });
  assert.ok(found >= 0, "an empty item");
  return found;
}

test("Tab in an item that cannot be indented stays in it", () => {
  for (const [list, item] of [
    ["ul", "li"],
    ["ul data-type=\"taskList\"", "li data-type=\"taskItem\""],
  ]) {
    const close = (tag: string) => `</${tag.split(" ")[0]}>`;
    const editor = editorWith(
      `<${list}><${item}><p>Punkt A</p><${list}><${item}><p>Erstes Unter</p>${close(item)}${close(list)}${close(item)}${close(list)}<p>Mitte</p><${list}><${item}><p>Andere</p>${close(item)}${close(list)}<details><summary>Klappe</summary><div><p>Drin</p></div></details>`,
    );
    const before = shown(editor);
    // The first sub-item has no item before it: nothing to indent into.
    editor.commands.setTextSelection(at(editor.state.doc, "Erstes", 2));
    const caret = editor.state.selection.from;
    assert.equal(press(editor, "Tab"), true, `${item}: the editor keeps Tab`);
    assert.equal(shown(editor), before);
    assert.equal(editor.state.selection.from, caret, "the caret stays where it was");
    // The first top-level item: nothing before it either.
    editor.commands.setTextSelection(at(editor.state.doc, "Punkt", 1));
    assert.equal(press(editor, "Tab"), true);
    assert.equal(shown(editor), before);
    assert.equal(editor.state.selection.from, at(editor.state.doc, "Punkt", 1));
    // Shift+Tab still lifts the sub-item, Tab nests it back.
    editor.commands.setTextSelection(at(editor.state.doc, "Erstes", 2));
    assert.equal(press(editor, "Tab", true), true);
    assert.notEqual(shown(editor), before);
    assert.equal(press(editor, "Tab"), true);
    assert.equal(shown(editor), before);
    editor.destroy();
  }
});

test("Tab in tables moves between cells; in code it indents; nothing leaves the editor", () => {
  const editor = editorWith("<table><tbody><tr><td><p>Eins</p></td><td><p>Zwei</p></td></tr></tbody></table><pre><code>x</code></pre>");
  editor.commands.setTextSelection(at(editor.state.doc, "Zwei", 1));
  assert.equal(press(editor, "Tab", true), true);
  assert.equal(editor.state.selection.$from.parent.textContent, "Eins", "back to the cell before");
  // In the first cell there is no cell before: Shift+Tab stays.
  const caret = editor.state.selection.from;
  assert.equal(press(editor, "Tab", true), true);
  assert.equal(editor.state.selection.from, caret);
  editor.commands.setTextSelection(at(editor.state.doc, "x", 0));
  assert.equal(press(editor, "Tab"), true);
  assert.match(editor.state.doc.lastChild!.type.name === "codeBlock" ? editor.state.doc.lastChild!.textContent : editor.state.doc.child(1).textContent, /^\s+x$/);
  editor.destroy();
  // Read-only: Tab goes on to the next control as usual.
  const readonly = editorWith("<ul><li><p>A</p></li></ul>");
  readonly.setEditable(false);
  readonly.commands.setTextSelection(at(readonly.state.doc, "A", 1));
  assert.equal(press(readonly, "Tab"), false);
  readonly.destroy();
});

test("Enter in an empty sub-item lifts only that item, one level per Enter, then ends the list", () => {
  for (const [list, item, l, i] of [
    ["ul", "li", "UL", "li"],
    ["ul data-type=\"taskList\"", "li data-type=\"taskItem\"", "TL", "task"],
  ]) {
    const end = (tag: string) => `</${tag.split(" ")[0]}>`;
    const li = (text: string, ...children: string[]) =>
      `<${item}><p>${text}</p>${children.length ? `<${list}>${children.join("")}${end(list)}` : ""}${end(item)}`;
    const editor = editorWith(`<${list}>${li("A", li("B", li("C"), li("D", li("D1")), li("")))}${li("Z")}${end(list)}`);
    editor.commands.setTextSelection(emptyItemPos(editor.state.doc));
    // Level 3 → 2: right after "B", its sub-items stay where they are.
    assert.equal(press(editor, "Enter"), true);
    assert.equal(shown(editor), `${l}[${i}(A, ${l}[${i}(B, ${l}[${i}(C), ${i}(D, ${l}[${i}(D1)])]), ${i}(_)]), ${i}(Z)]`);
    assert.equal(editor.state.selection.$from.parent.content.size, 0, "the caret stays in the empty item");
    // 2 → 1: between "A" and "Z", one list still.
    assert.equal(press(editor, "Enter"), true);
    assert.equal(shown(editor), `${l}[${i}(A, ${l}[${i}(B, ${l}[${i}(C), ${i}(D, ${l}[${i}(D1)])])]), ${i}(_), ${i}(Z)]`);
    // 1 → a paragraph.
    assert.equal(press(editor, "Enter"), true);
    assert.equal(shown(editor), `${l}[${i}(A, ${l}[${i}(B, ${l}[${i}(C), ${i}(D, ${l}[${i}(D1)])])])], _, ${l}[${i}(Z)]`);
    assert.equal(editor.state.selection.$from.parent.type.name, "paragraph");
    assert.equal(editor.state.selection.$from.depth, 1, "a paragraph of its own");
    editor.destroy();
  }
});

test("Enter in an empty sub-item with siblings after it outdents like Shift+Tab; filled items still split", () => {
  const editor = editorWith("<ul><li><p>A</p><ul><li><p>B</p></li><li><p></p></li><li><p>C</p></li></ul></li></ul>");
  editor.commands.setTextSelection(emptyItemPos(editor.state.doc));
  const viaTab = editorWith(editor.getHTML());
  viaTab.commands.setTextSelection(emptyItemPos(viaTab.state.doc));
  assert.equal(press(editor, "Enter"), true);
  assert.equal(press(viaTab, "Tab", true), true);
  assert.equal(shown(editor), shown(viaTab));
  assert.equal(shown(editor), "UL[li(A, UL[li(B)]), li(_, UL[li(C)])]");
  viaTab.destroy();
  // Enter at the end of a filled item: a new item at the same level.
  editor.commands.setTextSelection(at(editor.state.doc, "B", 1));
  assert.equal(press(editor, "Enter"), true);
  assert.equal(shown(editor), "UL[li(A, UL[li(B), li(_)]), li(_, UL[li(C)])]");
  editor.destroy();
});
