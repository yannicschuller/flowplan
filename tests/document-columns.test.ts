import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { DOMParser as PMParser } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { columnBlocks, documentBlocks } from "../lib/document-blocks";
import { Window } from "happy-dom";

const schema = documentSchema();
function state(html: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  const doc = PMParser.fromSchema(schema).parse(
    window.document.body as unknown as HTMLElement,
  );
  return EditorState.create({ schema, doc });
}
const find = (s: EditorState, text: string) =>
  documentBlocks(s.doc).find(
    (b) => b.node.type.name === "paragraph" && b.node.textContent === text,
  )!.pos;
const shape = (s: EditorState) =>
  JSON.stringify(
    s.doc.toJSON().content.map(function map(n: any): unknown {
      if (n.type === "paragraph") return n.content?.[0]?.text ?? "";
      return { [n.type]: (n.content || []).map(map) };
    }),
  );

test("dropping a block beside another creates or extends columns", () => {
  let s = state("<p>A</p><p>B</p><p>C</p>");
  s = s.apply(columnBlocks(s, [find(s, "C")], find(s, "A"), "right"));
  assert.equal(
    shape(s),
    JSON.stringify([{ columns: [{ column: ["A"] }, { column: ["C"] }] }, "B"]),
  );
  // A third column next to an existing one; left of the target column.
  s = s.apply(columnBlocks(s, [find(s, "B")], find(s, "C"), "left"));
  assert.equal(
    shape(s),
    JSON.stringify([
      { columns: [{ column: ["A"] }, { column: ["B"] }, { column: ["C"] }] },
    ]),
  );
  // No fourth column.
  const more = state(
    '<div data-columns="true"><div data-column="true"><p>A</p></div><div data-column="true"><p>B</p></div><div data-column="true"><p>C</p></div></div><p>D</p>',
  );
  assert.throws(
    () => columnBlocks(more, [find(more, "D")], find(more, "A"), "right"),
    /Höchstens 3/,
  );
});

test("column drops keep documents valid", () => {
  const s = state(
    '<div data-columns="true"><div data-column="true"><p>A</p></div><div data-column="true"><p>B</p></div></div><p>C</p>',
  );
  // Moving a column's only block removes the column; one column dissolves.
  const moved = s.apply(columnBlocks(s, [find(s, "A")], find(s, "C"), "right"));
  assert.equal(
    shape(moved),
    JSON.stringify(["B", { columns: [{ column: ["C"] }, { column: ["A"] }] }]),
  );
  // A block cannot be placed beside itself.
  assert.throws(() => columnBlocks(s, [find(s, "C")], find(s, "C"), "left"));
  // Dropping beside the whole layout adds a column at its edge.
  const layout = documentBlocks(s.doc).find(
    (b) => b.node.type.name === "columns",
  )!;
  const next = s.apply(columnBlocks(s, [find(s, "C")], layout.pos, "left"));
  assert.equal(
    shape(next),
    JSON.stringify([
      { columns: [{ column: ["C"] }, { column: ["A"] }, { column: ["B"] }] },
    ]),
  );

  // Within one layout a whole column only changes its place.
  const three = state(
    '<div data-columns="true"><div data-column="true"><p>A</p></div><div data-column="true"><p>B</p></div><div data-column="true"><p>C</p></div></div>',
  );
  const reordered = three.apply(
    columnBlocks(three, [find(three, "A")], find(three, "C"), "right"),
  );
  assert.equal(
    shape(reordered),
    JSON.stringify([
      { columns: [{ column: ["B"] }, { column: ["C"] }, { column: ["A"] }] },
    ]),
  );
});
