import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_DEFAULT,
  ASK_MIN,
  ASK_PIN_KEY,
  ASK_WIDTH_KEY,
  askMax,
  askMode,
  clampAsk,
  readAskPinned,
  readAskWidth,
  writeAskPinned,
  writeAskWidth,
} from "../lib/ask-panel";
import { OUTLINE_SIDE_MIN, outlineFits } from "../components/document-outline";

// A Storage stand-in; `broken` throws like a browser with blocked site data.
function store(broken = false) {
  const data = new Map<string, string>();
  const guard = () => {
    if (broken) throw new DOMException("blocked", "SecurityError");
  };
  return {
    data,
    getItem: (k: string) => (guard(), data.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void data.set(k, v)),
    removeItem: (k: string) => (guard(), void data.delete(k)),
  };
}

// "KI fragen" (#59): 420 px unless dragged, at least 320 px, at most 45 %
// of the window – the minimum wins on windows too small for both.
test("the width of the ask panel is clamped to the window", () => {
  assert.equal(ASK_DEFAULT, 420);
  assert.equal(ASK_MIN, 320);
  assert.equal(clampAsk(null, 1440), 420);
  assert.equal(clampAsk(null, 900), 405);
  assert.equal(clampAsk(null, 700), 320);
  assert.equal(clampAsk(20, 1440), 320);
  assert.equal(clampAsk(9999, 1440), 648);
  assert.equal(clampAsk(9999, 1000), 450);
  assert.equal(clampAsk(500.4, 1440), 500);
  assert.equal(askMax(1000), 450);
  assert.equal(askMax(600), ASK_MIN);
});

test("the dragged width and the pin are kept per device", () => {
  const s = store();
  assert.equal(readAskWidth(s), null);
  writeAskWidth(512.6, s);
  assert.equal(s.data.get(ASK_WIDTH_KEY), "513");
  assert.equal(readAskWidth(s), 513);
  // Double click on the handle: back to the default.
  writeAskWidth(null, s);
  assert.equal(s.data.has(ASK_WIDTH_KEY), false);
  // Nonsense and too small values.
  s.setItem(ASK_WIDTH_KEY, "wide");
  assert.equal(readAskWidth(s), null);
  s.setItem(ASK_WIDTH_KEY, "-3");
  assert.equal(readAskWidth(s), null);
  s.setItem(ASK_WIDTH_KEY, "100");
  assert.equal(readAskWidth(s), ASK_MIN);

  assert.equal(readAskPinned(s), false);
  writeAskPinned(true, s);
  assert.equal(s.data.get(ASK_PIN_KEY), "1");
  assert.equal(readAskPinned(s), true);
  writeAskPinned(false, s);
  assert.equal(readAskPinned(s), false);
});

test("storage that throws (private mode, blocked site data) gives the defaults", () => {
  const s = store(true);
  assert.doesNotThrow(() => writeAskWidth(500, s));
  assert.doesNotThrow(() => writeAskPinned(true, s));
  assert.equal(readAskWidth(s), null);
  assert.equal(readAskPinned(s), false);
  // No storage at all (the server, a sandboxed frame).
  assert.equal(readAskWidth(null), null);
  assert.equal(readAskPinned(null), false);
});

// Docked from 1100 px, over the page below unless pinned, a sheet on phones.
test("where the ask panel goes", () => {
  assert.equal(askMode(1440, false), "docked");
  assert.equal(askMode(1100, false), "docked");
  assert.equal(askMode(1099, false), "overlay");
  assert.equal(askMode(1000, true), "docked");
  assert.equal(askMode(768, false), "overlay");
  assert.equal(askMode(767, true), "sheet");
  assert.equal(askMode(390, false), "sheet");
});

// The table of contents stays beside the text from a 768 px text column;
// below, it gives way to a popover.
test("the table of contents gives way in narrow text columns", () => {
  assert.equal(OUTLINE_SIDE_MIN, 768);
  assert.equal(outlineFits(820), true);
  assert.equal(outlineFits(768), true);
  assert.equal(outlineFits(767.5), false);
  assert.equal(outlineFits(580), false);
});
