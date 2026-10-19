import { test } from "node:test";
import assert from "node:assert/strict";
import {
  easeInOutCubic,
  easeOutCubic,
  flipDeltas,
  interpolateCamera,
  prefersReducedMotion,
  sameRelativeOrder,
  tween,
} from "../lib/motion";
import { snippetHit, textIncludes } from "../lib/jump";

test("FLIP deltas: where each element was, relative to where it is", () => {
  const before = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 0, y: 40 }],
    ["c", { x: 0, y: 80 }],
    ["gone", { x: 0, y: 120 }],
  ]);
  const after = new Map([
    ["a", { x: 0, y: 40 }],
    ["b", { x: 0, y: 0 }],
    ["c", { x: 0.4, y: 80.3 }],
    ["new", { x: 0, y: 80 }],
  ]);
  const deltas = flipDeltas(before, after);
  assert.deepEqual(deltas.get("a"), { x: 0, y: -40 });
  assert.deepEqual(deltas.get("b"), { x: 0, y: 40 });
  // Sub-pixel noise, new and removed items do not glide.
  assert.equal(deltas.has("c"), false);
  assert.equal(deltas.has("new"), false);
  assert.equal(deltas.has("gone"), false);
  assert.equal(flipDeltas(before, after, 0.1).has("c"), true);
});

test("relative order: insertions and removals keep it, moves change it", () => {
  assert.equal(sameRelativeOrder(["a", "b", "c"], ["a", "x", "b", "c"]), true);
  assert.equal(sameRelativeOrder(["a", "b", "c"], ["a", "c"]), true);
  assert.equal(sameRelativeOrder(["a", "b", "c"], ["b", "a", "c"]), false);
  assert.equal(sameRelativeOrder([], ["a"]), true);
});

test("reduced motion guard follows the media query and is on without a window", () => {
  assert.equal(prefersReducedMotion(undefined), true);
  assert.equal(prefersReducedMotion({}), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(
    prefersReducedMotion({
      matchMedia: () => {
        throw new Error("unsupported");
      },
    }),
    true,
  );
});

test("tween jumps straight to the end without motion (server, reduced motion)", () => {
  const seen: number[] = [];
  tween(300, (p) => seen.push(p));
  assert.deepEqual(seen, [1]);
});

test("easing curves start at 0, end at 1 and stay in between", () => {
  for (const ease of [easeInOutCubic, easeOutCubic]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    for (let i = 1; i < 10; i++) assert.ok(ease(i / 10) > 0 && ease(i / 10) < 1);
  }
  assert.ok(easeOutCubic(0.5) > 0.5);
  assert.equal(easeInOutCubic(0.5), 0.5);
});

test("camera interpolation: ends exact, centre linear, zoom geometric", () => {
  const size = { width: 800, height: 600 };
  const from = { x: 0, y: 0, zoom: 1 },
    to = { x: 1000, y: 500, zoom: 4 };
  assert.equal(interpolateCamera(from, to, 0, size), from);
  assert.equal(interpolateCamera(from, to, 1, size), to);
  const mid = interpolateCamera(from, to, 0.5, size);
  assert.ok(Math.abs(mid.zoom - 2) < 1e-9);
  const center = (c: { x: number; y: number; zoom: number }) => ({
    x: c.x + size.width / 2 / c.zoom,
    y: c.y + size.height / 2 / c.zoom,
  });
  const a = center(from),
    b = center(to),
    m = center(mid);
  assert.ok(Math.abs(m.x - (a.x + b.x) / 2) < 1e-9);
  assert.ok(Math.abs(m.y - (a.y + b.y) / 2) < 1e-9);
});

test("jump helpers: first search hit and loose text matching", () => {
  assert.equal(snippetHit("before \u0002Hit  word\u0003 after \u0002second\u0003"), "Hit word");
  assert.equal(snippetHit("no marks"), "");
  assert.equal(snippetHit(null), "");
  assert.equal(textIncludes("A long\n  Paragraph here", "long paragraph"), true);
  assert.equal(textIncludes("Something", ""), false);
  assert.equal(textIncludes("Something", "else"), false);
});
