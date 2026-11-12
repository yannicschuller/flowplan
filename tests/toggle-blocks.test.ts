import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { documentSchema } from "../lib/document-schema";
import { isToggleClosed, titleAbove, toggleBlocksPlugin, toggleIdentity, toggleKey, togglesAround } from "../lib/toggle-view";

// Toggle blocks (#137): open or closed is editor state, never part of the
// document – stored HTML, exports and published pages keep an open toggle.
const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const toggle = (attrs: Record<string, unknown>, ...content: Awaited<ReturnType<typeof p>>[]) => schema.nodes.toggle.create(attrs, content);
const state = (...nodes: Awaited<ReturnType<typeof p>>[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes), plugins: [toggleBlocksPlugin()] });
// The toggle after "Intro" sits at 7 ("Intro" is 7 long with its tags).
const sample = () => state(p("Intro"), toggle({ title: "Mehr", blockId: "tog12345" }, p("Geheim"), p("Zwei")), p("Ende"));
const TOGGLE = 7;
const flip = (s: EditorState, pos = TOGGLE) => s.apply(s.tr.setMeta(toggleKey, { toggle: pos }));
// Like the view: appended transactions (the caret leaving) included.
const flipAll = (s: EditorState, pos = TOGGLE) => s.applyTransaction(s.tr.setMeta(toggleKey, { toggle: pos })).state;

test("the stored HTML of a toggle stays an open <details> with its title and content", async () => {
  const Y = await import("yjs");
  const { htmlState, stateHtml } = await import("../lib/document-server");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState("<details><summary>Mehr Infos</summary><div><p>Geheim</p></div></details>"));
  assert.match(stateHtml(doc), /<details[^>]* open[^>]*><summary>Mehr Infos<\/summary><div><p>Geheim<\/p><\/div><\/details>/);
  doc.destroy();
});

test("closing and opening a toggle is plugin state, the document does not change", () => {
  const s0 = sample();
  assert.equal(s0.doc.nodeAt(TOGGLE)?.type.name, "toggle");
  assert.equal(isToggleClosed(s0, TOGGLE), false);
  const s1 = flip(s0);
  assert.equal(isToggleClosed(s1, TOGGLE), true);
  assert.ok(s1.doc.eq(s0.doc), "the document is unchanged");
  assert.equal(toggleKey.getState(s1)?.decorations.find().length, 1);
  const s2 = flip(s1);
  assert.equal(isToggleClosed(s2, TOGGLE), false);
  assert.equal(toggleKey.getState(s2)?.decorations.find().length, 0);
});

test("a closed toggle follows its block through edits before it, by block id", () => {
  const s1 = flip(sample());
  const s2 = s1.apply(s1.tr.insertText("Neu ", 1));
  assert.equal(isToggleClosed(s2, TOGGLE + 4), true);
  // Typing elsewhere keeps it closed; editing the title too.
  const s3 = s2.apply(s2.tr.setNodeAttribute(TOGGLE + 4, "title", "Mehr Infos"));
  assert.equal(isToggleClosed(s3, TOGGLE + 4), true);
});

test("without a block id a toggle is known by its position, mapped through changes", () => {
  const s0 = state(p("Intro"), toggle({ title: "Mehr" }, p("Geheim")));
  assert.equal(toggleIdentity(s0.doc.nodeAt(TOGGLE)!, TOGGLE), `@${TOGGLE}`);
  const s1 = flip(s0);
  const s2 = s1.apply(s1.tr.insertText("ab", 1));
  assert.equal(isToggleClosed(s2, TOGGLE + 2), true);
});

test("a closed toggle without block id gets one, unique, kept out of undo; then it is known by it (#230)", async () => {
  const { closedToggleIdTransaction } = await import("../lib/toggle-view");
  const { blockIdsKey } = await import("../lib/block-ids-plugin");
  const s0 = state(p("Intro"), toggle({ title: "Mehr" }, p("Geheim")), toggle({ title: "Offen" }, p("Zwei")));
  // Nothing closed, nothing to do.
  assert.equal(closedToggleIdTransaction(s0, toggleKey.getState(s0)!.closed), null);
  const s1 = flip(s0);
  const change = closedToggleIdTransaction(s1, toggleKey.getState(s1)!.closed)!;
  assert.ok(change, "an id for the closed toggle");
  assert.equal(change.getMeta("addToHistory"), false);
  assert.equal(change.getMeta(blockIdsKey), true);
  const s2 = s1.apply(change);
  const id = s2.doc.nodeAt(TOGGLE)!.attrs.blockId;
  assert.match(id, /^[a-z0-9]{8}$/);
  // Only the closed toggle; the open one keeps none.
  const second = s2.doc.childCount - 1;
  let openPos = 0;
  s2.doc.forEach((node, offset, index) => void (index === second && (openPos = offset)));
  assert.equal(s2.doc.nodeAt(openPos)!.attrs.blockId, null);
  // Closed by its id from now on, still closed, and nothing left to name.
  assert.deepEqual([...toggleKey.getState(s2)!.closed], [id]);
  assert.equal(isToggleClosed(s2, TOGGLE), true);
  assert.equal(closedToggleIdTransaction(s2, toggleKey.getState(s2)!.closed), null);
});

test("closing moves the caret out of the hidden content, and the caret getting in opens it", () => {
  const s0 = sample();
  // Caret in "Zwei" inside the toggle.
  const inside = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, TOGGLE + 11)));
  assert.equal(togglesAround(inside.doc, inside.selection.from).length, 1);
  const closed = flipAll(inside);
  assert.equal(isToggleClosed(closed, TOGGLE), true);
  assert.equal(togglesAround(closed.doc, closed.selection.from).length, 0, "the caret left the toggle");
  assert.equal(closed.selection.from, 6, "at the end of the block before");
  // Arrowing (or clicking) into it opens it again.
  const back = closed.apply(closed.tr.setSelection(TextSelection.create(closed.doc, TOGGLE + 3)));
  assert.equal(isToggleClosed(back, TOGGLE), false);
  // Selecting the toggle as a whole does not open it.
  const again = flipAll(back);
  const selected = again.apply(again.tr.setSelection(NodeSelection.create(again.doc, TOGGLE)));
  assert.equal(isToggleClosed(selected, TOGGLE), true);
});

test("a toggle at the start of the document sends the caret after it", () => {
  const s0 = state(toggle({ title: "Mehr", blockId: "first123" }, p("Geheim")), p("Ende"));
  const inside = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, 3)));
  const closed = flipAll(inside, 0);
  assert.equal(isToggleClosed(closed, 0), true);
  assert.equal(closed.doc.resolve(closed.selection.from).parent.textContent, "Ende");
});

test("↑ at the very start of a toggle's content goes to its title", () => {
  const s0 = sample();
  const start = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, TOGGLE + 2)));
  assert.equal(titleAbove(start), TOGGLE);
  const later = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, TOGGLE + 4)));
  assert.equal(titleAbove(later), null);
  const second = s0.apply(s0.tr.setSelection(TextSelection.create(s0.doc, TOGGLE + 10)));
  assert.equal(titleAbove(second), null);
});
