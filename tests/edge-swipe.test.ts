// The swipe from the left edge on touch screens (#285): who owns the edge
// (lib/edge-swipe.ts), the person's choice in the iOS app and what the page
// tells the app (lib/edge-swipe-pref.ts), and the width of the sidebar over
// the page, kept apart from the docked width.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};
const fakeWindow = new EventTarget() as EventTarget & { FlowplanApp?: unknown };
Object.assign(globalThis, { localStorage: fakeStorage, window: fakeWindow });
const {
  BACK_EDGE,
  OVERLAY_MAX,
  OVERLAY_MIN,
  OVERLAY_WIDTH_KEY,
  backOwnsEdge,
  clampOverlay,
  drawerSwipeApplies,
  openFrom,
  parseEdgeSwipePref,
  readOverlayWidth,
  writeOverlayWidth,
} = await import("../lib/edge-swipe");
const { edgeSwipeChoosable, edgeSwipePref, onEdgeSwipePref, reportEdgeSwipe, setEdgeSwipePref } = await import("../lib/edge-swipe-pref");
const { SIDEBAR_WIDTH_KEY } = await import("../lib/layout-cookie");
const KEY = "flowplan.edge-swipe";

type Env = Parameters<typeof backOwnsEdge>[0];
const env = (extra: Partial<Env> = {}): Env => ({
  ios: true,
  inApp: true,
  appTakesChoice: true,
  pref: "drawer",
  canGoBack: true,
  standalone: false,
  ...extra,
});

test("the app that takes the choice: 'Seitenleiste öffnen' gives the very edge to the sidebar", () => {
  assert.equal(backOwnsEdge(env()), false);
  assert.equal(openFrom(env()), 0);
  // Also on the start page.
  assert.equal(openFrom(env({ canGoBack: false })), 0);
});

test("'Zurück' in the app: the edge is back while there is a step back, as before", () => {
  assert.equal(openFrom(env({ pref: "back" })), BACK_EDGE);
  assert.equal(openFrom(env({ pref: "back", canGoBack: false })), 0);
});

test("an app from before the choice keeps its back swipe, whatever the page has stored", () => {
  assert.equal(openFrom(env({ appTakesChoice: false })), BACK_EDGE);
  assert.equal(openFrom(env({ appTakesChoice: false, canGoBack: false })), 0);
});

test("Safari keeps its own back swipe; the installed web app and Android open at the edge", () => {
  assert.equal(openFrom(env({ inApp: false, appTakesChoice: false })), BACK_EDGE);
  assert.equal(openFrom(env({ inApp: false, appTakesChoice: false, pref: "drawer" })), BACK_EDGE);
  assert.equal(openFrom(env({ inApp: false, appTakesChoice: false, standalone: true })), 0);
  assert.equal(openFrom(env({ ios: false, pref: "back" })), 0);
  assert.equal(openFrom(env({ ios: false, inApp: false })), 0);
});

test("the swipe applies on phones and where the sidebar is collapsed, not over a docked one", () => {
  assert.equal(drawerSwipeApplies({ phone: true, collapsed: false }), true);
  assert.equal(drawerSwipeApplies({ phone: false, collapsed: true }), true);
  assert.equal(drawerSwipeApplies({ phone: false, collapsed: false }), false);
});

test("the choice: 'drawer' by default, 'back' is kept; unknown values are the default", () => {
  assert.equal(parseEdgeSwipePref("back"), "back");
  assert.equal(parseEdgeSwipePref("drawer"), "drawer");
  assert.equal(parseEdgeSwipePref(null), "drawer");
  assert.equal(parseEdgeSwipePref("left"), "drawer");
  assert.equal(edgeSwipePref(), "drawer");
  let calls = 0;
  const stop = onEdgeSwipePref(() => calls++);
  setEdgeSwipePref("back");
  assert.equal(edgeSwipePref(), "back");
  assert.equal(store.get(KEY), "back");
  setEdgeSwipePref("drawer");
  assert.equal(store.has(KEY), false);
  assert.equal(calls, 2);
  // Another tab.
  store.set(KEY, "back");
  fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
  assert.equal(calls, 3);
  assert.equal(edgeSwipePref(), "back");
  stop();
  setEdgeSwipePref("drawer");
});

test("the choice is offered and reported only to an iOS app that takes it", () => {
  assert.equal(edgeSwipeChoosable(), false);
  const sent: unknown[] = [];
  fakeWindow.FlowplanApp = { platform: "android", version: "1.1.0", edgeSwipe: (mode: unknown) => sent.push(mode) };
  assert.equal(edgeSwipeChoosable(), false);
  fakeWindow.FlowplanApp = { platform: "ios", version: "1.0.12" };
  assert.equal(edgeSwipeChoosable(), false);
  // An older app: nothing to call, nothing breaks.
  reportEdgeSwipe();
  fakeWindow.FlowplanApp = { platform: "ios", version: "1.1.0", edgeSwipe: (mode: unknown) => sent.push(mode) };
  assert.equal(edgeSwipeChoosable(), true);
  reportEdgeSwipe();
  setEdgeSwipePref("back");
  reportEdgeSwipe();
  assert.deepEqual(sent, ["drawer", "back"]);
  // An app whose call throws does not break the page.
  fakeWindow.FlowplanApp = { platform: "ios", version: "1.1.0", edgeSwipe: () => { throw new Error("x"); } };
  reportEdgeSwipe();
  setEdgeSwipePref("drawer");
  delete fakeWindow.FlowplanApp;
});

test("the overlay's width is kept per device, apart from the docked width", () => {
  assert.equal(readOverlayWidth(fakeStorage), null);
  store.set(SIDEBAR_WIDTH_KEY, "300");
  assert.equal(readOverlayWidth(fakeStorage), null);
  writeOverlayWidth(fakeStorage, 420);
  assert.equal(store.get(OVERLAY_WIDTH_KEY), "420");
  assert.equal(readOverlayWidth(fakeStorage), 420);
  assert.equal(store.get(SIDEBAR_WIDTH_KEY), "300");
  // Within its bounds, also what an older version or a hand stored.
  writeOverlayWidth(fakeStorage, 10_000);
  assert.equal(readOverlayWidth(fakeStorage), OVERLAY_MAX);
  store.set(OVERLAY_WIDTH_KEY, "12");
  assert.equal(readOverlayWidth(fakeStorage), OVERLAY_MIN);
  store.set(OVERLAY_WIDTH_KEY, "wide");
  assert.equal(readOverlayWidth(fakeStorage), null);
  assert.equal(clampOverlay(333.4), 333);
  // Reset (double tap): the stylesheet's default again.
  writeOverlayWidth(fakeStorage, null);
  assert.equal(store.has(OVERLAY_WIDTH_KEY), false);
  // Storage that throws (private mode): no width, no error.
  const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => {} };
  assert.equal(readOverlayWidth(broken), null);
  writeOverlayWidth(broken, 300);
  assert.equal(readOverlayWidth(null), null);
});
