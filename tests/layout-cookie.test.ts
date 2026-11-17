import test from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT_COOKIE,
  SIDEBAR_COLLAPSED_KEY,
  layoutCookie,
  parseLayout,
  readSidebarCollapsed,
  writeSidebarCollapsed,
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
