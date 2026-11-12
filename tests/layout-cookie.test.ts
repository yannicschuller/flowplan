import test from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_COOKIE, layoutCookie, parseLayout } from "../lib/layout-cookie";

// The layout cookie (lib/layout-cookie.ts): what the server renders the
// first paint with, so only well-formed numbers are taken.
test("layout cookie round-trips the sidebar and ask panel widths", () => {
  const cookie = layoutCookie({ sidebar: 312.4, ask: 500, askPinned: true });
  assert.match(cookie, /^flowplan-layout=312\.500\.1; path=\/; max-age=31536000; samesite=lax$/);
  const value = cookie.slice(LAYOUT_COOKIE.length + 1).split(";")[0];
  assert.deepEqual(parseLayout(value), { sidebar: 312, ask: 500, askPinned: true });
  assert.deepEqual(parseLayout(layoutCookie({ sidebar: null, ask: null, askPinned: false }).split(/[=;]/)[1]), {
    sidebar: null,
    ask: null,
    askPinned: false,
  });
});

test("layout cookie is clamped and ignores anything else", () => {
  assert.deepEqual(parseLayout("9999.10.0"), { sidebar: 480, ask: 320, askPinned: false });
  assert.deepEqual(parseLayout("20.0.0"), { sidebar: 200, ask: null, askPinned: false });
  for (const bad of [undefined, null, "", "abc", "280", "280.0.2", "280.0.1;x", "-1.0.0", "12345.0.0"])
    assert.equal(parseLayout(bad as string | undefined), null, String(bad));
});
