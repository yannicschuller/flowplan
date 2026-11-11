// #210: the text menu opens above a selection unless it would cover the
// formatting toolbar, a bar at the top or leave the visible area – then
// below; underline, strikethrough and highlight are in it only where the
// toolbar is not shown (lib/text-menu-placement.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { textMenuMarks, textMenuSide } from "../lib/text-menu-placement";

const menu = { left: 100, width: 560, height: 76 };
const toolbar = { left: 284, top: 259, right: 960, bottom: 296 };

test("a selection with room above it and no toolbar there: the menu opens above", () => {
  assert.equal(textMenuSide({ selection: { top: 500, bottom: 519 }, menu, gap: 10, minTop: 8, toolbar }), "above");
  // Without a toolbar (a read-only page).
  assert.equal(textMenuSide({ selection: { top: 200, bottom: 219 }, menu, gap: 10, minTop: 8 }), "above");
});

test("the first line under the toolbar: above would cover it, so below (#210)", () => {
  // The issue: a short line right under the toolbar of a record.
  assert.equal(textMenuSide({ selection: { top: 324, bottom: 343 }, menu, gap: 10, minTop: 8, toolbar }), "below");
  // Room between toolbar and selection, but not enough for the menu.
  assert.equal(textMenuSide({ selection: { top: 370, bottom: 389 }, menu, gap: 10, minTop: 8, toolbar }), "below");
  // Just enough room: above, touching the toolbar's bottom at most.
  assert.equal(textMenuSide({ selection: { top: 296 + 76 + 10, bottom: 401 }, menu, gap: 10, minTop: 8, toolbar }), "above");
});

test("the area above the toolbar counts too, also beside it", () => {
  // The menu would sit to the left of a narrow toolbar, above its bottom.
  const narrow = { left: 700, top: 259, right: 960, bottom: 296 };
  assert.equal(textMenuSide({ selection: { top: 340, bottom: 359 }, menu: { left: 100, width: 300, height: 60 }, gap: 10, minTop: 8, toolbar: narrow }), "below");
});

test("a toolbar below the selection (docked on a phone's keyboard) does not push the menu down", () => {
  const docked = { left: 0, top: 700, right: 390, bottom: 744 };
  assert.equal(textMenuSide({ selection: { top: 400, bottom: 419 }, menu: { left: 8, width: 374, height: 120 }, gap: 10, minTop: 8, toolbar: docked }), "above");
});

test("a sticky bar (dialog heading, top bar) or the top of the visible area: below", () => {
  const heading = { left: 260, top: 60, right: 1020, bottom: 124 };
  assert.equal(textMenuSide({ selection: { top: 180, bottom: 199 }, menu: { left: 300, width: 400, height: 76 }, gap: 10, minTop: 60, bars: [heading] }), "below");
  // A bar elsewhere across does not count.
  assert.equal(textMenuSide({ selection: { top: 180, bottom: 199 }, menu: { left: 300, width: 400, height: 76 }, gap: 10, minTop: 8, bars: [{ left: 800, top: 60, right: 1000, bottom: 124 }] }), "above");
  // The scrolled dialog's top edge.
  assert.equal(textMenuSide({ selection: { top: 120, bottom: 139 }, menu, gap: 10, minTop: 60 }), "below");
  // The window's top edge.
  assert.equal(textMenuSide({ selection: { top: 40, bottom: 59 }, menu, gap: 10, minTop: 8 }), "below");
});

test("the text menu's marks: bold, italic, code with the toolbar; underline, strikethrough, highlight only without it", () => {
  assert.deepEqual(textMenuMarks(true), ["bold", "italic", "code"]);
  assert.deepEqual(textMenuMarks(false), ["bold", "italic", "underline", "strike", "highlight", "code"]);
});
