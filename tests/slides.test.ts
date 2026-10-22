import { test } from "node:test";
import assert from "node:assert/strict";
import { planSlides } from "../lib/slides";

const b = (tag: string, extra: { callout?: string; empty?: boolean } = {}) => ({ tag, ...extra });

test("each H1 starts a slide; content before it is a slide of its own", () => {
  const plan = planSlides([b("p"), b("h1"), b("p"), b("h2"), b("ul"), b("H1"), b("table")]);
  assert.deepEqual(plan.map((s) => s.blocks), [[0], [1, 2, 3, 4], [5, 6]]);
});

test("without H1 each H2 starts a slide", () => {
  const plan = planSlides([b("h2"), b("p"), b("h3"), b("h2"), b("pre")]);
  assert.deepEqual(plan.map((s) => s.blocks), [[0, 1, 2], [3, 4]]);
});

test("horizontal rules split slides, also without headings", () => {
  assert.deepEqual(planSlides([b("p"), b("hr"), b("p"), b("p"), b("hr"), b("hr"), b("img")]).map((s) => s.blocks), [[0], [2, 3], [6]]);
  assert.deepEqual(planSlides([b("h1"), b("p"), b("hr"), b("p"), b("h1")]).map((s) => s.blocks), [[0, 1], [3], [4]]);
  // Only paragraphs: one slide.
  assert.deepEqual(planSlides([b("p"), b("p")]).map((s) => s.blocks), [[0, 1]]);
  assert.deepEqual(planSlides([]), []);
});

test("a note callout at the end of a slide becomes its speaker notes", () => {
  const plan = planSlides([
    b("h1"),
    b("p"),
    b("aside", { callout: "note" }),
    b("p", { empty: true }),
    b("h1"),
    b("aside", { callout: "warning" }),
    b("h1"),
    b("aside", { callout: "note" }),
    b("p"),
  ]);
  assert.deepEqual(plan, [
    { blocks: [0, 1], notes: 2 },
    // Other callouts stay on the slide.
    { blocks: [4, 5], notes: null },
    // Not at the end: shown.
    { blocks: [6, 7, 8], notes: null },
  ]);
  // Older callouts without a kind are notes too; a slide of only a note shows it.
  assert.deepEqual(planSlides([b("h1"), b("aside", { callout: "true" })]), [{ blocks: [0], notes: 1 }]);
  assert.deepEqual(planSlides([b("aside", { callout: "note" })]), [{ blocks: [0], notes: null }]);
});

test("slides of empty paragraphs only are left out", () => {
  assert.deepEqual(planSlides([b("p", { empty: true }), b("h1"), b("p")]).map((s) => s.blocks), [[1, 2]]);
});
