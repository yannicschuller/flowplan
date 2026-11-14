// Offering offline use per device (#295, lib/offline-offer.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LATER_MS, offlineOfferPossible, parseOfferAnswer, shouldOfferOffline, type OfferFacts } from "../lib/offline-offer";

const base: OfferFacts = { supported: true, nativeApp: false, guest: false, demo: false, enabled: false, stored: null, now: 1_000_000_000_000 };

test("a device that was not asked yet is asked", () => {
  assert.equal(shouldOfferOffline(base), true);
  assert.equal(offlineOfferPossible(base), true);
});

test("never where offline does not work, the app asks itself, for guests, the demo, or when it is on", () => {
  for (const change of [{ supported: false }, { nativeApp: true }, { guest: true }, { demo: true }, { enabled: true }]) {
    assert.equal(shouldOfferOffline({ ...base, ...change }), false, JSON.stringify(change));
    assert.equal(offlineOfferPossible({ ...base, ...change }), false, JSON.stringify(change));
  }
});

test("the answer on the device: on and never end it, later asks again after a week", () => {
  assert.equal(shouldOfferOffline({ ...base, stored: "enabled" }), false);
  assert.equal(shouldOfferOffline({ ...base, stored: "never" }), false);
  assert.equal(shouldOfferOffline({ ...base, stored: `later:${base.now - 1000}` }), false);
  assert.equal(shouldOfferOffline({ ...base, stored: `later:${base.now - LATER_MS}` }), true);
  // Something unknown counts as not asked.
  assert.equal(shouldOfferOffline({ ...base, stored: "kaputt" }), true);
  assert.deepEqual(parseOfferAnswer("later:42"), { kind: "later", at: 42 });
  assert.equal(parseOfferAnswer("later:"), null);
});
