import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
const { documentSchema } = await import("../lib/document-schema");
const { suggestTransaction, suggestionGroups, resolveSuggestions } = await import("../lib/suggestions");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { prosemirrorJSONToYDoc } = await import("y-prosemirror");

const schema = documentSchema();
const anna = { id: "anna", name: "Anna" };
const start = (text: string) =>
  EditorState.create({ doc: schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]) });
// Applies a change as if typed while suggesting (the plugin's append step).
function edit(state: EditorState, change: (s: EditorState) => ReturnType<EditorState["tr"]["insertText"]>, key = "") {
  const tr = change(state);
  const next = state.apply(tr);
  const extra = suggestTransaction([tr], state, next, anna, key);
  return extra ? next.apply(extra) : next;
}
const text = (s: EditorState) => s.doc.textContent;

test("typed text is marked as a suggested insertion", () => {
  let s = start("Hallo Welt");
  s = edit(s, (st) => st.tr.insertText(" schöne", 6 - 0));
  const groups = suggestionGroups(s.doc);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "insert");
  assert.equal(groups[0].text, " schöne");
  // Typing on continues the same suggestion.
  s = edit(s, (st) => st.tr.insertText("!", groups[0].to));
  assert.equal(suggestionGroups(s.doc).length, 1);
  assert.equal(suggestionGroups(s.doc)[0].text, " schöne!");
});

test("deleted text stays, struck through; the caret moves on with Backspace", () => {
  let s = start("Hallo Welt");
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 11)));
  s = edit(s, (st) => st.tr.delete(10, 11), "Backspace");
  assert.equal(text(s), "Hallo Welt", "nothing is lost");
  const groups = suggestionGroups(s.doc);
  assert.deepEqual([groups[0].kind, groups[0].text], ["delete", "t"]);
  assert.equal(s.selection.from, 10, "caret before the struck letter");
  s = edit(s, (st) => st.tr.delete(9, 10), "Backspace");
  const again = suggestionGroups(s.doc);
  assert.equal(again.length, 1, "one deletion grows");
  assert.equal(again[0].text, "lt");
});

test("deleting your own suggested text removes it for real", () => {
  let s = start("Hallo");
  s = edit(s, (st) => st.tr.insertText(" du", 6));
  assert.equal(text(s), "Hallo du");
  s = edit(s, (st) => st.tr.delete(6, 9), "Backspace");
  assert.equal(text(s), "Hallo");
  assert.equal(suggestionGroups(s.doc).length, 0);
});

test("typing over a selection suggests the replacement", () => {
  let s = start("Termin am Montag");
  s = edit(s, (st) => st.tr.insertText("Dienstag", 11, 17));
  assert.equal(text(s), "Termin am MontagDienstag");
  const groups = suggestionGroups(s.doc);
  assert.deepEqual(groups.map((g) => [g.kind, g.text]), [["delete", "Montag"], ["insert", "Dienstag"]]);
});

test("accepting and rejecting", () => {
  let s = start("Termin am Montag");
  s = edit(s, (st) => st.tr.insertText("Dienstag", 11, 17));
  const accepted = s.apply(resolveSuggestions(s, true, () => true));
  assert.equal(text(accepted), "Termin am Dienstag");
  assert.equal(suggestionGroups(accepted.doc).length, 0);
  const rejected = s.apply(resolveSuggestions(s, false, () => true));
  assert.equal(text(rejected), "Termin am Montag");
  // One group at a time.
  const [del] = suggestionGroups(s.doc);
  const partly = s.apply(resolveSuggestions(s, true, (a) => a.id === del.id && a.kind === "delete"));
  assert.equal(text(partly), "Termin am Dienstag");
  assert.equal(suggestionGroups(partly.doc)[0].kind, "insert");
});

test("suggestions survive saving as HTML", () => {
  let s = start("Hallo");
  s = edit(s, (st) => st.tr.insertText(" Welt", 6));
  const html = s.doc.toJSON();
  const ydoc = prosemirrorJSONToYDoc(schema, html, "default");
  const saved = stateHtml(ydoc);
  assert.match(saved, /data-suggestion="insert"/);
  assert.match(saved, /data-suggestion-name="Anna"/);
  const back = new Y.Doc();
  Y.applyUpdate(back, htmlState(saved));
  assert.match(stateHtml(back), /data-suggestion-author="anna"/);
});
