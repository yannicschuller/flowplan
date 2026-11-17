// KaTeX loads with the first formula (lib/math-render-lazy.ts): until then
// the source shows, then the rendered formula – unless the element shows
// another formula by then.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMath, mathLoaded, renderMathInto } from "../lib/math-render-lazy";

const element = (math: string) => ({ dataset: { math } as Record<string, string>, innerHTML: "", textContent: "" }) as unknown as HTMLElement;

test("a formula shows its source until KaTeX is there, then the rendered formula", async () => {
  assert.equal(mathLoaded(), null);
  const shown = element("x^2");
  renderMathInto(shown, "x^2", true);
  assert.equal(shown.textContent, "x^2");
  // Replaced meanwhile: the later formula stays.
  const replaced = element("y");
  renderMathInto(replaced, "x", true);
  await loadMath();
  assert.match(shown.innerHTML, /katex/);
  assert.equal(replaced.innerHTML, "");
  // Loaded: at once.
  const now = element("a");
  renderMathInto(now, "a", false);
  assert.match(now.innerHTML, /katex-display/);
});
