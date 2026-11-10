// "Show related pages and backlinks" (Settings → Appearance, #191): on by
// default, off is kept for this person on this device, other tabs follow.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};
const fakeWindow = new EventTarget();
Object.assign(globalThis, { localStorage: fakeStorage, window: fakeWindow });
const { discoveryPanelsShown, setDiscoveryPanelsShown, onDiscoveryPanelsShown } = await import("../lib/discovery-panels-prefs");
const KEY = "flowplan.discovery-panels-hidden";

test("on by default", () => {
  assert.equal(discoveryPanelsShown(), true);
  assert.equal(store.size, 0);
});

test("turned off it stays off; on again forgets the choice", () => {
  let calls = 0;
  const stop = onDiscoveryPanelsShown(() => calls++);
  setDiscoveryPanelsShown(false);
  assert.equal(discoveryPanelsShown(), false);
  assert.equal(store.get(KEY), "true");
  assert.equal(calls, 1);
  setDiscoveryPanelsShown(true);
  assert.equal(discoveryPanelsShown(), true);
  assert.equal(store.has(KEY), false);
  assert.equal(calls, 2);
  stop();
  setDiscoveryPanelsShown(false);
  assert.equal(calls, 2);
  setDiscoveryPanelsShown(true);
});

test("another tab's change is followed (storage event)", () => {
  let calls = 0;
  const stop = onDiscoveryPanelsShown(() => calls++);
  assert.equal(discoveryPanelsShown(), true);
  // Another tab turns the panels off.
  store.set(KEY, "true");
  fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
  assert.equal(calls, 1);
  assert.equal(discoveryPanelsShown(), false);
  // Other keys are ignored.
  fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: "flowplan.other" }));
  assert.equal(calls, 1);
  // And on again.
  store.delete(KEY);
  fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
  assert.equal(calls, 2);
  assert.equal(discoveryPanelsShown(), true);
  stop();
});
