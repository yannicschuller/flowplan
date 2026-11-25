// Formulas from the keyboard (#541): what Backspace, Delete and the arrow
// keys do right beside a formula (lib/math-keys.ts), and when the keys in
// the formula's field leave it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { mathKeyAction, mathLeaveSide } from "../lib/math-keys";

const schema = documentSchema();
const p = (...content: Node[]) => schema.nodes.paragraph.create(null, content);
const text = (value: string) => schema.text(value);
const inline = (expression: string) => schema.nodes.mathInline.create({ expression });
const block = (expression: string) => schema.nodes.mathBlock.create({ expression });
const at = (doc: Node, pos: number) => EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });
const key = (k: string, extra = {}) => ({ key: k, ...extra });

// "ab" + formula + "cd": a at 1, formula at 3, c at 4.
const line = schema.nodes.doc.create(null, [p(text("ab"), inline("a<0"), text("cd"))]);

test("Backspace after an inline formula opens it at its end; Delete before it at its start", () => {
  assert.deepEqual(mathKeyAction(at(line, 4), key("Backspace")), { type: "mathInline", pos: 3, expression: "a<0", caret: "end" });
  assert.deepEqual(mathKeyAction(at(line, 3), key("Delete")), { type: "mathInline", pos: 3, expression: "a<0", caret: "start" });
  assert.equal(mathKeyAction(at(line, 3), key("Backspace")), null, "before the formula: text is deleted");
  assert.equal(mathKeyAction(at(line, 4), key("Delete")), null);
  assert.equal(mathKeyAction(at(line, 5), key("Backspace")), null);
});

test("the arrow keys move into an inline formula, not with modifiers or a selection", () => {
  assert.equal(mathKeyAction(at(line, 4), key("ArrowLeft"))?.caret, "end");
  assert.equal(mathKeyAction(at(line, 3), key("ArrowRight"))?.caret, "start");
  assert.equal(mathKeyAction(at(line, 3), key("ArrowLeft")), null);
  assert.equal(mathKeyAction(at(line, 4), key("ArrowRight")), null);
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
    assert.equal(mathKeyAction(at(line, 4), key("ArrowLeft", { [modifier]: true })), null, modifier);
    assert.equal(mathKeyAction(at(line, 4), key("Backspace", { [modifier]: true })), null, modifier);
  }
  const range = EditorState.create({ schema, doc: line, selection: TextSelection.create(line, 2, 4) });
  assert.equal(mathKeyAction(range, key("Backspace")), null);
  // A formula selected as a node is deleted as before.
  const selected = EditorState.create({ schema, doc: line, selection: NodeSelection.create(line, 3) });
  assert.equal(mathKeyAction(selected, key("Backspace")), null);
});

// "ab" (0–4), formula block at 4 (size 1), "cd" at 5–9.
const blocks = schema.nodes.doc.create(null, [p(text("ab")), block("x^2"), p(text("cd"))]);

test("formula blocks: Backspace at the start below, Delete at the end above", () => {
  assert.deepEqual(mathKeyAction(at(blocks, 6), key("Backspace")), { type: "mathBlock", pos: 4, expression: "x^2", caret: "end" });
  assert.deepEqual(mathKeyAction(at(blocks, 3), key("Delete")), { type: "mathBlock", pos: 4, expression: "x^2", caret: "start" });
  assert.equal(mathKeyAction(at(blocks, 7), key("Backspace")), null, "not at the block's start");
  assert.equal(mathKeyAction(at(blocks, 2), key("Delete")), null, "not at the block's end");
  assert.equal(mathKeyAction(at(blocks, 1), key("Backspace")), null, "nothing above");
});

test("formula blocks: ArrowUp on the first line below, ArrowDown on the last line above", () => {
  const edge = () => true,
    inside = () => false;
  assert.equal(mathKeyAction(at(blocks, 7), key("ArrowUp"), edge)?.caret, "end");
  assert.equal(mathKeyAction(at(blocks, 7), key("ArrowUp"), edge)?.pos, 4);
  assert.equal(mathKeyAction(at(blocks, 2), key("ArrowDown"), edge)?.caret, "start");
  assert.equal(mathKeyAction(at(blocks, 7), key("ArrowUp"), inside), null, "not the first line");
  assert.equal(mathKeyAction(at(blocks, 2), key("ArrowUp"), edge), null, "nothing above");
  assert.equal(mathKeyAction(at(blocks, 7), key("ArrowDown"), edge), null, "nothing below");
  assert.equal(mathKeyAction(at(blocks, 7), key("ArrowUp")), null, "without the view's answer");
  assert.equal(mathKeyAction(at(blocks, 3), key("ArrowRight")), null, "left/right: inline formulas only");
});

test("the keys in the formula's field leave it at its edges", () => {
  assert.equal(mathLeaveSide("a<0", 0, 0, key("ArrowLeft"), false), "before");
  assert.equal(mathLeaveSide("a<0", 3, 3, key("ArrowRight"), false), "after");
  assert.equal(mathLeaveSide("a<0", 1, 1, key("ArrowLeft"), false), null);
  assert.equal(mathLeaveSide("a<0", 2, 2, key("ArrowRight"), false), null);
  assert.equal(mathLeaveSide("a<0", 0, 3, key("ArrowLeft"), false), null, "a selection");
  assert.equal(mathLeaveSide("a<0", 3, 3, key("ArrowRight", { shiftKey: true }), false), null);
  assert.equal(mathLeaveSide("a<0", 1, 1, key("ArrowUp"), false), null, "inline: up/down stay");
  assert.equal(mathLeaveSide("x\ny", 1, 1, key("ArrowUp"), true), "before");
  assert.equal(mathLeaveSide("x\ny", 3, 3, key("ArrowUp"), true), null, "second line");
  assert.equal(mathLeaveSide("x\ny", 3, 3, key("ArrowDown"), true), "after");
  assert.equal(mathLeaveSide("x\ny", 1, 1, key("ArrowDown"), true), null, "first line");
});
