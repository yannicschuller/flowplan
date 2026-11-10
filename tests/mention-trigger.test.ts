// When "@" in a document opens the mention dialog (lib/mention-trigger.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { atOpensMention } from "../lib/mention-trigger";

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
