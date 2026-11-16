// Comments on blocks moved with the toolbar's arrows (⌘⇧↑ / ⌘⇧↓, #314), in
// an editor as in the app: Yjs, block ids and the comment plugin. Yjs has
// no move, the moved block is inserted anew, and the stored anchors of the
// blocks that swapped places stop resolving – the highlight vanished and
// the thread said "passage no longer available". The plugin hands over
// fresh anchors for the moved passages (components/inline-comments.tsx
// stores them with thread.reanchor).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { InlineThread, CommentAnchor } from "../lib/inline-comment-types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-move-"));
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
const { commentAnchor, commentRange, commentQuote } = await import("../lib/comment-positions");
const { inlineCommentExtension, editorCommentBinding, relocatedCommentAnchors, setCommentHighlights } =
  await import("../lib/inline-comment-plugin");
const G = "generation-1";

async function editorOf(html: string) {
  const { Editor } = await import("@tiptap/core");
  const Collaboration = (await import("@tiptap/extension-collaboration")).default;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  return new Editor({
    element: element as unknown as HTMLElement,
    extensions: [
      ...documentExtensions,
      BlockIds,
      Collaboration.configure({ document: doc }),
      inlineCommentExtension(G),
    ],
  });
}
const startOf = (doc: PMNode, text: string) => {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent.includes(text))
      found = pos + 1 + node.textContent.indexOf(text);
  });
  return found;
};
const thread = (id: string, anchor: CommentAnchor) =>
  ({ id, anchor, resolved: 0, messages: [], messageCount: 1 }) as unknown as InlineThread;

test("comments keep their passage and highlight when their block moves up and down", async () => {
  const editor = await editorOf("<p>Alpha one</p><p>Bravo two</p><p>Charlie three</p>");
  const binding = () => editorCommentBinding(editor)!;
  const at = (text: string) => {
    const from = startOf(editor.state.doc, text);
    return commentAnchor(binding(), from, from + text.length, G);
  };
  let threads = [thread("a", at("Alpha")), thread("b", at("two")), thread("c", at("Charlie three"))];
  const quotes: Record<string, string> = { a: "Alpha", b: "two", c: "Charlie three" };
  const handed: { id: string; anchor: CommentAnchor }[] = [];
  editor.on("transaction", ({ transaction }) =>
    handed.push(...relocatedCommentAnchors(editor, transaction, G)),
  );
  setCommentHighlights(editor, threads, null);
  for (const [text, direction] of [["Bravo", -1], ["Bravo", 1], ["Bravo", 1], ["Charlie", -1]] as const) {
    handed.length = 0;
    editor.commands.setTextSelection(startOf(editor.state.doc, text) + 1);
    assert.ok(moveSelectedBlock(editor, direction), `“${text}” moves`);
    // Without new anchors, a thread loses its passage (the bug).
    const lost = threads.filter((t) => !commentRange(binding(), t.anchor, G)).map((t) => t.id);
    assert.ok(lost.length > 0, "the move breaks a stored anchor");
    for (const id of lost)
      assert.ok(handed.some((h) => h.id === id), `${id} gets a fresh anchor`);
    const fresh = new Map(handed.map((h) => [h.id, h.anchor]));
    threads = threads.map((t) => (fresh.has(t.id) ? thread(t.id, fresh.get(t.id)!) : t));
    for (const t of threads) {
      const r = commentRange(binding(), t.anchor, G)!;
      assert.ok(r, `${t.id} resolves`);
      assert.equal(commentQuote(editor.state.doc, r.from, r.to), quotes[t.id]);
    }
    setCommentHighlights(editor, threads, null);
    const marks = [...editor.view.dom.querySelectorAll(".inline-comment-mark")].map((m) => m.textContent);
    assert.deepEqual(marks.sort(), Object.values(quotes).sort());
  }
  const order: string[] = [];
  editor.state.doc.forEach((n) => order.push(n.textContent));
  assert.deepEqual(order, ["Charlie three", "Alpha one", "Bravo two"]);
  editor.destroy();
});
