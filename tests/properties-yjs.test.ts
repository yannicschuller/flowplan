// Property-based tests (fast-check, tests/helpers/properties.ts) of the
// stored document (lib/document-server.ts): edits of several editors, merged
// by the server (applyDocumentUpdate) in any order, give the same document;
// and HTML → Yjs → HTML is stable for random documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as Y from "yjs";
import { check } from "./helpers/properties";
import { documentHtml } from "./helpers/document-arbitrary";
import { applyDocumentUpdate, htmlState, stateHtml } from "../lib/document-server";

const load = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
};

/* ---------- Random edits ---------- */

type Edit =
  | { kind: "type"; at: number; offset: number; text: string; bold: boolean }
  | { kind: "erase"; at: number; offset: number; length: number }
  | { kind: "block"; at: number; text: string; heading: boolean }
  | { kind: "remove"; at: number };
const words = fc.constantFrom("a", "Wort", " ", "😀", "中文", "e\u0301", "|", "**", "\n");
const edit: fc.Arbitrary<Edit> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("type" as const), at: fc.nat(), offset: fc.nat(), text: words, bold: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("erase" as const), at: fc.nat(), offset: fc.nat(), length: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("block" as const), at: fc.nat(), text: words, heading: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("remove" as const), at: fc.nat() }) },
);
// Paragraphs and headings directly in the document, with their text.
function textBlocks(fragment: Y.XmlFragment) {
  return fragment.toArray().filter((node): node is Y.XmlElement => node instanceof Y.XmlElement && ["paragraph", "heading"].includes(node.nodeName));
}
function textOf(block: Y.XmlElement) {
  const first = block.get(0);
  if (first instanceof Y.XmlText) return first;
  const text = new Y.XmlText();
  block.insert(0, [text]);
  return text;
}
// An edit as an editor makes it (y-prosemirror's structure: marks are
// attributes of the text).
function apply(doc: Y.Doc, change: Edit) {
  const fragment = doc.getXmlFragment("default");
  const blocks = textBlocks(fragment);
  if (change.kind === "block") {
    const block = new Y.XmlElement(change.heading ? "heading" : "paragraph");
    if (change.heading) block.setAttribute("level", 2 as unknown as string);
    fragment.insert(change.at % (fragment.length + 1), [block]);
    block.insert(0, [new Y.XmlText(change.text)]);
    return;
  }
  if (!blocks.length) return;
  const block = blocks[change.at % blocks.length];
  if (change.kind === "remove") {
    if (fragment.length > 1) fragment.delete(fragment.toArray().indexOf(block), 1);
    return;
  }
  const text = textOf(block);
  const offset = change.offset % (text.length + 1);
  if (change.kind === "type") text.insert(offset, change.text, change.bold ? { bold: {} } : {});
  else text.delete(Math.min(offset, Math.max(0, text.length - 1)), Math.min(change.length, text.length - Math.min(offset, Math.max(0, text.length - 1))));
}
// Editors that each load the stored page (some after seeing an earlier
// editor's first edits) and make their own; every update they send. Their
// client ids are fixed, so a run can be replayed.
const session = fc.record({
  edits: fc.array(edit, { minLength: 1, maxLength: 6 }),
  // How many updates of the editor before this one it has seen first.
  seen: fc.nat({ max: 3 }),
});
function edited(base: Uint8Array, sessions: { edits: Edit[]; seen: number }[]) {
  const updates: Uint8Array[][] = [];
  sessions.forEach(({ edits, seen }, i) => {
    const doc = load(base);
    doc.clientID = 1000 + i;
    for (const update of (updates[i - 1] || []).slice(0, seen)) Y.applyUpdate(doc, update);
    const own: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") own.push(update);
    });
    for (const change of edits) doc.transact(() => apply(doc, change));
    updates.push(own);
    doc.destroy();
  });
  return updates.flat();
}
// The server's copy: the stored state and every update, in this order.
function merged(base: Uint8Array, updates: Uint8Array[], merge: (doc: Y.Doc, update: Uint8Array) => unknown = applyDocumentUpdate) {
  const doc = load(base);
  doc.clientID = 1;
  for (const update of updates) merge(doc, update);
  const html = stateHtml(doc);
  doc.destroy();
  return html;
}

/* ---------- Properties ---------- */

// Known limitation, reported (upstream, Yjs 13.6.33): with marks the merge
// can depend on the order – see the test below. Here documents and edits
// carry none.
test("property: editors' updates merged in any order give the same document", () => {
  check(
    fc.property(
      documentHtml({ marks: false }),
      fc.array(session, { minLength: 1, maxLength: 3 }),
      fc.array(fc.nat(), { minLength: 32, maxLength: 32 }),
      (html, sessions, keys) => {
        const base = htmlState(html);
        const updates = edited(base, sessions);
        const inOrder = merged(base, updates);
        // Any order, also with updates before those they build on (Yjs
        // keeps those pending), and one of them twice.
        const shuffled = updates.map((update, i) => [keys[i % keys.length], i, update] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , update]) => update);
        assert.equal(merged(base, shuffled), inOrder);
        assert.equal(merged(base, [...shuffled, shuffled[0]].filter(Boolean)), inOrder);
        // Yjs alone gives the same: the server changes nothing in edits of
        // a page that is not blank.
        assert.equal(merged(base, updates, Y.applyUpdate), inOrder);
      },
    ),
    80,
  );
});

// Found by the property above with marks (reported upstream): editor A
// deletes across the start of a link, editor B types unlinked text inside
// the link and deletes it again. Applied as B1, A, B2 the rest of the link
// loses it; in every other order it keeps it. Only a nested Y.XmlText (as
// y-prosemirror stores paragraphs) is affected, not a root Y.Text.
test("upstream: formatted text merges the same in any order", { todo: "Yjs 13.6.33 loses a link in one order of the same updates" }, () => {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const paragraph = new Y.XmlElement("paragraph");
  doc.getXmlFragment("default").insert(0, [paragraph]);
  const text = new Y.XmlText();
  paragraph.insert(0, [text]);
  text.insert(0, "ab");
  text.insert(2, "cd", { link: { href: "https://example.test/" } });
  const base = Y.encodeStateAsUpdate(doc);
  const textOf = (d: Y.Doc) => (d.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const updates: Uint8Array[] = [];
  const editor = (clientID: number, edit: (t: Y.XmlText) => void) => {
    const d = load(base);
    d.clientID = clientID;
    d.on("update", (update: Uint8Array) => updates.push(update));
    edit(textOf(d));
  };
  editor(10, (t) => t.delete(1, 2));
  editor(11, (t) => {
    t.insert(3, "Z", {});
    t.delete(3, 1);
  });
  const deltas = [[0, 1, 2], [1, 0, 2]].map((order) => {
    const d = load(base);
    d.clientID = 2;
    for (const i of order) Y.applyUpdate(d, updates[i]);
    return textOf(d).toDelta();
  });
  assert.deepEqual(deltas[1], deltas[0]);
});

// Found while writing the property above (D2): a blank page is replaced by
// content written from scratch only while it is blank (applyDocumentUpdate).
// Text typed into its paragraph by an editor that had not heard of the
// replacement is re-attached, so it survives in either order – above or
// below the content, as Yjs orders the paragraph and the content by their
// client ids, the same in both orders.
test("property: text typed into a blank page survives content written from scratch, in any order", () => {
  check(
    fc.property(
      fc.integer({ min: 2, max: 2 ** 31 }),
      fc.integer({ min: 2, max: 2 ** 31 }),
      fc.integer({ min: 2, max: 2 ** 31 }),
      fc.constantFrom("typed", "a", "😀 b", "中文"),
      fc.constantFrom("<p>from scratch</p>", "<h2>Title</h2><p>from scratch</p>", "<ul><li><p>from scratch</p></li></ul>"),
      fc.boolean(),
      fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
      (blankClient, editorClient, scratchClient, text, html, fullState, keys) => {
        fc.pre(new Set([blankClient, editorClient, scratchClient]).size === 3);
        const page = new Y.Doc();
        page.clientID = blankClient;
        page.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
        const blank = Y.encodeStateAsUpdate(page);
        const editor = load(blank);
        editor.clientID = editorClient;
        const typed: Uint8Array[] = [];
        editor.on("update", (update: Uint8Array) => typed.push(update));
        // Typed key by key, as an editor writes each keystroke.
        const paragraph = editor.getXmlFragment("default").get(0) as Y.XmlElement;
        const t = new Y.XmlText();
        paragraph.insert(0, [t]);
        for (const char of text) t.insert(t.length, char);
        // One save: the editor's first sends its whole state, later ones
        // the changes since the last (merged). What it sends in a later
        // save into text the server re-attached already is a known limit
        // (lib/document-server.ts).
        const sent = [fullState ? Y.encodeStateAsUpdate(editor) : Y.mergeUpdates(typed)];
        const writer = new Y.Doc();
        writer.clientID = scratchClient;
        Y.applyUpdate(writer, htmlState(html));
        const scratch = Y.encodeStateAsUpdate(writer);
        const updates = [...sent, scratch];
        const shuffled = updates
          .map((u, i) => [keys[i % keys.length], i, u] as const)
          .sort((a, b) => a[0] - b[0] || a[1] - b[1])
          .map(([, , u]) => u);
        const results = new Set<string>();
        for (const order of [updates, [...updates].reverse(), shuffled])
          // Also delivered twice, and the last one once before all.
          for (const delivered of [order, [...order, ...order], [order[order.length - 1], ...order]]) {
            const result = merged(blank, delivered);
            assert.ok(result.includes(`<p>${text}</p>`), result);
            assert.ok(result.includes("from scratch"), result);
            assert.ok(!result.includes("<p></p>"), result);
            results.add(result);
          }
        assert.equal(results.size, 1, [...results].join(" | "));
      },
    ),
    80,
  );
});

test("property: HTML to the stored document and back is stable", () => {
  check(
    fc.property(documentHtml(), (html) => {
      const once = stateHtml(load(htmlState(html)));
      assert.equal(stateHtml(load(htmlState(once))), once);
    }),
    100,
  );
});
