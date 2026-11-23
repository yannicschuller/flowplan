// The "…" menu of a drawing block and its first-time height tip
// (lib/draw-block-actions.ts, #322, #324).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { drawBlockChange, drawBlockMoves, revealOffset, takeHeightTip, HEIGHT_TIP_KEY, REVEAL_MARGIN } from "../lib/draw-block-actions";

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const ink = (id: string) => schema.nodes.drawBlock.create({ id, page: "11111111-1111-1111-1111-111111111111", height: 500 });
const state = (...nodes: Node[]) => EditorState.create({ schema, doc: schema.nodes.doc.create(null, nodes) });
const names = (s: EditorState) => {
  const out: string[] = [];
  s.doc.forEach((n) => out.push(n.type.name === "drawBlock" ? `ink:${n.attrs.id}` : n.textContent));
  return out;
};
const posOf = (s: EditorState, id: string) => {
  let found = -1;
  s.doc.descendants((n, pos) => {
    if (n.type.name === "drawBlock" && n.attrs.id === id) found = pos;
  });
  return found;
};

test("a drawing block moves up and down among its siblings, not past the ends", () => {
  let s = state(p("A"), ink("ink-1"), p("B"));
  assert.deepEqual(drawBlockMoves(s, posOf(s, "ink-1")), { up: true, down: true });
  s = s.apply(drawBlockChange(s, posOf(s, "ink-1"), "up")!);
  assert.deepEqual(names(s), ["ink:ink-1", "A", "B"]);
  assert.deepEqual(drawBlockMoves(s, posOf(s, "ink-1")), { up: false, down: true });
  assert.equal(drawBlockChange(s, posOf(s, "ink-1"), "up"), null);
  s = s.apply(drawBlockChange(s, posOf(s, "ink-1"), "down")!);
  s = s.apply(drawBlockChange(s, posOf(s, "ink-1"), "down")!);
  assert.deepEqual(names(s), ["A", "B", "ink:ink-1"]);
  assert.deepEqual(drawBlockMoves(s, posOf(s, "ink-1")), { up: true, down: false });
  // The moved block keeps its ink id and height.
  assert.equal(s.doc.nodeAt(posOf(s, "ink-1"))!.attrs.height, 500);
});

test("duplicate gives the copy a fresh id that starts from the original's ink; delete removes the block", () => {
  let s = state(p("A"), ink("ink-1"), p("B"));
  s = s.apply(drawBlockChange(s, posOf(s, "ink-1"), "duplicate")!);
  const blocks: Node[] = [];
  s.doc.forEach((n) => n.type.name === "drawBlock" && blocks.push(n));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].attrs.id, "ink-1");
  assert.notEqual(blocks[1].attrs.id, "ink-1");
  assert.equal(blocks[1].attrs.from, "11111111-1111-1111-1111-111111111111/ink-1");
  assert.equal(blocks[1].attrs.height, 500);
  assert.equal(names(s)[2], `ink:${blocks[1].attrs.id}`);
  s = s.apply(drawBlockChange(s, posOf(s, "ink-1"), "delete")!);
  assert.deepEqual(names(s), ["A", `ink:${blocks[1].attrs.id}`, "B"]);
});

test("nothing happens for a position that is not a drawing block", () => {
  const s = state(p("A"), ink("ink-1"));
  assert.equal(drawBlockChange(s, 0, "delete"), null);
  assert.equal(drawBlockChange(s, 999, "duplicate"), null);
  assert.deepEqual(drawBlockMoves(s, 999), { up: false, down: false });
});

test("the height tip is taken once per device; failing storage shows none", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) };
  assert.equal(takeHeightTip(() => storage), true);
  assert.equal(values.get(HEIGHT_TIP_KEY), "1");
  assert.equal(takeHeightTip(() => storage), false);
  assert.equal(takeHeightTip(() => null), false);
  assert.equal(
    takeHeightTip(() => {
      throw new Error("SecurityError");
    }),
    false,
  );
  const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(takeHeightTip(() => full), false);
});

test("a new drawing block comes into view: fully when it fits, else its top at the top (#440)", () => {
  const area = { top: 100, bottom: 900 };
  const m = REVEAL_MARGIN;
  // In view: nothing moves.
  assert.equal(revealOffset({ top: 200, bottom: 600 }, area), 0);
  // Below the visible part (the view stayed on the line under it): down by
  // just enough for its bottom.
  assert.equal(revealOffset({ top: 700, bottom: 1100 }, area), 1100 - (900 - m));
  // Out of sight below altogether: the same, the block ends up at the bottom.
  assert.equal(revealOffset({ top: 1500, bottom: 1900 }, area), 1900 - (900 - m));
  // Above (under the top bar): up to the area's top.
  assert.equal(revealOffset({ top: 40, bottom: 400 }, area), 40 - (100 + m));
  // Taller than the area: its top at the area's top, from either side.
  assert.equal(revealOffset({ top: 500, bottom: 1500 }, area), 500 - (100 + m));
  assert.equal(revealOffset({ top: -300, bottom: 900 }, area), -300 - (100 + m));
  // An area shrunk by the keyboard to almost nothing: the top still shows.
  assert.equal(revealOffset({ top: 400, bottom: 500 }, { top: 100, bottom: 110 }), 400 - (100 + m));
});
