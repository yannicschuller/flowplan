import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiEntries, searchEmojis } from "../lib/emoji-data";
test("full emoji search includes localized names, English keywords, flags, keycaps and skin variations", () => {
  assert.ok(emojiEntries.length > 3900);
  assert.equal(
    new Set(emojiEntries.map((e) => e.hexcode)).size,
    emojiEntries.length,
  );
  assert.ok(searchEmojis("Rakete").some((e) => e.emoji === "🚀"));
  assert.ok(searchEmojis("rocket").some((e) => e.emoji === "🚀"));
  assert.ok(searchEmojis("Deutschland", "9").some((e) => e.emoji === "🇩🇪"));
  assert.ok(searchEmojis("1️⃣").some((e) => e.emoji === "1️⃣"));
  assert.ok(
    searchEmojis("winkende hand", "all", "5").some((e) => e.emoji === "👋🏿"),
  );
  assert.ok(
    searchEmojis("", "all", "neutral").every((e) => e.tones.length === 0),
  );
});
