// ⌘⇧↑ / ⌘⇧↓ on tasks in an editor as in the app (Yjs, block ids, #467,
// #468): the caret stays in the moved task's text, so the next press moves
// it on, and each press is one undo step.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-list-move-"));
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
const { moveSelectedBlock } = await import("../lib/block-shortcuts");
const { yUndoPluginKey } = await import("@tiptap/y-tiptap");

async function editorOf(html: string) {
  const { Editor } = await import("@tiptap/core");
  const Collaboration = (await import("@tiptap/extension-collaboration")).default;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  return new Editor({
    element: element as unknown as HTMLElement,
    extensions: [...documentExtensions, BlockIds, Collaboration.configure({ document: doc })],
  });
}
const textPos = (doc: PMNode, text: string) => {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
  });
  return found;
};
// Top-level blocks; tasks with their state, subtasks indented.
const outline = (doc: PMNode) => {
  const out: string[] = [];
  const walk = (node: PMNode, level: number) =>
    node.forEach((child) => {
      if (child.type.name === "taskItem") {
        out.push(`${"  ".repeat(level)}[${child.attrs.checked ? "x" : " "}] ${child.firstChild!.textContent}`);
        child.forEach((grand, _o, i) => i > 0 && walk(grand, level + 1));
      } else if (child.type.name === "taskList") walk(child, level);
      // (Not the empty paragraph the editor keeps at the end.)
      else if (child.textContent) out.push(child.textContent);
    });
  walk(doc, 0);
  return out;
};
const task = (text: string, checked = false, sub = "") =>
  `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p>${sub}</li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

test("#467: Task 2 moves from Backlog into Today Work with its subtasks, the caret along, one undo step per press", async () => {
  const editor = await editorOf(
    `<h2>Today Work</h2>${list(task("Task 1"))}<h2>Backlog</h2>${list(task("Task 2", false, list(task("Sub 1", true), task("Sub 2"))), task("Task 3"))}`,
  );
  const undo = yUndoPluginKey.getState(editor.state)!.undoManager;
  const start = outline(editor.state.doc);
  editor.commands.setTextSelection(textPos(editor.state.doc, "Task 2") + 3);
  assert.ok(moveSelectedBlock(editor, -1));
  assert.deepEqual(outline(editor.state.doc), ["Today Work", "[ ] Task 1", "[ ] Task 2", "  [x] Sub 1", "  [ ] Sub 2", "Backlog", "[ ] Task 3"]);
  // The caret where it was in the text.
  const { selection } = editor.state;
  assert.equal(selection.empty, true);
  assert.equal(selection.from, textPos(editor.state.doc, "Task 2") + 3);
  undo.stopCapturing();
  assert.ok(moveSelectedBlock(editor, -1));
  assert.deepEqual(outline(editor.state.doc).slice(0, 3), ["Today Work", "[ ] Task 2", "  [x] Sub 1"]);
  editor.state.doc.check();
  // Each press its own step.
  editor.commands.undo();
  assert.deepEqual(outline(editor.state.doc), ["Today Work", "[ ] Task 1", "[ ] Task 2", "  [x] Sub 1", "  [ ] Sub 2", "Backlog", "[ ] Task 3"]);
  editor.commands.undo();
  assert.deepEqual(outline(editor.state.doc), start);
  editor.destroy();
});

test("#468: a subtask moves to the next parent with its own subtasks", async () => {
  const editor = await editorOf(
    list(task("Parent A", false, list(task("Child", true, list(task("Grandchild"))))), task("Parent B", false, list(task("Other")))),
  );
  editor.commands.setTextSelection(textPos(editor.state.doc, "Child"));
  assert.ok(moveSelectedBlock(editor, 1));
  assert.deepEqual(outline(editor.state.doc), ["[ ] Parent A", "[ ] Parent B", "  [x] Child", "    [ ] Grandchild", "  [ ] Other"]);
  assert.equal(editor.state.selection.from, textPos(editor.state.doc, "Child"));
  editor.destroy();
});
