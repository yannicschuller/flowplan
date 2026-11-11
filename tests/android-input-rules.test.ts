// The "[] " task shortcut and the Markdown shortcuts with Android's
// on-screen keyboards (#207): the text arrives inside an IME composition,
// where input rules wait, and they run when the composition ends.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
after(async () => {
  await win.happyDOM.close();
});

async function editorWith(text: string, composing: boolean) {
  const { Editor } = await import("@tiptap/core");
  const { documentExtensions } = await import("../lib/document-schema");
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  const editor = new Editor({ element: element as unknown as HTMLElement, extensions: documentExtensions, content: "<p></p>" });
  const view = editor.view;
  const input = (view as unknown as { input: { composing: boolean } }).input;
  // As ProseMirror reads text typed into the page: handleTextInput, then
  // the plain insertion when no handler took it.
  input.composing = composing;
  const from = view.state.selection.from;
  const handled = view.someProp("handleTextInput", (f) => f(view, from, from, text, () => view.state.tr.insertText(text, from, from)));
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, from));
  if (composing) {
    // Inside the composition the rule waits.
    assert.equal(editor.getJSON().content?.[0]?.type, "paragraph");
    input.composing = false;
    view.dom.dispatchEvent(new win.Event("compositionend") as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const json = editor.getJSON();
  editor.destroy();
  return json.content?.[0];
}

test("“[] ” typed in a composition starts a task when the composition ends, as when typed key by key", async () => {
  for (const composing of [false, true]) {
    const block = await editorWith("[] ", composing);
    assert.equal(block?.type, "taskList", `composing: ${composing}`);
    assert.equal((block?.content?.[0] as { attrs?: { checked?: boolean } })?.attrs?.checked, false);
    const done = await editorWith("[x] ", composing);
    assert.equal(done?.type, "taskList");
    assert.equal((done?.content?.[0] as { attrs?: { checked?: boolean } })?.attrs?.checked, true);
  }
});

test("Markdown shortcuts typed in a composition apply when it ends", async () => {
  assert.equal((await editorWith("# ", true))?.type, "heading");
  assert.equal((await editorWith("- ", true))?.type, "bulletList");
  assert.equal((await editorWith("1. ", true))?.type, "orderedList");
  assert.equal((await editorWith("> ", true))?.type, "blockquote");
});
