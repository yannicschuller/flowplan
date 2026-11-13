// Block ids (lib/block-ids-plugin.ts) and the undo history: the ids a change
// needs come in a transaction of their own right after it, and they are
// part of that change's undo step however late they come – the browser
// can be busy for longer than Yjs' capture time (half a second) right
// after a change, e.g. after "Umwandeln in → Aufklappbarer Block" or ⌫ at
// a toggle's title. Then one ⌘Z only took the ids back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-ids-undo-"));
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

const { documentExtensions } = await import("../lib/document-schema");
const { BlockIds } = await import("../lib/block-ids-plugin");
const { htmlState } = await import("../lib/document-server");
const { turnIntoToggle } = await import("../lib/toggle-commands");
const { applyBlockChange } = await import("../lib/block-shortcuts");
const { yUndoPluginKey } = await import("@tiptap/y-tiptap");

// An editor as in the app: Yjs document, its undo history, block ids.
async function editorOf(html: string) {
  const { Editor } = await import("@tiptap/core");
  const Collaboration = (await import("@tiptap/extension-collaboration")).default;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  const editor = new Editor({
    element: element as unknown as HTMLElement,
    extensions: [...documentExtensions, BlockIds, Collaboration.configure({ document: doc })],
  });
  const undo = yUndoPluginKey.getState(editor.state)!.undoManager;
  return { editor, undo };
}

// The browser busy for `ms` right after a change, before the ids (a
// timeout of 0) run: for Yjs, the last change is that much longer ago.
async function busy(undo: { lastChange: number }, ms: number) {
  if (undo.lastChange > 0) undo.lastChange -= ms;
  await new Promise((done) => setTimeout(done, 10));
}
const outline = (doc: PMNode) => {
  const out: string[] = [];
  doc.forEach((node) => out.push(node.type.name === "toggle" ? `T(${node.attrs.title})` : node.textContent));
  return out.join(", ");
};
const posOf = (doc: PMNode, text: string) => {
  let found = -1;
  doc.forEach((node, offset) => {
    if (found < 0 && node.textContent === text) found = offset;
  });
  return found;
};

test("a block turned into a toggle is one undo step with the ids it gets, even when they come late", async () => {
  for (const late of [0, 600, 2000]) {
    const { editor, undo } = await editorOf("<p>Intro</p><p>Wird Titel</p><p>Ende</p>");
    const pos = posOf(editor.state.doc, "Wird Titel");
    editor.commands.command(({ tr }) => turnIntoToggle(tr, pos));
    await busy(undo, late);
    assert.equal(outline(editor.state.doc), "Intro, T(Wird Titel), Ende");
    const inner = editor.state.doc.child(1).firstChild!;
    assert.match(String(inner.attrs.blockId), /^[a-z0-9]{8}$/, "the paragraph inside got its id");
    assert.equal(undo.undoStack.length, 1, `one step (ids ${late} ms late)`);
    editor.commands.undo();
    assert.equal(outline(editor.state.doc), "Intro, Wird Titel, Ende", `one undo brings the paragraph back (ids ${late} ms late)`);
    editor.commands.redo();
    assert.equal(outline(editor.state.doc), "Intro, T(Wird Titel), Ende");
    editor.destroy();
  }
});

test("block menu changes (stopCapturing around them) take their ids along; typing on is a step of its own", async () => {
  const { editor, undo } = await editorOf("<p>Intro</p><p>Wird Titel</p><p>Ende</p>");
  const pos = posOf(editor.state.doc, "Wird Titel");
  const tr = editor.state.tr;
  turnIntoToggle(tr, pos);
  applyBlockChange(editor, tr);
  await busy(undo, 0);
  assert.equal(undo.undoStack.length, 1);
  // Typing right after: its own step, as the block change wanted.
  editor.commands.insertContentAt(posOf(editor.state.doc, "Ende") + 1, "x");
  await busy(undo, 0);
  assert.equal(undo.undoStack.length, 2);
  editor.commands.undo();
  assert.equal(outline(editor.state.doc), "Intro, T(Wird Titel), Ende");
  editor.commands.undo();
  assert.equal(outline(editor.state.doc), "Intro, Wird Titel, Ende");
  editor.destroy();
});

test("typing stays grouped as before: ids in between neither split nor stretch the steps", async () => {
  const { editor, undo } = await editorOf("<p>Alt</p>");
  const end = () => editor.state.doc.firstChild!.nodeSize - 1;
  editor.commands.setTextSelection(end());
  // Typed quickly: one step, with the id the old block gets.
  editor.commands.insertContent("a");
  await busy(undo, 0);
  assert.match(String(editor.state.doc.firstChild!.attrs.blockId), /^[a-z0-9]{8}$/);
  editor.commands.insertContent("b");
  await busy(undo, 0);
  assert.equal(undo.undoStack.length, 1, "typing with ids in between is one step");
  // A pause longer than the capture time: a new step.
  await busy(undo, 600);
  editor.commands.insertContent("c");
  await busy(undo, 0);
  assert.equal(undo.undoStack.length, 2);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "Altab");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "Alt");
  editor.destroy();
});
