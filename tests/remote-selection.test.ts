// The own selection through changes of others (lib/remote-selection.ts):
// text typed by someone else in front of it, in the same paragraph, moves it
// along instead of leaving it at its old offset on other text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import type { Editor as TiptapEditor } from "@tiptap/core";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-remote-selection-"));
process.env.APP_URL = "https://flowplan.example.test";

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
if (!("requestAnimationFrame" in g)) g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
const editors: TiptapEditor[] = [];
after(async () => {
  for (const editor of editors) editor.destroy();
  await win.happyDOM.close();
});

const { documentExtensions } = await import("../lib/document-schema");
const { htmlState } = await import("../lib/document-server");
const { RemoteSelection } = await import("../lib/remote-selection");

// Two people on the same document; their changes reach each other as in
// the app (Yjs updates with origin "remote").
async function pair(html: string, withPlugin: boolean) {
  const { Editor } = await import("@tiptap/core");
  const Collaboration = (await import("@tiptap/extension-collaboration")).default;
  const state = htmlState(html);
  const make = () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state, "remote");
    const element = win.document.createElement("div");
    win.document.body.appendChild(element);
    const editor = new Editor({
      element: element as unknown as HTMLElement,
      extensions: [...documentExtensions, Collaboration.configure({ document: doc }), ...(withPlugin ? [RemoteSelection] : [])],
    });
    editors.push(editor);
    return { doc, editor };
  };
  const a = make(),
    b = make();
  for (const [from, to] of [
    [a, b],
    [b, a],
  ])
    from.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") Y.applyUpdate(to.doc, update, "remote");
    });
  return { a: a.editor, b: b.editor };
}
const selectedText = (editor: TiptapEditor) => {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to);
};

for (const html of [
  '<p data-block-id="b1">Alpha Bravo Charlie Delta</p><ul><li><p data-block-id="b2">Nested example</p></li></ul>',
  "<p>Alpha Bravo Charlie Delta</p>",
])
  test(`text typed by someone else before the selection moves it along (${html.includes("block-id") ? "with" : "without"} block ids)`, async () => {
    const { a, b } = await pair(html, true);
    b.commands.setTextSelection({ from: 7, to: 12 });
    assert.equal(selectedText(b), "Bravo");
    a.commands.setTextSelection(1);
    a.commands.insertContent("New ");
    assert.match(b.getText(), /^New Alpha Bravo/);
    assert.equal(selectedText(b), "Bravo");
    // A change after the selection leaves it alone; one inside it grows it.
    a.commands.setTextSelection(a.state.doc.firstChild!.nodeSize - 1);
    a.commands.insertContent("!");
    assert.equal(selectedText(b), "Bravo");
    a.commands.setTextSelection(14);
    a.commands.insertContent("x");
    assert.equal(selectedText(b), "Braxvo");
    // A deleted selected text leaves a caret where it was.
    const { from, to } = b.state.selection;
    a.commands.deleteRange({ from, to });
    assert.equal(b.state.selection.empty, true);
    assert.equal(b.state.doc.textBetween(1, b.state.selection.from), "New Alpha ");
  });

test("a paragraph replaced by someone else (another block type) is left to y-tiptap", async () => {
  const selections: unknown[] = [];
  for (const withPlugin of [false, true]) {
    const { a, b } = await pair('<p data-block-id="b1">Alpha Bravo Charlie Delta</p><p data-block-id="b2">Zwei</p>', withPlugin);
    b.commands.setTextSelection({ from: 7, to: 12 });
    a.commands.setTextSelection(3);
    a.commands.setNode("heading", { level: 2 });
    assert.equal(b.state.doc.firstChild!.type.name, "heading");
    selections.push(b.state.selection.toJSON());
  }
  assert.deepEqual(selections[1], selections[0]);
});

test("without the plugin y-tiptap leaves the selection at its old offset (the bug this works around)", async () => {
  const { a, b } = await pair('<p data-block-id="b1">Alpha Bravo Charlie Delta</p>', false);
  b.commands.setTextSelection({ from: 7, to: 12 });
  a.commands.setTextSelection(1);
  a.commands.insertContent("New ");
  // If this fails, y-tiptap fixed it: lib/remote-selection.ts can go.
  assert.equal(selectedText(b), "pha B");
});
