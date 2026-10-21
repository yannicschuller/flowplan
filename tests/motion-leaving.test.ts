// useLeaving (components/motion.tsx) in a small DOM: items that leave stay
// for the fade, several of them in a row, and then all of them go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node });
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Motion is allowed: no reduced-motion preference (prefersReducedMotion reads
// window.matchMedia; the global alias is for code that calls it directly).
const allowMotion = () => ({ matches: false });
(win as unknown as { matchMedia: unknown }).matchMedia = allowMotion;
(globalThis as unknown as { matchMedia: unknown }).matchMedia = allowMotion;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useLeaving } = await import("../components/motion");

let latest: { item: string; leaving: boolean }[] = [];
function List({ items }: { items: string[] }) {
  latest = useLeaving(items, (s) => s, 200);
  return React.createElement(
    "ul",
    null,
    latest.map(({ item, leaving }) => React.createElement("li", { key: item, "data-leaving": leaving ? "1" : "0" }, item)),
  );
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const shown = () => latest.map((x) => (x.leaving ? `${x.item}*` : x.item));

test("items removed shortly after one another all fade out, in their old places", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (items: string[]) => act(() => root.render(React.createElement(List, { items })));
  render(["a", "b", "c"]);
  render(["b", "c"]); // a leaves
  assert.deepEqual(shown(), ["a*", "b", "c"]);
  await act(() => sleep(50));
  render(["c"]); // b leaves while a is still fading
  assert.deepEqual(shown(), ["a*", "b*", "c"], "both keep their place");
  await act(() => sleep(400));
  assert.deepEqual(shown(), ["c"], "no ghost stays behind");
  // An item that comes back is shown as present at once.
  render(["b", "c"]);
  render(["c"]);
  render(["b", "c"]);
  assert.deepEqual(shown(), ["b", "c"]);
  await act(() => sleep(300));
  assert.deepEqual(shown(), ["b", "c"]);
  act(() => root.unmount());
});
