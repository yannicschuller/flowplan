// Full screen never throws (#533): a wrapped requestFullscreen that returns
// nothing or throws, a refused promise, an element no longer in the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enterFullscreen, leaveFullscreen } from "../lib/fullscreen";

const element = (requestFullscreen: () => unknown, isConnected = true) => ({ isConnected, requestFullscreen }) as unknown as Element;

test("entering full screen survives whatever the browser (or an extension) does", async () => {
  let calls = 0;
  // Returns nothing, as an extension's wrapper did.
  enterFullscreen(element(() => void calls++));
  // Throws.
  enterFullscreen(element(() => { calls++; throw new TypeError("Could not find the element that wants to be fullscreened"); }));
  // A refused promise is caught (no unhandled rejection).
  enterFullscreen(element(() => { calls++; return Promise.reject(new TypeError("Element is not connected")); }));
  assert.equal(calls, 3);
  // Not in the document, or nothing to call: not even asked.
  enterFullscreen(element(() => void calls++, false));
  enterFullscreen(null);
  enterFullscreen({ isConnected: true } as unknown as Element);
  assert.equal(calls, 3);
  await new Promise((r) => setTimeout(r, 10));
});

test("leaving full screen only when something is full screen, and never throwing", () => {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  let calls = 0;
  try {
    g.document = { fullscreenElement: null, exitFullscreen: () => void calls++ };
    leaveFullscreen();
    assert.equal(calls, 0);
    g.document = { fullscreenElement: {}, exitFullscreen: () => { calls++; return undefined; } };
    leaveFullscreen();
    g.document = { fullscreenElement: {}, exitFullscreen: () => { calls++; throw new Error("no"); } };
    leaveFullscreen();
    assert.equal(calls, 2);
  } finally {
    g.document = before;
  }
});
