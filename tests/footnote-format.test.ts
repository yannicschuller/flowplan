import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { noteFromHtml, noteHtml, notePlain, noteSpans, renderNote, safeHref } from "../lib/footnote-format";

// Design review: footnotes take **bold**, *italic*, `code` and links. The
// text is never read as HTML; renderers build markup from the spans.

test("spans: bold, italic, code, links and bare addresses", () => {
  assert.deepEqual(noteSpans("plain"), [{ text: "plain" }]);
  assert.deepEqual(noteSpans("a **b** *c* `d`"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", code: true },
  ]);
  assert.deepEqual(noteSpans("**fett *und kursiv* hier**"), [
    { text: "fett ", bold: true },
    { text: "und kursiv", bold: true, italic: true },
    { text: " hier", bold: true },
  ]);
  assert.deepEqual(noteSpans("[Buch **S. 12**](https://example.test/b)"), [
    { text: "Buch ", href: "https://example.test/b" },
    { text: "S. 12", bold: true, href: "https://example.test/b" },
  ]);
  assert.deepEqual(noteSpans("Siehe https://example.test/a_b."), [
    { text: "Siehe " },
    { text: "https://example.test/a_b", href: "https://example.test/a_b" },
    { text: "." },
  ]);
  assert.deepEqual(noteSpans("Mail [uns](mailto:a@example.test)"), [{ text: "Mail " }, { text: "uns", href: "mailto:a@example.test" }]);
});

test("spans: what is no mark stays text", () => {
  // Spaces inside the stars, a lone star, unclosed marks, escapes.
  assert.equal(notePlain("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(notePlain("** nicht fett **"), "** nicht fett **");
  assert.equal(notePlain("*offen"), "*offen");
  assert.equal(notePlain("`offen"), "`offen");
  assert.equal(notePlain("\\*kein kursiv\\*"), "*kein kursiv*");
  assert.equal(notePlain("C:\\pfad"), "C:\\pfad");
  // Brackets without an allowed address are no link.
  assert.deepEqual(noteSpans("[Kapitel 2] und [x](javascript:alert(1))"), [{ text: "[Kapitel 2] und [x](javascript:alert(1))" }]);
  assert.deepEqual(noteSpans("`**kein fett**`"), [{ text: "**kein fett**", code: true }]);
});

test("plain text: marks gone, a link's address in brackets", () => {
  assert.equal(notePlain("**a** [Text](https://example.test) https://example.test/x"), "a Text (https://example.test) https://example.test/x");
});

test("HTML is escaped; only http(s) and mailto links", () => {
  assert.equal(
    noteHtml('<img src=x onerror="alert(1)"> **b** [l](https://e.test/?a=1&b="2")'),
    // A quote ends an address: no link with it, the rest is text.
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>b</strong> [l](<a href="https://e.test/?a=1&amp;b=">https://e.test/?a=1&amp;b=</a>&quot;2&quot;)',
  );
  assert.equal(noteHtml("[l](https://e.test/x) `<b>`"), '<a href="https://e.test/x">l</a> <code>&lt;b&gt;</code>');
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("https://e.test"), "https://e.test");
});

test("DOM: elements and text nodes, never parsed HTML", () => {
  const window = new Window();
  const target = window.document.createElement("span") as unknown as HTMLElement;
  renderNote(target, '**<b>x</b>** *kursiv* `code` [Seite](https://example.test) <script>alert(1)</script>');
  assert.equal(target.querySelectorAll("script").length, 0);
  assert.equal(target.querySelectorAll("b").length, 0);
  assert.equal(target.querySelector("strong")?.textContent, "<b>x</b>");
  assert.equal(target.querySelector("em")?.textContent, "kursiv");
  assert.equal(target.querySelector("code")?.textContent, "code");
  const link = target.querySelector("a")!;
  assert.equal(link.getAttribute("href"), "https://example.test");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.match(target.textContent || "", /<script>alert\(1\)<\/script>$/);
});

test("Markdown import: Marked's inline HTML back in the note's syntax", () => {
  const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  assert.equal(noteFromHtml("Erste <strong>fett</strong> und <em>schräg</em>", decode), "Erste **fett** und *schräg*");
  assert.equal(noteFromHtml('<a href="https://example.test/x">Seite</a>', decode), "[Seite](https://example.test/x)");
  assert.equal(noteFromHtml('<a href="https://example.test/x">https://example.test/x</a>', decode), "https://example.test/x");
  assert.equal(noteFromHtml('<a href="javascript:x">böse</a>', decode), "böse");
  assert.equal(noteFromHtml("<code>a*b</code> 2 * 3 <img src=x>", decode), "`a*b` 2 \\* 3 ");
  // What the import keeps renders as the original formatting.
  assert.equal(noteHtml(noteFromHtml("<strong>a</strong> [b] 2 * 3", decode)), "<strong>a</strong> [b] 2 * 3");
});
