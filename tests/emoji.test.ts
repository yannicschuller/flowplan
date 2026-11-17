import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEmojiEntries, searchEmojis as search } from "../lib/emoji-data";
test("full emoji search includes localized names, English keywords, flags, keycaps and skin variations", async () => {
  const emojiEntries = await loadEmojiEntries("de");
  const searchEmojis = (query: string, group?: string, tone?: string) => search(emojiEntries, query, group, tone);
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
test("other interface languages load the English names only, once", async () => {
  const english = await loadEmojiEntries("fr");
  assert.equal(english, await loadEmojiEntries("en"));
  assert.ok(search(english, "rocket").some((e) => e.emoji === "🚀" && e.label === e.labelEn));
  assert.ok(!search(english, "Rakete").length);
});
