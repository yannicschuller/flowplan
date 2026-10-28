import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar } from "../components/sidebar-resize";

// The dragged sidebar stays between its limits and lands on whole pixels.
test("the sidebar width is clamped and rounded", () => {
  assert.equal(clampSidebar(20), SIDEBAR_MIN);
  assert.equal(clampSidebar(9999), SIDEBAR_MAX);
  assert.equal(clampSidebar(300.6), 301);
});
