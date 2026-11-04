import assert from "node:assert/strict";
import { test } from "node:test";
import { appViewportContent, isMobileApp } from "../lib/app-zoom";

test("the app is recognised by FlowplanApp or its user agent", () => {
  assert.equal(isMobileApp({ FlowplanApp: {} }, "Mozilla/5.0"), true);
  assert.equal(isMobileApp({}, "Mozilla/5.0 FlowplanMobile/1.2"), true);
  assert.equal(isMobileApp({}, "Mozilla/5.0 (iPhone) Safari"), false);
  assert.equal(isMobileApp(undefined, "Mozilla/5.0"), false);
});

test("the app viewport turns zooming off and keeps the rest", () => {
  assert.equal(
    appViewportContent("width=device-width, initial-scale=1, viewport-fit=cover"),
    "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no",
  );
  assert.equal(
    appViewportContent("width=device-width, maximum-scale=5, user-scalable=yes"),
    "width=device-width, maximum-scale=1, user-scalable=no",
  );
});
