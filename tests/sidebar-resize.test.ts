import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar } from "../components/sidebar-resize";

// The dragged sidebar stays between its limits and lands on whole pixels.
test("the sidebar width is clamped and rounded", () => {
  assert.equal(clampSidebar(20), SIDEBAR_MIN);
  assert.equal(clampSidebar(9999), SIDEBAR_MAX);
  assert.equal(clampSidebar(300.6), 301);
});
// The "KI fragen" panel on the right has its own limits (#59).
test("the width of the ask panel is clamped and rounded", async () => {
  const { ASK_MAX, ASK_MIN, clampAsk } = await import("../components/ai-ask");
  assert.equal(clampAsk(20), ASK_MIN);
  assert.equal(clampAsk(9999), ASK_MAX);
  assert.equal(clampAsk(400.4), 400);
  assert.ok(ASK_MIN >= 280 && ASK_MAX <= 720);
});
