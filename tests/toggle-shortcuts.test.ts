// Toggles from the keyboard and the block menu (#230): "> " makes a toggle
// (or a quote, as the person chose), '" ' a quote, ↵ in titles, "Umwandeln in
// → Aufklappbarer Block", an empty title through storage and Markdown, and
// closed toggles remembered per person and device.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import * as Y from "yjs";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-toggle-shortcuts-"));
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

const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { emptyTitleToParagraph, toggleAfter, turnIntoToggle, toggleFromMarker } = await import("../lib/toggle-commands");
const { isToggleClosed, toggleBlocksPlugin, toggleKey } = await import("../lib/toggle-view");
const { readClosedToggles, writeClosedToggles, TOGGLE_STORAGE_KEY, MAX_CLOSED_TOGGLES, MAX_TOGGLE_DOCUMENTS, toggleDocumentKey } = await import("../lib/toggle-memory");
const { ShortcutBlockquote, MARKER_RULE, QUOTE_MARK_RULE } = await import("../lib/quote-shortcut");
const { quoteShortcutOf } = await import("../lib/quote-shortcut-pref");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");

const schema = documentSchema();
type Json = { type?: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

// An editor as in the app: the document's extensions with the quote node
// and its typing shortcuts in place of StarterKit's.
async function typed(content: string, text: string, creates: "toggle" | "quote" = "toggle", at?: number) {
  const { Editor } = await import("@tiptap/core");
  const StarterKit = (await import("@tiptap/starter-kit")).default;
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  const extensions = [
    StarterKit.configure({ codeBlock: false, undoRedo: false, blockquote: false }),
    ShortcutBlockquote.configure({ creates: () => creates }),
    ...documentExtensions.slice(1),
  ];
  const editor = new Editor({ element: element as unknown as HTMLElement, extensions, content });
  const view = editor.view;
  if (at !== undefined) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  // Key by key, as ProseMirror reads typed text.
  for (const ch of text) {
    const from = view.state.selection.from;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, from, ch, () => view.state.tr.insertText(ch, from, from)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, from));
  }
  const json = editor.getJSON() as Json;
  const selection = view.state.selection.from;
  const focusTitle = toggleKey.getState(view.state)?.focusTitle ?? null;
  editor.destroy();
  return { json, selection, focusTitle };
}

test("the shortcut patterns: '> ' and quotation marks with a space at the start", () => {
  assert.ok(MARKER_RULE.test("> "));
  assert.ok(!MARKER_RULE.test("a> "));
  for (const q of ['" ', "„ ", "“ ", "” "]) assert.ok(QUOTE_MARK_RULE.test(q), q);
  assert.ok(!QUOTE_MARK_RULE.test('x" '));
  assert.equal(quoteShortcutOf(null), "toggle");
  assert.equal(quoteShortcutOf("quote"), "quote");
  assert.equal(quoteShortcutOf("nonsense"), "toggle");
});

test("'> ' on an empty line makes a toggle with an empty title, the caret goes to the title", async () => {
  const { json, focusTitle } = await typed("<p></p>", "> ");
  const block = json.content?.[0];
  assert.equal(block?.type, "toggle");
  assert.equal(block?.attrs?.title, "");
  assert.match(String(block?.attrs?.blockId), /^[a-z0-9]{8}$/, "a block id, so it can be remembered closed");
  assert.deepEqual(block?.content?.map((c) => c.type), ["paragraph"]);
  assert.equal(focusTitle, 0, "the view focuses the new toggle's title");
});

test("'> ' before text makes that text the title", async () => {
  const { json } = await typed("<p>Mehr dazu</p>", "> ", "toggle", 1);
  assert.equal(json.content?.[0]?.type, "toggle");
  assert.equal(json.content?.[0]?.attrs?.title, "Mehr dazu");
});

test("with “> creates: Quote” '> ' makes a quote, as in Markdown", async () => {
  const { json } = await typed("<p></p>", "> ", "quote");
  assert.equal(json.content?.[0]?.type, "blockquote");
});

test("'\" ' and typographic quotation marks make a quote either way", async () => {
  for (const mark of ['"', "„", "“", "”"])
    for (const creates of ["toggle", "quote"] as const) {
      const { json } = await typed("<p></p>", `${mark} `, creates);
      assert.equal(json.content?.[0]?.type, "blockquote", `${mark} (${creates})`);
    }
  // In the middle of a line nothing happens.
  const { json } = await typed("<p>ab</p>", '" ', "toggle", 3);
  assert.equal(json.content?.[0]?.type, "paragraph");
});

test("'> ' in the first line of a list item stays text, as before (neither a toggle nor a quote can stand there)", async () => {
  for (const creates of ["toggle", "quote"] as const) {
    const { json } = await typed("<ul><li><p></p></li></ul>", "> ", creates, 3);
    const item = json.content?.[0]?.content?.[0];
    assert.equal(item?.content?.[0]?.type, "paragraph", creates);
    assert.equal(item?.content?.[0]?.content?.[0]?.text, "> ", creates);
  }
});

test("pasted and imported Markdown '> text' stays a quote", () => {
  assert.match(markdownToHtml("> zitiert"), /<blockquote>\s*<p>zitiert<\/p>\s*<\/blockquote>/);
});

// ---- Commands ----

const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const toggle = (title: string, blockId: string | null, ...content: PMNode[]) => schema.nodes.toggle.create({ title, blockId }, content.length ? content : [p("")]);
const docState = (...nodes: PMNode[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes), plugins: [toggleBlocksPlugin()] });
const types = (doc: PMNode) => doc.content.content.map((n) => n.type.name);

test("↵ at the end of a closed toggle's title: a new empty toggle right after it", () => {
  const s0 = docState(p("Intro"), toggle("Eins", "one12345", p("a")), p("Ende"));
  const made = toggleAfter(s0, 7)!;
  assert.ok(made);
  const doc = made.tr.doc;
  assert.deepEqual(types(doc), ["paragraph", "toggle", "toggle", "paragraph"]);
  const next = doc.nodeAt(made.pos)!;
  assert.equal(next.type.name, "toggle");
  assert.equal(next.attrs.title, "");
  assert.notEqual(next.attrs.blockId, "one12345");
  // The view closes it as well and puts the caret in its title.
  const s1 = s0.apply(made.tr.setMeta(toggleKey, { toggle: made.pos, focusTitle: true }));
  assert.equal(isToggleClosed(s1, made.pos), true);
  assert.equal(toggleKey.getState(s1)?.focusTitle, made.pos);
  assert.equal(s1.doc.resolve(s1.selection.from).parent.textContent, "Ende", "the caret is after the new toggle");
});

test("↵ in an empty title: the toggle becomes a paragraph, its content stays after it", () => {
  const s0 = docState(p("Intro"), toggle("", null, p("Inhalt"), p("Mehr")), p("Ende"));
  const trn = emptyTitleToParagraph(s0, 7)!;
  assert.deepEqual(types(trn.doc), ["paragraph", "paragraph", "paragraph", "paragraph", "paragraph"]);
  assert.deepEqual(trn.doc.content.content.map((n) => n.textContent), ["Intro", "", "Inhalt", "Mehr", "Ende"]);
  assert.equal(trn.selection.from, 8, "the caret in the new empty paragraph");
  // A fresh toggle (only an empty paragraph inside) leaves one empty paragraph.
  const fresh = emptyTitleToParagraph(docState(p("Intro"), toggle("", null)), 7)!;
  assert.deepEqual(fresh.doc.content.content.map((n) => n.textContent), ["Intro", ""]);
});

test("turning a paragraph into a toggle: its text is the title, an empty paragraph inside, one step", () => {
  const s0 = docState(p("Intro"), schema.nodes.paragraph.create({ blockId: "par12345" }, schema.text("Mein Titel")));
  const trn = s0.tr;
  assert.equal(turnIntoToggle(trn, 7), true);
  assert.equal(trn.steps.length, 1);
  const t = trn.doc.nodeAt(7)!;
  assert.equal(t.type.name, "toggle");
  assert.equal(t.attrs.title, "Mein Titel");
  assert.equal(t.attrs.blockId, "par12345", "links to the block keep working");
  assert.equal(t.childCount, 1);
  assert.equal(t.firstChild?.textContent, "");
  assert.equal(trn.doc.resolve(trn.selection.from).parent, t.firstChild, "the caret in the content");
});

test("turning a list item into a toggle: its text is the title, its sub-list the content, the list split around it", () => {
  const li = (text: string, ...more: PMNode[]) => schema.nodes.listItem.create(null, [p(text), ...more]);
  const nested = schema.nodes.bulletList.create(null, [li("Kind A"), li("Kind B")]);
  const list = schema.nodes.orderedList.create({ start: 1 }, [li("Erst"), li("Mitte", nested), li("Letzt")]);
  const s0 = docState(list);
  let middle = -1;
  s0.doc.descendants((node, pos) => {
    if (node.type.name === "listItem" && node.firstChild?.textContent === "Mitte") middle = pos;
  });
  const trn = s0.tr;
  assert.equal(turnIntoToggle(trn, middle), true);
  assert.deepEqual(types(trn.doc), ["orderedList", "toggle", "orderedList"]);
  const [first, t, last] = trn.doc.content.content;
  assert.equal(first.childCount, 1);
  assert.equal(t.attrs.title, "Mitte");
  assert.equal(t.firstChild?.type.name, "bulletList");
  assert.equal(t.firstChild?.childCount, 2);
  assert.equal(last.attrs.start, 3, "the numbering goes on after the toggle");
  assert.equal(last.firstChild?.textContent, "Letzt");
  // Without children: an empty paragraph inside.
  const single = docState(schema.nodes.bulletList.create(null, [li("Allein")]));
  const t2 = single.tr;
  assert.equal(turnIntoToggle(t2, 1), true);
  assert.deepEqual(types(t2.doc), ["toggle"]);
  assert.equal(t2.doc.firstChild?.attrs.title, "Allein");
  assert.equal(t2.doc.firstChild?.firstChild?.type.name, "paragraph");
});

test("a paragraph that is a list item's text is not turned on its own", () => {
  const s0 = docState(schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, [p("x")])]));
  assert.equal(turnIntoToggle(s0.tr, 2), false);
});

test("toggleFromMarker refuses where no toggle can stand", () => {
  const s0 = docState(schema.nodes.bulletList.create(null, [schema.nodes.listItem.create(null, [p("> ")])]));
  assert.equal(toggleFromMarker(s0.tr, 3, 5), null);
});

// ---- Empty titles in storage and Markdown ----

test("an empty title stays empty through the stored HTML and Markdown", () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState("<details><summary></summary><div><p>Inhalt</p></div></details>"));
  const html = stateHtml(doc);
  assert.match(html, /<details[^>]*><summary><\/summary><div><p>Inhalt<\/p><\/div><\/details>/);
  doc.destroy();
  const markdown = htmlToMarkdown(html, { url: (u: string) => u, linked: () => null });
  assert.match(markdown, /<details>\n<summary><\/summary>\n\nInhalt\n\n<\/details>/);
  const back = new Y.Doc();
  Y.applyUpdate(back, htmlState(markdownToHtml(markdown)));
  assert.match(stateHtml(back), /<summary><\/summary>/);
  back.destroy();
  // A <details> without a <summary> gets the browser's "Details"; titles round-trip.
  const none = new Y.Doc();
  Y.applyUpdate(none, htmlState("<details><div><p>x</p></div></details><details><summary>Mehr</summary><div><p>y</p></div></details>"));
  assert.match(stateHtml(none), /<summary>Details<\/summary>.*<summary>Mehr<\/summary>/);
  none.destroy();
});

// ---- Remembered closed toggles ----

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test("closed toggles are stored by block id per person and document, bounded", () => {
  const storage = memoryStorage();
  const key = toggleDocumentKey("user1", "page1");
  assert.equal(key, "user1:page1");
  assert.equal(toggleDocumentKey("user1", "db", "row"), "user1:db/row");
  writeClosedToggles(storage, key, ["abc12345", "@12", "bad id!", "abc12345"]);
  assert.deepEqual(readClosedToggles(storage, key), ["abc12345"], "no positions, no junk, no doubles");
  assert.deepEqual(readClosedToggles(storage, "user2:page1"), [], "another person's list is their own");
  writeClosedToggles(storage, key, Array.from({ length: MAX_CLOSED_TOGGLES + 50 }, (_, i) => `id${i}`));
  assert.equal(readClosedToggles(storage, key).length, MAX_CLOSED_TOGGLES);
  for (let i = 0; i < MAX_TOGGLE_DOCUMENTS + 20; i++) writeClosedToggles(storage, `u:p${i}`, ["x"], i + 10);
  assert.equal(Object.keys(JSON.parse(storage.data.get(TOGGLE_STORAGE_KEY)!)).length, MAX_TOGGLE_DOCUMENTS);
  assert.deepEqual(readClosedToggles(storage, "u:p0"), [], "the oldest documents go first");
  writeClosedToggles(storage, "u:p0", []);
  // Broken or blocked storage: nothing remembered, nothing thrown.
  storage.data.set(TOGGLE_STORAGE_KEY, "{not json");
  assert.deepEqual(readClosedToggles(storage, key), []);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  assert.deepEqual(readClosedToggles(blocked, key), []);
  writeClosedToggles(blocked, key, ["abc12345"]);
  writeClosedToggles(null, key, ["abc12345"]);
});

test("the plugin starts with the remembered toggles closed, also when the document arrives later", () => {
  const storage = memoryStorage();
  const g2 = globalThis as unknown as { localStorage?: unknown };
  const before = g2.localStorage;
  g2.localStorage = storage;
  try {
    writeClosedToggles(storage, "u:p", ["tog12345"]);
    // The editor starts empty; Yjs brings the content.
    const s0 = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [p("")]), plugins: [toggleBlocksPlugin({ storageKey: "u:p" })] });
    const content = schema.nodes.doc.create(null, [p("Intro"), toggle("Mehr", "tog12345", p("Geheim")), toggle("Offen", "open1234", p("x"))]);
    const s1 = s0.apply(s0.tr.replaceWith(0, s0.doc.content.size, content.content).setMeta("y-sync$", { isChangeOrigin: true }));
    assert.equal(isToggleClosed(s1, 7), true);
    assert.equal(toggleKey.getState(s1)?.decorations.find().length, 1);
    const second = 7 + s1.doc.nodeAt(7)!.nodeSize;
    assert.equal(isToggleClosed(s1, second), false);
    // Without a storage key nothing is read.
    const plain = EditorState.create({ schema, doc: content, plugins: [toggleBlocksPlugin()] });
    assert.equal(isToggleClosed(plain, 7), false);
  } finally {
    g2.localStorage = before;
  }
});

test("a closed toggle stays drawn closed when Yjs replaces the whole document (others' edits, undo)", () => {
  const content = [p("Intro"), toggle("Mehr", "tog12345", p("Geheim"))];
  const s0 = docState(...content);
  const s1 = s0.apply(s0.tr.setMeta(toggleKey, { toggle: 7 }));
  assert.equal(toggleKey.getState(s1)?.decorations.find().length, 1);
  const next = schema.nodes.doc.create(null, [p("Intro!"), toggle("Mehr", "tog12345", p("Geheim"))]);
  const s2 = s1.apply(s1.tr.replaceWith(0, s1.doc.content.size, next.content).setMeta("y-sync$", { isChangeOrigin: true }));
  assert.equal(isToggleClosed(s2, 8), true);
  assert.equal(toggleKey.getState(s2)?.decorations.find().length, 1);
});
