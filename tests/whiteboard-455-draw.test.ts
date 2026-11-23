import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOpacity, cleanPenSettings, DEFAULT_PEN, HIGHLIGHTER_OPACITY, strokeLook, strokeProps } from "../lib/whiteboard-pen";
import { ownColorProps, ownColorSet, ownColorsFor, withOwnColor, withOwnColors } from "../lib/whiteboard-own-colors";
import { COLLAPSED_HEIGHT, collapseMembers, foldersOf, foldView, isCollapsed, unfoldForCopy } from "../lib/whiteboard-collapse";
import { DARK_PALETTE, LIGHT_PALETTE } from "../lib/whiteboard-display-colors";
import { whiteboardSvg } from "../lib/whiteboard-svg";
import { boardExtras } from "../lib/whiteboard-embeds";
import { cleanTemplateItems } from "../lib/whiteboard-user-templates";
import type { WhiteboardItem } from "../lib/whiteboard-model";

// #455: pen opacity and highlighter, own colours with the colour wheel,
// collapsible frames.

const item = (props: Partial<WhiteboardItem> & Pick<WhiteboardItem, "id" | "type">): WhiteboardItem => ({ x: 0, y: 0, w: 10, h: 10, z: 0, ...props });
const ctx = { image: (src: string) => src, page: () => null, record: () => null, label: (_de: string, en: string) => en };

test("pen settings: cleaned, remembered per kind, the old width carried over", () => {
  assert.deepEqual(cleanPenSettings(null), DEFAULT_PEN);
  assert.equal(cleanPenSettings(null, "5").pen.width, 5);
  assert.equal(cleanPenSettings(null, "7").pen.width, 3);
  const s = cleanPenSettings({ mode: "highlighter", pen: { color: "#ABCDEF", width: 2, opacity: 0.5 }, highlighter: { color: "red", width: 99, opacity: 3 } });
  assert.equal(s.mode, "highlighter");
  assert.deepEqual(s.pen, { color: "#abcdef", width: 2, opacity: 0.5 });
  assert.deepEqual(s.highlighter, { color: DEFAULT_PEN.highlighter.color, width: DEFAULT_PEN.highlighter.width, opacity: 1 });
  assert.equal(cleanPenSettings({ mode: "laser" }).mode, "pen");
});

test("pen opacity: 10–100 % in steps of 5, stored per stroke", () => {
  assert.equal(cleanOpacity(0.33), 0.35);
  assert.equal(cleanOpacity(0), 0.1);
  assert.equal(cleanOpacity(7), 1);
  assert.equal(cleanOpacity("0.5"), 1);
  assert.deepEqual(strokeProps(DEFAULT_PEN), { stroke: "#1f2937", strokeWidth: 3 });
  assert.deepEqual(strokeProps({ ...DEFAULT_PEN, mode: "highlighter" }), { stroke: "#ffd43b", strokeWidth: 20, opacity: HIGHLIGHTER_OPACITY, highlight: true });
  assert.deepEqual(strokeLook({}), { highlight: false });
  assert.deepEqual(strokeLook({ opacity: 0.5, highlight: true }), { opacity: 0.5, highlight: true });
  assert.deepEqual(strokeLook({ opacity: 1 }), { highlight: false });
});

test("own colours: listed on the element, shown as chosen on the dark canvas only", () => {
  const note = item({ id: "n", type: "sticky", fill: "#123456", ownColors: ["#123456", "#abcdef"] });
  // The old fill is replaced, a colour no longer used is dropped.
  assert.deepEqual(withOwnColor(note, "fill", "#FF0000"), ["#ff0000"]);
  assert.deepEqual(ownColorProps({ ...note, textColor: "#abcdef" }, "fill", "#00FF00"), { fill: "#00ff00", ownColors: ["#00ff00", "#abcdef"] });
  assert.deepEqual(ownColorsFor("#1f2937", ["#1F2937"]), undefined);
  assert.deepEqual(ownColorsFor("#0A0A0A", ["#1f2937"]), ["#0a0a0a"]);
  const own = ownColorSet([note, item({ id: "x", type: "text", ownColors: ["nope", "#000000"] })]);
  assert.deepEqual([...own].sort(), ["#000000", "#123456", "#abcdef"]);
  const palette = withOwnColors(DARK_PALETTE, own);
  assert.equal(palette.ink("#000000"), "#000000");
  assert.equal(palette.fill("#ABCDEF"), "#ABCDEF");
  assert.equal(palette.text("#000000", "#16151b"), "#000000");
  assert.notEqual(palette.ink("#111111"), "#111111", "other dark ink is still mapped");
  assert.equal(withOwnColors(LIGHT_PALETTE, own), LIGHT_PALETTE);
});

// A frame with a note, a nested frame with a pen stroke, a connector inside
// and one to a shape outside.
function board(): WhiteboardItem[] {
  return [
    item({ id: "F", type: "frame", x: 0, y: 0, w: 400, h: 300, z: -2, text: "Outer" }),
    item({ id: "G", type: "frame", x: 200, y: 100, w: 150, h: 150, z: -1 }),
    item({ id: "note", type: "sticky", x: 20, y: 20, w: 100, h: 80, z: 1, text: "Inside" }),
    item({ id: "pen", type: "pen", x: 220, y: 120, w: 50, h: 50, z: 2, points: [0, 0, 1, 1] }),
    item({ id: "in", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 3, from: { id: "note", x: 0, y: 0 }, to: { id: "pen", x: 0, y: 0 } }),
    item({ id: "out", type: "shape", x: 600, y: 20, w: 100, h: 80, z: 4 }),
    item({ id: "link", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 5, from: { id: "note", x: 0, y: 0 }, to: { id: "out", x: 0, y: 0 } }),
  ];
}
const ids = (list: WhiteboardItem[]) => list.map((i) => i.id).sort();

test("a collapsed frame hides what lies in it, nested frames too", () => {
  const all = board();
  assert.deepEqual(collapseMembers(all[0], all).sort(), ["G", "in", "note", "pen"]);
  assert.equal(foldView(all).items, all, "nothing collapsed: the items as they are");
  const folded = all.map((i) => (i.id === "F" ? { ...i, collapsed: collapseMembers(i, all) } : i));
  const view = foldView(folded);
  assert.deepEqual(ids(view.items), ["F", "link", "out"]);
  const frame = view.items.find((i) => i.id === "F")!;
  assert.equal(frame.h, COLLAPSED_HEIGHT);
  assert.equal(frame.x, 0);
  assert.ok(isCollapsed(frame));
  // The connector to the hidden note ends at the collapsed frame.
  const link = view.items.find((i) => i.id === "link")!;
  assert.equal(link.from?.id, "F");
  assert.equal(link.to?.id, "out");
  assert.equal(view.hiddenIn.get("pen"), "F");
  assert.equal(view.hiddenIn.get("in"), "F");
  // Both collapsed: the inner one is hidden in the outer one.
  const both = folded.map((i) => (i.id === "G" ? { ...i, collapsed: collapseMembers(i, folded) } : i));
  const nested = foldView(both);
  assert.deepEqual(ids(nested.items), ["F", "link", "out"]);
  assert.equal(nested.hiddenIn.get("pen"), "F");
  assert.deepEqual(foldersOf("pen", nested, new Map(both.map((i) => [i.id, i]))), ["F", "G"]);
  // Only the inner one collapsed.
  const inner = foldView(all.map((i) => (i.id === "G" ? { ...i, collapsed: ["pen"] } : i)));
  assert.deepEqual(ids(inner.items), ["F", "G", "in", "link", "note", "out"]);
  const connector = inner.items.find((i) => i.id === "in")!;
  assert.equal(connector.to?.id, "G", "the connector to the hidden stroke ends at the collapsed frame");
  assert.equal(connector.from?.id, "note");
});

test("collapsed frames: drop-ins stay visible, moved-out elements show again, viewers fold for themselves", () => {
  const all = board();
  const folded = all.map((i) => (i.id === "F" ? { ...i, collapsed: ["note"] } : i));
  // The stroke was not listed when the frame was collapsed: it stays.
  assert.ok(foldView(folded).items.some((i) => i.id === "pen"));
  assert.ok(!foldView(folded).items.some((i) => i.id === "note"));
  const moved = folded.map((i) => (i.id === "note" ? { ...i, x: 900 } : i));
  assert.ok(foldView(moved).items.some((i) => i.id === "note"));
  // Shown open for one viewer; folded for one viewer.
  const open = foldView(folded, new Map([["F", true]]));
  assert.ok(open.items.some((i) => i.id === "note"));
  assert.equal(open.items.find((i) => i.id === "F")?.collapsed, undefined);
  const mine = foldView(all, new Map([["G", false]]));
  assert.ok(!mine.items.some((i) => i.id === "pen"));
});

test("copies of a collapsed frame take what it hides", () => {
  const all = board();
  const folded = all.map((i) => (i.id === "F" ? { ...i, collapsed: collapseMembers(i, all) } : i));
  const view = foldView(folded);
  const byId = new Map(folded.map((i) => [i.id, i]));
  const copy = unfoldForCopy([view.items.find((i) => i.id === "F")!], view, byId);
  assert.deepEqual(ids(copy), ["F", "G", "in", "note", "pen"]);
  assert.equal(copy.find((i) => i.id === "F")!.h, 300, "at full height");
});

test("exports: strokes with their opacity and highlighter, collapsed frames as their bar", () => {
  const svg = whiteboardSvg(
    [
      item({ id: "a", type: "pen", x: 0, y: 0, w: 100, h: 100, points: [0, 0, 1, 1], opacity: 0.35, highlight: true }),
      item({ id: "b", type: "pen", x: 0, y: 0, w: 100, h: 100, points: [0, 0, 1, 1], opacity: 7 as number }),
    ],
    ctx,
  )!;
  assert.match(svg, /opacity="0.35" style="mix-blend-mode:multiply"/);
  assert.equal((svg.match(/ opacity="/g) || []).length, 1, "invalid opacity is dropped");
  const all = board();
  const folded = all.map((i) => (i.id === "F" ? { ...i, collapsed: collapseMembers(i, all) } : i));
  const drawn = whiteboardSvg(folded, ctx)!;
  assert.match(drawn, /4 elements collapsed/);
  assert.doesNotMatch(drawn, /Inside/);
  assert.match(drawn, new RegExp(`height="${COLLAPSED_HEIGHT}"`));
});

test("the new properties are checked like the other newer ones", () => {
  assert.deepEqual(boardExtras({ opacity: 0.5, highlight: true, collapsed: ["a-1"], ownColors: ["#aabbcc"] }), { opacity: 0.5, highlight: true, collapsed: ["a-1"], ownColors: ["#aabbcc"] });
  assert.deepEqual(boardExtras({ opacity: 0, highlight: "yes" as unknown as boolean, collapsed: ["<x>"], ownColors: ["red"] }), {});
  const [stroke] = cleanTemplateItems([{ id: "p1", type: "pen", x: 0, y: 0, w: 1, h: 1, points: [0, 0], opacity: 0.5, highlight: true, ownColors: ["#010203"] }]);
  assert.equal(stroke.opacity, 0.5);
  assert.equal(stroke.highlight, true);
  assert.deepEqual(stroke.ownColors, ["#010203"]);
});
