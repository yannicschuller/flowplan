import test from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT_COOKIE,
  LAYOUT_KEY,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_WIDTH_KEY,
  deviceLayout,
  layoutCookie,
  layoutUpdate,
  parseLayout,
  readSidebarCollapsed,
  writeSidebarCollapsed,
  writeStoredLayout,
} from "../lib/layout-cookie";

const value = (cookie: string) => cookie.slice(LAYOUT_COOKIE.length + 1).split(";")[0];

// The layout cookie (lib/layout-cookie.ts): what the server renders the
// first paint with, so only well-formed numbers are taken.
test("layout cookie round-trips the sidebar and ask panel widths", () => {
  const cookie = layoutCookie({ sidebar: 312.4, ask: 500, askPinned: true, collapsed: false });
  assert.match(cookie, /^flowplan-layout=312\.500\.1\.0; path=\/; max-age=31536000; samesite=lax$/);
  assert.deepEqual(parseLayout(value(cookie)), { sidebar: 312, ask: 500, askPinned: true, collapsed: false });
  assert.deepEqual(parseLayout(value(layoutCookie({ sidebar: null, ask: null, askPinned: false, collapsed: false }))), {
    sidebar: null,
    ask: null,
    askPinned: false,
    collapsed: false,
  });
});

// #331: the sidebar the person hid stays hidden after a restart or reload.
test("layout cookie keeps the hidden sidebar", () => {
  const cookie = layoutCookie({ sidebar: 280, ask: null, askPinned: false, collapsed: true });
  assert.equal(value(cookie), "280.0.0.1");
  assert.deepEqual(parseLayout(value(cookie)), { sidebar: 280, ask: null, askPinned: false, collapsed: true });
  assert.deepEqual(parseLayout("0.0.1.1"), { sidebar: null, ask: null, askPinned: true, collapsed: true });
});

test("layout cookies from before the hidden sidebar still parse, shown", () => {
  assert.deepEqual(parseLayout("280.0.1"), { sidebar: 280, ask: null, askPinned: true, collapsed: false });
  assert.deepEqual(parseLayout("0.400.0"), { sidebar: null, ask: 400, askPinned: false, collapsed: false });
});

test("layout cookie is clamped and ignores anything else", () => {
  assert.deepEqual(parseLayout("9999.10.0"), { sidebar: 480, ask: 320, askPinned: false, collapsed: false });
  assert.deepEqual(parseLayout("20.0.0.0"), { sidebar: 200, ask: null, askPinned: false, collapsed: false });
  for (const bad of [
    undefined,
    null,
    "",
    "abc",
    "280",
    "280.0.2",
    "280.0.1;x",
    "-1.0.0",
    "12345.0.0",
    "280.0.1.2",
    "280.0.1.",
    "280.0.1.1.0",
    "280.0.1.x",
  ])
    assert.equal(parseLayout(bad as string | undefined), null, String(bad));
});

test("the hidden sidebar is kept in storage too, and storage failures are ignored", () => {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  assert.equal(readSidebarCollapsed(store), false);
  writeSidebarCollapsed(true, store);
  assert.equal(map.get(SIDEBAR_COLLAPSED_KEY), "1");
  assert.equal(readSidebarCollapsed(store), true);
  writeSidebarCollapsed(false, store);
  assert.equal(map.has(SIDEBAR_COLLAPSED_KEY), false);
  assert.equal(readSidebarCollapsed(store), false);
  const blocked = () => {
    throw new Error("blocked");
  };
  const broken = { getItem: blocked, setItem: blocked, removeItem: blocked };
  assert.equal(readSidebarCollapsed(broken), false);
  assert.doesNotThrow(() => writeSidebarCollapsed(true, broken));
  assert.equal(readSidebarCollapsed(null), false);
});

// #641: offline, the service worker serves the copy of the page it stored
// earlier – rendered with the layout of that time (sidebar shown). The
// device's own layout (localStorage, else its cookie) wins once the app
// runs, and only then is anything changed.
const memory = (entries: Record<string, string> = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};
const defaults = { sidebar: null, ask: null, askPinned: false, collapsed: false };

test("the device's layout: localStorage's record first, then the cookie, then the single values", () => {
  // The record written with every change wins – also over a cookie WebKit
  // did not keep, or one from before the change.
  const record = memory({ [LAYOUT_KEY]: "0.0.0.0", [SIDEBAR_COLLAPSED_KEY]: "1" });
  writeStoredLayout({ sidebar: 312, ask: null, askPinned: true, collapsed: true }, record);
  assert.equal(record.getItem(LAYOUT_KEY), "312.0.1.1");
  assert.deepEqual(deviceLayout("flowplan-layout=280.0.0.0", record), { sidebar: 312, ask: null, askPinned: true, collapsed: true });
  writeStoredLayout(defaults, record);
  assert.deepEqual(deviceLayout("flowplan-layout=280.0.0.1", record), defaults);
  // Storage blocked or without the record (before #641): the cookie, among
  // other cookies, with the spaces browsers join them with.
  const stored = memory({ [SIDEBAR_COLLAPSED_KEY]: "1", [SIDEBAR_WIDTH_KEY]: "300", "flowplan-ask-width": "500", "flowplan-ask-pinned": "1" });
  for (const store of [stored, memory({ [LAYOUT_KEY]: "nonsense" }), null])
    assert.deepEqual(deviceLayout("theme=dark; flowplan-layout=280.0.0.1; other=1", store), {
      sidebar: 280,
      ask: null,
      askPinned: false,
      collapsed: true,
    });
  // No cookie (or a broken one): the single values in localStorage.
  for (const cookies of ["", "theme=dark", "flowplan-layout=nonsense", "x-flowplan-layout=280.0.0.0"])
    assert.deepEqual(deviceLayout(cookies, stored), { sidebar: 300, ask: 500, askPinned: true, collapsed: true }, cookies);
  assert.deepEqual(deviceLayout("", memory()), defaults);
  const blocked = () => {
    throw new Error("blocked");
  };
  assert.deepEqual(deviceLayout("", { getItem: blocked, setItem: blocked, removeItem: blocked }), defaults);
  assert.deepEqual(deviceLayout("", null), defaults);
});

test("a page rendered with an older layout takes the device's (#641), an up-to-date one changes nothing", () => {
  const shown = { sidebar: 280, ask: 400, askPinned: false, collapsed: false };
  // Online: the server rendered the current cookie – no change, no flash.
  assert.equal(layoutUpdate(shown, { ...shown }), null);
  assert.equal(layoutUpdate(defaults, { ...defaults }), null);
  // The stored copy from before the sidebar was hidden or resized, the
  // panel resized or pinned: the device's values.
  for (const device of [
    { ...shown, collapsed: true },
    { ...shown, sidebar: 320 },
    { ...shown, sidebar: null },
    { ...shown, ask: 500 },
    { ...shown, askPinned: true },
  ])
    assert.deepEqual(layoutUpdate(shown, device), device);
  // Rendered without a cookie: localStorage's values, as before.
  const device = { ...defaults, collapsed: true };
  assert.deepEqual(layoutUpdate(null, device), device);
  assert.deepEqual(layoutUpdate(undefined, device), device);
});
