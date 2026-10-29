import { test } from "node:test";
import assert from "node:assert/strict";
import { phoneSystem } from "../lib/app-links";

test("the app hint knows the phone a browser runs on", () => {
  assert.equal(phoneSystem("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"), "android");
  assert.equal(phoneSystem("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"), "ios");
  // iPadOS names itself a Mac; only the touch screen tells.
  assert.equal(phoneSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5), "ios");
  assert.equal(phoneSystem("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 0), null);
  assert.equal(phoneSystem("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130"), null);
});
