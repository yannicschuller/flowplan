// Cloze deletions (docs/specs/flashcards.md §5.2): Anki's syntax in text,
// the editor's mark in documents, one card per number, the card's gaps
// hidden and the others shown, and the mark through Markdown and back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clozeFilled, clozeHtml, clozeNumbers, parseClozeText } from "../lib/study-cloze";
import { deriveCards } from "../lib/study-content";
import { studySettingsSchema } from "../lib/study-schema";
import { htmlToMarkdown } from "../lib/markdown";
import { markdownToRawHtml } from "../lib/markdown-html";
import { cleanHtml } from "../lib/document-server";
import type { Field } from "../lib/types";

test("parseClozeText: answers, hints, several numbers", () => {
  assert.deepEqual(parseClozeText("Die Hauptstadt von {{c1::Frankreich}} ist {{c2::Paris::Stadt}}."), [
    { type: "text", text: "Die Hauptstadt von " },
    { type: "cloze", n: 1, answer: "Frankreich" },
    { type: "text", text: " ist " },
    { type: "cloze", n: 2, answer: "Paris", hint: "Stadt" },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(clozeNumbers("{{c3::a}} {{c1::b}} {{c3::c}}"), [1, 3]);
  // Inline Markdown inside an answer stays for the renderer.
  assert.deepEqual(parseClozeText("{{c1::**fett**}}"), [{ type: "cloze", n: 1, answer: "**fett**" }]);
  // A hint may hold a single colon.
  assert.deepEqual(parseClozeText("{{c1::12::Uhrzeit: hh}}")[0], { type: "cloze", n: 1, answer: "12", hint: "Uhrzeit: hh" });
});

test("parseClozeText: broken syntax stays text, nested gaps are flattened", () => {
  for (const text of ["{{c1::offen", "{{c::x}}", "{{c0::x}}", "{{c100::x}}", "{c1::x}", "{{C1::x}}", "{{c1:x}}"]) {
    assert.deepEqual(parseClozeText(text), [{ type: "text", text }], text);
    assert.deepEqual(clozeNumbers(text), [], text);
  }
  // Anki ≥ 2.1.56 nests: the inner gap's text stays, its number gives no card.
  assert.deepEqual(parseClozeText("{{c1::Die {{c2::Zelle::Hinweis}} lebt}}"), [{ type: "cloze", n: 1, answer: "Die Zelle lebt" }]);
  assert.deepEqual(clozeNumbers("{{c1::a {{c2::b}} c}}"), [1]);
  // Text around a broken one and a good one.
  assert.deepEqual(clozeNumbers("{{c1::kaputt {{c2::gut}}"), [2]);
  assert.equal(clozeFilled("a {{c1::b::h}} c {{c2::d}}"), "a b c d");
  assert.equal(clozeFilled("ohne"), "ohne");
});

test("clozeHtml: the editor's mark and the syntax in documents", () => {
  const html = '<p>Die <span data-cloze="1">Mitochondrien</span> liefern <strong><span data-cloze="2" data-cloze-hint="Molekül">ATP</span></strong>.</p>';
  assert.deepEqual(clozeNumbers(html, true), [1, 2]);
  assert.equal(clozeHtml(html, 1, false), '<p>Die <span class="cloze-gap">[…]</span> liefern <strong>ATP</strong>.</p>');
  assert.equal(clozeHtml(html, 2, false), '<p>Die Mitochondrien liefern <strong><span class="cloze-gap">[Molekül]</span></strong>.</p>');
  assert.equal(clozeHtml(html, 2, true), '<p>Die Mitochondrien liefern <strong><span class="cloze-answer">ATP</span></strong>.</p>');
  // Marks inside a gap go with it; spans of other marks stay.
  const nested = '<p><span data-cloze="1">a <span style="color: red">b</span></span> <span style="color: red">c</span></p>';
  assert.equal(clozeHtml(nested, 1, false), '<p><span class="cloze-gap">[…]</span> <span style="color: red">c</span></p>');
  assert.equal(clozeHtml(nested, 1, true), '<p><span class="cloze-answer">a <span style="color: red">b</span></span> <span style="color: red">c</span></p>');
  // Anki's syntax inside document text (imported fields).
  assert.equal(clozeHtml("<p>{{c1::Bern}} ist {{c2::Hauptstadt}}</p>", 1, false), '<p><span class="cloze-gap">[…]</span> ist Hauptstadt</p>');
  // A hint is text, never markup.
  assert.equal(clozeHtml('<p><span data-cloze="1" data-cloze-hint="&lt;b&gt;">x</span></p>', 1, false), '<p><span class="cloze-gap">[&lt;b&gt;]</span></p>');
  // The sanitizer keeps the mark (documents are cleaned on every save).
  assert.equal(cleanHtml('<p><span data-cloze="3" data-cloze-hint="h">x</span></p>'), '<p><span data-cloze="3" data-cloze-hint="h">x</span></p>');
});

const fields: Field[] = [
  { id: "title", name: "Text", type: "text" },
  { id: "back", name: "Rückseite", type: "text" },
  { id: "type", name: "Kartentyp", type: "select", options: ["Lückentext", "Eintippen", "Standard"] },
];
const settings = (extra: Record<string, unknown> = {}) => studySettingsSchema.parse({ version: 1, front: { field: "title" }, back: { field: "back" }, ...extra });

test("derivation: one card per cloze number; basic records with clozes become cloze cards", () => {
  const cards = deriveCards(settings({ reverse: true }), fields, { title: "{{c1::Paris}} liegt an der {{c2::Seine}}, {{c1::Frankreich}}", back: "" }, null);
  assert.deepEqual(
    cards.map((c) => [c.sub, c.kind, c.cloze]),
    [
      ["c1", "cloze", { n: 1, on: "front" }],
      ["c2", "cloze", { n: 2, on: "front" }],
    ],
  );
  // A cloze record without gaps gives no card; a basic one stays basic.
  assert.deepEqual(deriveCards(settings({ type: { fixed: "cloze" } }), fields, { title: "a", back: "b" }, null), []);
  assert.equal(deriveCards(settings(), fields, { title: "a", back: "b" }, null)[0].kind, "basic");
  // Gaps marked in the record's document (the back) ask the document; the
  // title is shown above as context.
  const doc = '<p>Die <span data-cloze="1">Zelle</span> ist klein.</p>';
  const [fromDoc] = deriveCards(settings({ back: { document: "all" } }), fields, { title: "Biologie" }, doc);
  assert.deepEqual([fromDoc.sub, fromDoc.cloze], ["c1", { n: 1, on: "back" }]);
  // The type from a select property, options by their name.
  const typed = deriveCards(settings({ type: { field: "type" } }), fields, { title: "rojo", back: "rot", type: "Eintippen" }, null);
  assert.deepEqual(typed.map((c) => [c.sub, c.kind]), [["", "typed"]]);
  const mapped = deriveCards(settings({ type: { field: "type", map: { Standard: "choice" } } }), fields, { title: "rojo", back: "rot", type: "Standard" }, null);
  assert.equal(mapped[0].kind, "choice");
  assert.equal(deriveCards(settings({ type: { field: "type" } }), fields, { title: "a", back: "b" }, null)[0].kind, "basic");
});

test("Markdown: the mark as {{cN::…}} and back", () => {
  const context = { url: (u: string) => u, linked: () => null };
  const html = '<p>Die <span data-cloze="1">Zelle</span> und <span data-cloze="2" data-cloze-hint="Organell"><strong>Kern</strong></span>.</p>';
  const markdown = htmlToMarkdown(html, context).trim();
  assert.equal(markdown, "Die {{c1::Zelle}} und {{c2::**Kern**::Organell}}.");
  const back = cleanHtml(markdownToRawHtml(markdown));
  assert.match(back, /<span data-cloze="1">Zelle<\/span>/);
  assert.match(back, /<span data-cloze="2" data-cloze-hint="Organell"><strong>Kern<\/strong><\/span>/);
  // Plain text in braces outside a cloze stays escaped text.
  assert.equal(htmlToMarkdown("<p>{{c1::nicht}}</p>", context).trim(), "\\{\\{c1::nicht\\}\\}");
  assert.doesNotMatch(cleanHtml(markdownToRawHtml("\\{\\{c1::nicht\\}\\}")), /data-cloze/);
});
