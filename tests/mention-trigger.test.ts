// When "@" in a document opens the mention dialog (lib/mention-trigger.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { atOpensMention, typedMenu } from "../lib/mention-trigger";

const schema = documentSchema();
const p = (...content: (string | Node)[]) => schema.nodes.paragraph.create(null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));
// The cursor at the end of the paragraph's content.
const at = (paragraph: Node) => {
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const state = EditorState.create({ schema, doc });
  return atOpensMention(state.apply(state.tr.setSelection(TextSelection.create(doc, 1 + paragraph.content.size))));
};

test("“@” opens the mention dialog at the start of a line, after a space or an opening bracket or quote", () => {
  assert.equal(at(p()), true);
  assert.equal(at(p("Hallo ")), true);
  assert.equal(at(p("Hallo ")), true);
  assert.equal(at(p("siehe (")), true);
  assert.equal(at(p("„")), true);
  assert.equal(at(p("\"")), true);
  assert.equal(at(p("a", schema.nodes.hardBreak.create())), true);
});

test("after a letter or digit – an e-mail address – “@” is typed", () => {
  assert.equal(at(p("ada")), false);
  assert.equal(at(p("Mail an a")), false);
  assert.equal(at(p("user42")), false);
  assert.equal(at(p("Zoë")), false);
  assert.equal(at(p("first.last")), false);
  assert.equal(at(p("first_")), false);
});

// Android's on-screen keyboards (#207): keydown names the key
// "Unidentified" and "@" or "/" arrive as text input – committed or inside
// an IME composition. Then the text opens the menus; after keydown "@" or
// "/" the key did.
const typed = (paragraph: Node, text: string, lastKey = "Unidentified", code = false) => {
  const block = code ? schema.nodes.codeBlock.create(null, paragraph.content) : paragraph;
  const doc = schema.nodes.doc.create(null, [block]);
  const end = 1 + block.content.size;
  return typedMenu(EditorState.create({ schema, doc }), end, end, text, lastKey);
};

test("“@” and “/” typed as text by an Android keyboard open the mention dialog and the slash menu", () => {
  assert.equal(typed(p(), "@"), "mention");
  assert.equal(typed(p("Hallo "), "@"), "mention");
  assert.equal(typed(p("Hallo "), "@", "Process"), "mention");
  assert.equal(typed(p("siehe ("), "@"), "mention");
  assert.equal(typed(p("Hallo "), "/"), "slash");
  assert.equal(typed(p(), "/"), "slash");
});

test("typed as text, “@” in a word, in code, other text, or after the key itself opens nothing", () => {
  assert.equal(typed(p("ada"), "@"), null);
  assert.equal(typed(p("Hallo "), "@", "@"), null);
  assert.equal(typed(p("Hallo "), "/", "/"), null);
  assert.equal(typed(p("Hallo "), "@@"), null);
  assert.equal(typed(p("Hallo "), "a"), null);
  assert.equal(typed(p("x "), "@", "Unidentified", true), null);
  assert.equal(typed(p("x "), "/", "Unidentified", true), null);
});
