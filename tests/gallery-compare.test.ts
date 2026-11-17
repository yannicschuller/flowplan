import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countDiffPixels, DIFF_DEFAULTS, isChanged, pairShots, sortChanges, type ManifestShot, type Pixels } from "../scripts/gallery/compare";
import { themeCss } from "../scripts/gallery/report";

// The UI gallery's "Changed" view (scripts/gallery/compare.ts): which
// screenshots of the nightly site differ from the night before.

const shot = (scene: string, variant: string, hash: string, extra: Partial<ManifestShot> = {}): ManifestShot => ({
  scene,
  group: "Settings",
  title: scene,
  path: "",
  variant,
  file: `shots/${scene}--${variant}.webp`,
  thumb: `thumbs/${scene}--${variant}.webp`,
  width: 1440,
  height: 900,
  thumbWidth: 480,
  thumbHeight: 300,
  hash,
  pageErrors: [],
  ms: 1,
  ...extra,
});

test("pairShots: equal hashes are unchanged, others are candidates, the rest new or removed", () => {
  const previous = [shot("a", "desktop-light", "1"), shot("a", "phone-dark", "2"), shot("gone", "desktop-light", "3")];
  const current = [shot("a", "desktop-light", "1"), shot("a", "phone-dark", "2x"), shot("fresh", "desktop-dark", "4")];
  const { candidates, added, removed, unchanged } = pairShots(previous, current);
  assert.equal(unchanged, 1);
  assert.deepEqual(candidates.map((c) => [c.before.hash, c.after.hash]), [["2", "2x"]]);
  assert.deepEqual(added.map((s) => s.scene), ["fresh"]);
  assert.deepEqual(removed.map((s) => s.scene), ["gone"]);
});

test("pairShots: a screenshot without a hash (it failed) is always compared", () => {
  const { candidates, unchanged } = pairShots([shot("a", "desktop-light", "")], [shot("a", "desktop-light", "", { file: "", thumb: "" })]);
  assert.equal(unchanged, 0);
  assert.equal(candidates.length, 1);
});

test("pairShots: the same scene in another variant is new, not changed", () => {
  const { candidates, added, removed } = pairShots([shot("a", "desktop-light", "1")], [shot("a", "desktop-dark", "1")]);
  assert.equal(candidates.length, 0);
  assert.equal(added.length, 1);
  assert.equal(removed.length, 1);
});

function image(width: number, height: number, rgba = [255, 255, 255, 255]): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { data, width, height };
}
const paint = (img: Pixels, x0: number, y0: number, w: number, h: number, rgba: number[]) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set(rgba, (y * img.width + x) * 4);
};

test("countDiffPixels: identical images, faint noise and a real change", () => {
  const a = image(100, 50);
  assert.deepEqual(countDiffPixels(a, image(100, 50)), { diff: 0, total: 5000 });
  // Lossy compression and anti-aliasing: a slightly different grey.
  const noisy = image(100, 50);
  paint(noisy, 0, 0, 100, 50, [250, 251, 249, 255]);
  assert.equal(countDiffPixels(a, noisy).diff, 0);
  // A dark block of 10 × 4 pixels.
  const changed = image(100, 50);
  paint(changed, 10, 10, 10, 4, [30, 30, 30, 255]);
  assert.equal(countDiffPixels(a, changed).diff, 40);
});

test("countDiffPixels: images of different sizes differ completely", () => {
  assert.deepEqual(countDiffPixels(image(10, 10), image(10, 12)), { diff: 120, total: 120 });
});

test("countDiffPixels: transparent pixels count as white", () => {
  assert.equal(countDiffPixels(image(4, 4, [0, 0, 0, 0]), image(4, 4)).diff, 0);
});

test("isChanged: needs both enough pixels and a large enough share", () => {
  const total = 480 * 300; // a desktop thumbnail
  assert.equal(isChanged({ diff: 0, total }), false);
  // A caret or one anti-aliased edge.
  assert.equal(isChanged({ diff: DIFF_DEFAULTS.minPixels - 1, total }), false);
  // Below the share: a few dozen pixels of a 144 000 pixel thumbnail.
  assert.equal(isChanged({ diff: 40, total }), false);
  // A changed control: hundreds of pixels.
  assert.equal(isChanged({ diff: 300, total }), true);
  // A small image: the minimum number of pixels decides.
  assert.equal(isChanged({ diff: 12, total: 1000 }), true);
  assert.equal(isChanged({ diff: 11, total: 1000 }), false);
  assert.equal(isChanged({ diff: 5, total: 0 }), false);
  assert.equal(isChanged({ diff: 100, total }, { minRatio: 0.001 }), false);
});

test("sortChanges keeps the manifest's order", () => {
  const order = [shot("a", "desktop-light", "1"), shot("b", "desktop-light", "2"), shot("b", "phone-dark", "3")];
  const before = { file: "", thumb: "", width: 0, height: 0, thumbWidth: 0, thumbHeight: 0 };
  const sorted = sortChanges(
    [
      { scene: "b", variant: "phone-dark", ratio: 0.1, before },
      { scene: "a", variant: "desktop-light", ratio: 0.2, before },
    ],
    order,
  );
  assert.deepEqual(sorted.map((c) => c.scene), ["a", "b"]);
});

test("themeCss takes Flowplan's light and dark tokens from app/globals.css", () => {
  const globals = readFileSync(join(import.meta.dirname, "..", "app/globals.css"), "utf8");
  const css = themeCss(globals);
  for (const token of ["--bg", "--surface", "--text", "--muted", "--border", "--blue", "--radius", "--font-ui"])
    assert.match(css, new RegExp(`^  ${token}: `, "m"), token);
  // Dark both by the system setting and by the page's toggle.
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n  :root:not\(\[data-theme="light"\]\) \{\n    --bg: /);
  assert.match(css, /:root\[data-theme="dark"\] \{\n  --bg: /);
});

test("themeCss fails loudly when a token is gone", () => {
  assert.throws(() => themeCss(":root {\n  --bg: #fff;\n}\n[data-theme=\"dark\"] {\n  --bg: #000;\n}\n"), /lacks/);
});
