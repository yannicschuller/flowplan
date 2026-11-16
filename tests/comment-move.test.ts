import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { EditorState } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { updateYFragment } from "@tiptap/y-tiptap";
import { documentSchema } from "../lib/document-schema";
import {
  adjacentBlockTarget,
  BLOCK_MOVE_META,
  changeBlocks,
  documentBlocks,
} from "../lib/document-blocks";
import {
  commentAnchor,
  commentQuote,
  commentRange,
  movedCommentRange,
  sameCommentQuote,
  type BlockMove,
  type CommentBinding,
} from "../lib/comment-positions";
import type { CommentAnchor } from "../lib/inline-comment-types";

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const G = "generation";

// A Yjs document bound to ProseMirror content the way the editor's sync
// plugin does it: every change goes through y-tiptap's updateYFragment.
function collaborative(doc: Node) {
  const ydoc = new Y.Doc(),
    type = ydoc.getXmlFragment("default"),
    meta = { mapping: new Map(), isOMark: new Map() } as unknown as Parameters<
      typeof updateYFragment
    >[3];
  let state = EditorState.create({ schema, doc });
  const sync = () =>
    ydoc.transact(() => updateYFragment(ydoc, type, state.doc, meta));
  sync();
  const binding = (): CommentBinding => ({
    doc: ydoc,
    type,
    mapping: (meta as unknown as { mapping: CommentBinding["mapping"] }).mapping,
    content: state.doc,
  });
  return {
    get state() {
      return state;
    },
    binding,
    // Moves the block holding `text` like the toolbar's arrows
    // (lib/block-shortcuts.ts moveSelectedBlock) and hands back the
    // anchors that followed the move, as the editor does (#314).
    move(text: string, direction: -1 | 1, anchors: Map<string, CommentAnchor>) {
      // The innermost block with this text (a list item, not its list).
      const block = documentBlocks(state.doc).filter(
        (b) => b.node.textContent === text,
      ).at(-1)!;
      const target = adjacentBlockTarget(state, [block.pos], direction)!,
        tr = changeBlocks(state, [block.pos], "move", target),
        move = tr.getMeta(BLOCK_MOVE_META) as BlockMove;
      const before = binding(),
        ranges = new Map(
          [...anchors].map(([id, a]) => {
            const range = commentRange(before, a, G)!;
            return [id, movedCommentRange(state.doc, tr.doc, tr.mapping, move, range)];
          }),
        );
      state = state.apply(tr);
      sync();
      const after = binding(),
        broken = [...anchors].filter(([, a]) => !commentRange(after, a, G)).map(([id]) => id);
      const next = new Map(
        [...ranges].map(([id, r]) => {
          assert.ok(r, `${id} has a place after the move`);
          return [id, commentAnchor(after, r.from, r.to, G)];
        }),
      );
      return { broken, anchors: next };
    },
  };
}
const quoteOf = (binding: CommentBinding, anchor: CommentAnchor) => {
  const r = commentRange(binding, anchor, G);
  return r ? commentQuote(binding.content, r.from, r.to) : null;
};

test("comments follow blocks moved up and down; without that their anchors break (#314)", () => {
  const c = collaborative(
    schema.nodes.doc.create(null, [p("Alpha one"), p("Bravo two"), p("Charlie three")]),
  );
  const at = (text: string, word: string) => {
    const block = documentBlocks(c.state.doc).find((b) => b.node.textContent === text)!;
    const from = block.pos + 1 + text.indexOf(word);
    return commentAnchor(c.binding(), from, from + word.length, G);
  };
  let anchors = new Map([
    ["alpha", at("Alpha one", "Alpha")],
    ["bravo", at("Bravo two", "two")],
    ["charlie", at("Charlie three", "Charlie three")],
  ]);
  const quotes = { alpha: "Alpha", bravo: "two", charlie: "Charlie three" };
  for (const [text, direction] of [
    ["Bravo two", -1],
    ["Bravo two", 1],
    ["Bravo two", 1],
    ["Charlie three", -1],
    ["Alpha one", 1],
  ] as const) {
    const moved = c.move(text, direction, anchors);
    // The bug: Yjs deletes and re-inserts a moved block, so a stored
    // anchor inside it (or inside its swapped neighbour) no longer resolves.
    assert.ok(moved.broken.length > 0, `moving “${text}” breaks a stored anchor`);
    anchors = moved.anchors;
    for (const [id, anchor] of anchors)
      assert.equal(quoteOf(c.binding(), anchor), quotes[id as keyof typeof quotes]);
  }
  assert.deepEqual(
    documentBlocks(c.state.doc).map((b) => b.node.textContent),
    ["Charlie three", "Bravo two", "Alpha one"],
  );
});

test("a whole-block comment and passages around a moved list item follow it", () => {
  const item = (text: string) => schema.nodes.listItem.create(null, p(text));
  const c = collaborative(
    schema.nodes.doc.create(null, [
      p("Intro"),
      schema.nodes.bulletList.create(null, [item("First"), item("Second")]),
    ]),
  );
  let second = -1;
  c.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "Second") second = pos;
  });
  let anchors = new Map([
    // The paragraph as a block (a comment on the current block).
    ["block", commentAnchor(c.binding(), second, second + 8, G)],
    ["intro", commentAnchor(c.binding(), 1, 6, G)],
  ]);
  anchors = c.move("Second", -1, anchors).anchors;
  assert.equal(quoteOf(c.binding(), anchors.get("block")!), "Second");
  assert.equal(quoteOf(c.binding(), anchors.get("intro")!), "Intro");
  assert.deepEqual(
    documentBlocks(c.state.doc)
      .filter((b) => b.node.type.name === "listItem")
      .map((b) => b.node.textContent),
    ["Second", "First"],
  );
});

test("moved passages must keep their text and may not straddle the moved blocks", () => {
  const s = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [p("One"), p("Two"), p("Three")]),
  });
  const blocks = documentBlocks(s.doc),
    tr = changeBlocks(s, [blocks[1].pos], "move", blocks[0].pos),
    move = tr.getMeta(BLOCK_MOVE_META) as BlockMove;
  // "One" + "Two" spans the moved block's edge: no exact place afterwards.
  assert.equal(
    movedCommentRange(s.doc, tr.doc, tr.mapping, move, { from: 2, to: blocks[1].pos + 3 }),
    null,
  );
  const two = movedCommentRange(s.doc, tr.doc, tr.mapping, move, {
    from: blocks[1].pos + 1,
    to: blocks[1].pos + 4,
  })!;
  assert.equal(commentQuote(tr.doc, two.from, two.to), "Two");
  const three = movedCommentRange(s.doc, tr.doc, tr.mapping, move, {
    from: blocks[2].pos + 1,
    to: blocks[2].pos + 6,
  })!;
  assert.equal(commentQuote(tr.doc, three.from, three.to), "Three");
});

test("quotes keep hard line breaks as line breaks and old quotes still match", () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text("Text 3"),
      schema.nodes.hardBreak.create(),
      schema.text("Text 4"),
    ]),
    schema.nodes.paragraph.create(null, [
      schema.text("See "),
      schema.nodes.mathInline.create({ expression: "x" }),
    ]),
  ]);
  const end = doc.content.size;
  assert.equal(commentQuote(doc, 0, end), "Text 3\nText 4\nSee ￼");
  // Stored before this change: the hard break as U+FFFC.
  assert.ok(sameCommentQuote(doc, 0, end, "Text 3￼Text 4\nSee ￼"));
  assert.ok(sameCommentQuote(doc, 0, end, "Text 3\nText 4\nSee ￼"));
  assert.ok(!sameCommentQuote(doc, 0, end, "Text 3 Text 4"));
});
