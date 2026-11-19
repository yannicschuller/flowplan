// Emoji suggestions after ":" (#388): when the trigger opens
// (lib/emoji-trigger.ts) and which emojis it suggests in which order
// (lib/emoji-rank.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Mark, Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { closedShortcode, closedShortcodeAt, emojiQuery, emojiTriggerAt } from "../lib/emoji-trigger";
import { loadEmojiEntries } from "../lib/emoji-data";
import { exactEmoji, matchTier, rankEmojis } from "../lib/emoji-rank";

const schema = documentSchema();
const text = (value: string, marks: Mark[] = []) => schema.text(value, marks);
// The state with the caret at the end of one block.
const state = (block: Node) => {
  const doc = schema.nodes.doc.create(null, [block]);
  const start = EditorState.create({ schema, doc });
  return start.apply(start.tr.setSelection(TextSelection.create(doc, 1 + block.content.size)));
};
const p = (...content: Node[]) => schema.nodes.paragraph.create(null, content);

test("“:” and two letters open the suggestions at the line start, after a space or an opening bracket or quote", () => {
  assert.equal(emojiQuery(":smi"), "smi");
  assert.equal(emojiQuery("Hallo :daum"), "daum");
  assert.equal(emojiQuery("(:rocket"), "rocket");
  assert.equal(emojiQuery("„:herz"), "herz");
  assert.equal(emojiQuery("Zeile\n:ok"), "ok");
  assert.equal(emojiQuery("Hallo :+1"), null, "from two letters only");
  assert.equal(emojiQuery(":thumbs_up"), "thumbs_up");
  assert.equal(emojiQuery(":über"), "über");
  assert.deepEqual(emojiTriggerAt(state(p(text("Hallo :smi")))), { from: 7, to: 11, query: "smi" });
});

test("one letter, a space after the colon, times, URLs and words with a colon open nothing", () => {
  assert.equal(emojiQuery(":s"), null);
  assert.equal(emojiQuery(":"), null);
  assert.equal(emojiQuery("Hallo : smi"), null);
  assert.equal(emojiQuery("Hallo :smi "), null, "a space ends the trigger");
  assert.equal(emojiQuery("um 12:30"), null);
  assert.equal(emojiQuery("um 12:ab"), null);
  assert.equal(emojiQuery("https://flowplan.org"), null);
  assert.equal(emojiQuery("siehe https:ab"), null);
  assert.equal(emojiQuery("Hinweis:ab"), null);
  assert.equal(emojiQuery("a :12"), null);
  assert.equal(emojiQuery("a ::smi"), null);
});

test("in a code block, inline code and links the suggestions stay closed", () => {
  const code = schema.marks.code.create();
  const link = schema.marks.link.create({ href: "https://example.com" });
  assert.equal(emojiTriggerAt(state(schema.nodes.codeBlock.create(null, [text("x = :smi")]))), null);
  assert.equal(emojiTriggerAt(state(p(text("a "), text(":smi", [code])))), null);
  assert.equal(emojiTriggerAt(state(p(text("a "), text(":smi", [link])))), null);
  assert.ok(emojiTriggerAt(state(p(text("code", [code]), text(" :smi")))));
  // A selection is no trigger.
  const s = state(p(text("a :smi")));
  assert.equal(emojiTriggerAt(s.apply(s.tr.setSelection(TextSelection.create(s.doc, 3, 7)))), null);
});

test("a closing colon on a shortcode is recognised (“:smile:”), not in code or after a letter", () => {
  assert.equal(closedShortcode("Hallo :smile:"), "smile");
  assert.equal(closedShortcode(":rocket:"), "rocket");
  assert.equal(closedShortcode("12:30:"), null);
  assert.equal(closedShortcode("Hallo :s:"), null);
  assert.equal(closedShortcode("Hallo :smile"), null);
  assert.deepEqual(closedShortcodeAt(state(p(text("Hallo :smile:")))), { from: 7, to: 14, query: "smile" });
  assert.equal(closedShortcodeAt(state(p(text(":smile:", [schema.marks.code.create()])))), null);
});

test("ranking: an exact name or shortcode, then names starting with the query, then tags", async () => {
  const de = await loadEmojiEntries("de");
  const rocket = de.find((e) => e.emoji === "🚀")!;
  assert.equal(matchTier(rocket, "rakete"), 0);
  assert.equal(matchTier(rocket, "rocket"), 0);
  assert.equal(matchTier(rocket, "rak"), 1);
  assert.equal(matchTier(rocket, "weltr"), 3);
  assert.equal(matchTier(rocket, "katze"), null);
  assert.equal(rankEmojis(de, "rak")[0].emoji, "🚀");
  assert.equal(rankEmojis(de, "rocket")[0].emoji, "🚀");
  assert.equal(rankEmojis(de, "daum")[0].emoji, "👍");
  assert.equal(rankEmojis(de, "smile")[0].emoji, "😄", "GitHub's :smile: first");
  const smi = rankEmojis(de, "smi");
  assert.equal(smi.length, 10);
  assert.equal(new Set(smi.map((e) => e.hexcode)).size, smi.length);
  // Only emojis without a tone, no regional indicators or tone components.
  assert.ok(smi.every((e) => !e.parent && !e.tones.length));
  assert.ok(rankEmojis(de, "regional").every((e) => e.group !== undefined));
  // A name starting with the query before a tag containing it.
  const herz = rankEmojis(de, "herz", { limit: 50 });
  const tierOf = herz.map((e) => matchTier(e, "herz")!);
  assert.deepEqual([...tierOf].sort((a, b) => a - b), tierOf);
  assert.deepEqual(rankEmojis(de, "zzqx"), []);
  const en = await loadEmojiEntries("en");
  assert.equal(rankEmojis(en, "rocket")[0].emoji, "🚀");
  assert.deepEqual(rankEmojis(en, "rakete"), []);
});

test("recently used emojis come first after an exact match; the picker's skin tone is used", async () => {
  const de = await loadEmojiEntries("de");
  const plain = rankEmojis(de, "smi");
  const later = plain[plain.length - 1].emoji;
  assert.equal(rankEmojis(de, "smi", { recents: [later] })[0].emoji, later);
  // An exact shortcode stays ahead of the recently used ones.
  assert.equal(rankEmojis(de, "smile", { recents: [later] })[0].emoji, "😄");
  // A recently used emoji in a tone lifts the emoji without one.
  const dau = rankEmojis(de, "dau", { recents: ["👍🏽"] });
  assert.equal(dau[0].hexcode, "1F44D");
  assert.equal(rankEmojis(de, "daum", { tone: 5 })[0].emoji, "👍🏿");
  assert.equal(rankEmojis(de, "rak", { tone: 5 })[0].emoji, "🚀", "no tone: the emoji as it is");
  assert.equal(exactEmoji(de, "smile")?.emoji, "😄");
  assert.equal(exactEmoji(de, "rakete")?.emoji, "🚀");
  assert.equal(exactEmoji(de, "daumen_hoch", 2)?.emoji, "👍🏼");
  assert.equal(exactEmoji(de, "+1")?.emoji, "👍");
  assert.equal(exactEmoji(de, "smi"), null);
});
