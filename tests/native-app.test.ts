import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineUnsupportedReason } from "../lib/native-app";

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FlowplanMobile/1.4.0";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 FlowplanMobile/1.4.0";
const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("the iPhone and iPad app is named as the reason, not the browser", () => {
  assert.equal(offlineUnsupportedReason({ platform: "ios" }, iphone), "ios-app");
  // Before the bridge is there, the user agent tells (iPadOS names itself a Mac).
  assert.equal(offlineUnsupportedReason(undefined, iphone), "ios-app");
  assert.equal(offlineUnsupportedReason(undefined, ipad), "ios-app");
  // Android's web view runs the service worker; Safari is a browser.
  assert.equal(offlineUnsupportedReason({ platform: "android" }, android), "browser");
  assert.equal(offlineUnsupportedReason(undefined, android), "browser");
  assert.equal(offlineUnsupportedReason(undefined, safari), "browser");
});
