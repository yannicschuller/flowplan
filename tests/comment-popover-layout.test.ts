// Where a text comment's popover and the hover preview go (#450,
// lib/comment-popover-layout.ts), and the count after a passage
// (lib/inline-comment-plugin.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeCommentPopover, shortComment, unionBox } from "../lib/comment-popover-layout";
import { commentCount, lastTextPosition } from "../lib/inline-comment-plugin";
import { COMMENT_COLORS } from "../lib/comment-colors";
import { BLOCK_COLOR_NAMES } from "../lib/block-colors";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

const viewport = { left: 0, top: 0, right: 1100, bottom: 800 };
const size = { width: 340, height: 300 };

test("beside the text column where the window has room, at the passage's height", () => {
  const p = placeCommentPopover({
    passage: { left: 300, top: 200, right: 360, bottom: 220 },
    text: { left: 100, top: 0, right: 700, bottom: 2000 },
    size,
    viewport,
  });
  assert.equal(p.side, "beside");
  assert.equal(p.left, 708);
  assert.equal(p.top, 200);
});

test("below the passage when there is no room beside, clamped into the window", () => {
  const p = placeCommentPopover({
    passage: { left: 900, top: 200, right: 960, bottom: 220 },
    text: { left: 100, top: 0, right: 1000, bottom: 2000 },
    size,
    viewport,
  });
  assert.equal(p.side, "below");
  assert.equal(p.top, 228);
  assert.equal(p.left, 1100 - 8 - 340);
});

test("above the passage when below is too small and above has more room", () => {
  const p = placeCommentPopover({
    passage: { left: 50, top: 700, right: 120, bottom: 720 },
    size,
    viewport,
    beside: false,
  });
  assert.equal(p.side, "above");
  assert.equal(p.top, 700 - 8 - 300);
  assert.ok(p.maxHeight >= 300);
});

test("a tall popover below gets a scrolling height instead of leaving the window", () => {
  const p = placeCommentPopover({
    passage: { left: 50, top: 300, right: 120, bottom: 320 },
    size: { width: 300, height: 900 },
    viewport,
    beside: false,
  });
  assert.equal(p.side, "below");
  assert.equal(p.maxHeight, 800 - 8 - 328);
});

test("the union of a passage's lines; empty boxes do not count", () => {
  assert.deepEqual(
    unionBox([
      { left: 300, top: 100, right: 600, bottom: 120, width: 300, height: 20 },
      { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      { left: 100, top: 120, right: 200, bottom: 140, width: 100, height: 20 },
    ]),
    { left: 100, top: 100, right: 600, bottom: 140 },
  );
  assert.equal(unionBox([]), null);
});

test("the preview shortens the first comment at a word", () => {
  assert.equal(shortComment("  short\n text "), "short text");
  const long = "word ".repeat(60);
  const short = shortComment(long, 40);
  assert.ok(short.length <= 40);
  assert.ok(short.endsWith("…"));
  assert.ok(!short.includes("wor…"));
});

test("the count after a passage: every message, none for a new comment; on the last letter", () => {
  assert.equal(commentCount({ messageCount: 0 }), "");
  assert.equal(commentCount({ messageCount: 1 }), "1");
  assert.equal(commentCount({ messageCount: 12 }), "12");
  assert.equal(commentCount({ messageCount: 140 }), "99+");
  const schema = getSchema([StarterKit]);
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Alpha Bravo" }] },
      { type: "paragraph" },
    ],
  });
  // "Bravo" is 7…12; a passage over the empty paragraph ends at the text.
  assert.equal(lastTextPosition(doc, 7, 12), 12);
  assert.equal(lastTextPosition(doc, 1, doc.content.size), 12);
  assert.equal(lastTextPosition(doc, 13, 15), null);
});

test("thread colours are the text background colours", () => {
  assert.deepEqual([...COMMENT_COLORS], [...BLOCK_COLOR_NAMES]);
});
