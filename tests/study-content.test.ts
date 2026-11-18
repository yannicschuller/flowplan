// Card content (docs/specs/flashcards.md §3.1, §5.1): the document split at
// its first top-level rule, which records become which cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCards, htmlHasContent, splitCardHtml } from "../lib/study-content";
import { studySettingsSchema } from "../lib/study-schema";
import type { Field } from "../lib/types";

test("splitCardHtml: above and below the first top-level rule", () => {
  const html = "<p>Frage <em>1</em></p><hr><p>Antwort</p><hr><p>Mehr</p>";
  assert.equal(splitCardHtml(html, "above"), "<p>Frage <em>1</em></p>");
  assert.equal(splitCardHtml(html, "below"), "<p>Antwort</p><hr><p>Mehr</p>");
  assert.equal(splitCardHtml(html, "all"), html);
  // Self-closing, attributes with ">" before it.
  assert.equal(splitCardHtml('<p title="a>b">x</p><hr/><p>y</p>', "below"), "<p>y</p>");
  // A rule inside a quote, a toggle or a table cell is no separator.
  const nested = "<blockquote><p>a</p><hr></blockquote><details><summary>s</summary><div><hr></div></details><p>b</p>";
  assert.equal(splitCardHtml(nested, "above"), "");
  assert.equal(splitCardHtml(nested, "below"), nested);
  // Images and line breaks (void elements) do not confuse the depth.
  assert.equal(splitCardHtml('<p>a<br>b</p><img src="/x.png"><hr><p>c</p>', "above"), '<p>a<br>b</p><img src="/x.png">');
  assert.equal(splitCardHtml("", "below"), "");
});

test("content: text, media and formulas count; empty paragraphs do not", () => {
  assert.equal(htmlHasContent("<p></p><p> </p>"), false);
  assert.equal(htmlHasContent('<p><img src="/api/files/1"></p>'), true);
  assert.equal(htmlHasContent('<span data-math="x^2"></span>'), true);
  assert.equal(htmlHasContent("<p>&nbsp;x</p>"), true);
});

const fields: Field[] = [
  { id: "title", name: "Vorderseite", type: "text" },
  { id: "back", name: "Rückseite", type: "text" },
  { id: "hint", name: "Hinweis", type: "text" },
];
const settings = (extra: Record<string, unknown> = {}) => studySettingsSchema.parse({ version: 1, front: { field: "title" }, back: { field: "back" }, ...extra });

test("basic and reverse cards; no card without both sides", () => {
  const cards = deriveCards(settings({ reverse: true, hint: { field: "hint" } }), fields, { title: "hola", back: "hallo", hint: "" }, null);
  assert.deepEqual(
    cards.map((c) => [c.sub, "text" in c.front && c.front.text, "text" in c.back && c.back.text, !!c.hint]),
    [
      ["", "hola", "hallo", false],
      ["r", "hallo", "hola", false],
    ],
  );
  assert.deepEqual(deriveCards(settings(), fields, { title: "hola", back: "  " }, null), []);
  // Card types of later phases give no cards yet.
  assert.deepEqual(deriveCards(settings({ type: { fixed: "cloze" } }), fields, { title: "a", back: "b" }, null), []);
});

test("title front and the document as back, or the document on both sides", () => {
  const doc = "<p>Frage</p><hr><p>Antwort</p>";
  const [all] = deriveCards(settings({ back: { document: "all" } }), fields, { title: "T" }, doc);
  assert.deepEqual(all.back, { html: doc });
  const [split] = deriveCards(settings({ front: { document: "above" }, back: { document: "below" } }), fields, {}, doc);
  assert.deepEqual([split.front, split.back], [{ html: "<p>Frage</p>" }, { html: "<p>Antwort</p>" }]);
  // Without a rule there is no front above it: no card.
  assert.deepEqual(deriveCards(settings({ front: { document: "above" }, back: { document: "below" } }), fields, {}, "<p>nur Text</p>"), []);
});
