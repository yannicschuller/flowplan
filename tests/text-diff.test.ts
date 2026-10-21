import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diff,
  compareParagraphs,
  compareBlocks,
  compareDocuments,
  htmlBlocks,
  decodeEntities,
  wordTokens,
  countWords,
  MAX_DIFF_WORDS,
  type TextBlock,
} from "../lib/text-diff";

function apply<T>(ops: { type: string; value: T }[]) {
  return {
    before: ops.filter((o) => o.type !== "added").map((o) => o.value),
    after: ops.filter((o) => o.type !== "removed").map((o) => o.value),
  };
}
test("myers diff reconstructs both sides with minimal edits", () => {
  assert.deepEqual(diff([], []), []);
  assert.deepEqual(diff(["a"], []), [{ type: "removed", value: "a" }]);
  assert.deepEqual(diff([], ["a"]), [{ type: "added", value: "a" }]);
  const ops = diff("ABCABBA".split(""), "CBABAC".split(""))!;
  assert.equal(ops.filter((o) => o.type !== "same").length, 5);
  let seed = 7;
  const random = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const a = Array.from(
      { length: Math.floor(random() * 30) },
      () => "abcd"[Math.floor(random() * 4)],
    );
    const b = a
      .filter(() => random() > 0.2)
      .flatMap((x) => (random() > 0.8 ? [x, "e"] : [x]));
    const result = diff(a, b)!;
    assert.deepEqual(apply(result), { before: a, after: b });
  }
});
test("paragraph comparison marks inline word changes and gives up on huge edits", () => {
  assert.deepEqual(
    compareParagraphs(
      ["Titel", "Der Hund bellt laut", "Ende"],
      ["Titel", "Der Hund schläft laut", "Neu", "Ende"],
    ),
    [
      { type: "same", text: "Titel" },
      {
        type: "changed",
        parts: [
          { type: "same", text: "Der Hund " },
          { type: "removed", text: "bellt" },
          { type: "added", text: "schläft" },
          { type: "same", text: " laut" },
        ],
      },
      { type: "added", text: "Neu" },
      { type: "same", text: "Ende" },
    ],
  );
  const many = (p: string) => Array.from({ length: 5000 }, (_, i) => p + i);
  assert.equal(compareParagraphs(many("a"), many("b")), null);
});

test("word tokens keep whitespace so the text joins back; words are counted without it", () => {
  assert.deepEqual(wordTokens("Der  Hund\tbellt "), ["Der", "  ", "Hund", "\t", "bellt", " "]);
  assert.equal(wordTokens("Der  Hund\tbellt ").join(""), "Der  Hund\tbellt ");
  assert.deepEqual(wordTokens(""), []);
  assert.equal(countWords("Der  Hund\tbellt "), 3);
  assert.equal(countWords("  "), 0);
  assert.equal(decodeEntities("A &amp; B &lt;c&gt; &#39;d&#39; &#x20AC; &nbsp;x &unknown;"), "A & B <c> 'd' €  x &unknown;");
});

test("html blocks keep headings, list items, table cells, quotes and code apart", () => {
  const html =
    "<h2>Titel</h2><p>Erster Absatz<br>zweite Zeile</p>" +
    '<ul><li data-type="taskItem"><label><input type="checkbox"></label><div><p>Aufgabe &amp; mehr</p></div></li><li><p>Punkt</p></li></ul>' +
    "<table><tbody><tr><th><p>Kopf</p></th><td><p>Zelle</p></td></tr></tbody></table>" +
    "<blockquote><p>Zitat</p></blockquote><pre><code>let x = 1;</code></pre>" +
    "<script>alert(1)</script><style>p{}</style><aside data-callout=\"tip\"><p>Hinweis</p></aside>Lose";
  assert.deepEqual(htmlBlocks(html), [
    { kind: "heading", text: "Titel" },
    { kind: "paragraph", text: "Erster Absatz" },
    { kind: "paragraph", text: "zweite Zeile" },
    { kind: "item", text: "Aufgabe & mehr" },
    { kind: "item", text: "Punkt" },
    { kind: "cell", text: "Kopf" },
    { kind: "cell", text: "Zelle" },
    { kind: "quote", text: "Zitat" },
    { kind: "code", text: "let x = 1;" },
    { kind: "paragraph", text: "Hinweis" },
    { kind: "paragraph", text: "Lose" },
  ] satisfies TextBlock[]);
  assert.deepEqual(htmlBlocks(""), []);
  assert.deepEqual(htmlBlocks("<p></p><p>  </p>"), []);
  // Unbalanced closing tags do not break the structure.
  assert.deepEqual(htmlBlocks("</li><p>a</p></td>"), [{ kind: "paragraph", text: "a" }]);
});

test("block comparison: unchanged, inserted, deleted and replaced blocks with a word summary", () => {
  const p = (text: string): TextBlock => ({ kind: "paragraph", text });
  const h = (text: string): TextBlock => ({ kind: "heading", text });
  const same = compareBlocks([h("Titel"), p("Eins zwei")], [h("Titel"), p("Eins zwei")]);
  assert.deepEqual(same, {
    changes: [
      { type: "same", kind: "heading", text: "Titel" },
      { type: "same", kind: "paragraph", text: "Eins zwei" },
    ],
    words: { added: 0, removed: 0 },
  });
  assert.deepEqual(compareBlocks([], []), { changes: [], words: { added: 0, removed: 0 } });

  const inserted = compareBlocks([p("Eins")], [p("Eins"), p("Zwei drei")]);
  assert.deepEqual(inserted, {
    changes: [
      { type: "same", kind: "paragraph", text: "Eins" },
      { type: "added", kind: "paragraph", text: "Zwei drei" },
    ],
    words: { added: 2, removed: 0 },
  });
  const deleted = compareBlocks([p("Eins"), p("Zwei drei")], [p("Eins")]);
  assert.deepEqual(deleted, {
    changes: [
      { type: "same", kind: "paragraph", text: "Eins" },
      { type: "removed", kind: "paragraph", text: "Zwei drei" },
    ],
    words: { added: 0, removed: 2 },
  });
  const replaced = compareBlocks([p("Der Hund bellt laut")], [p("Der Hund schläft laut")]);
  assert.deepEqual(replaced, {
    changes: [
      {
        type: "changed",
        kind: "paragraph",
        parts: [
          { type: "same", text: "Der Hund " },
          { type: "removed", text: "bellt" },
          { type: "added", text: "schläft" },
          { type: "same", text: " laut" },
        ],
      },
    ],
    words: { added: 1, removed: 1 },
  });
  // Words inside a changed block are counted part by part.
  const grown = compareBlocks([p("Der Hund bellt")], [p("Der Hund schläft tief und fest")]);
  assert.ok(typeof grown === "object");
  assert.deepEqual(grown.words, { added: 4, removed: 1 });
  assert.equal(grown.changes[0].type, "changed");
  // The same text as a heading instead of a paragraph is a structural
  // change, not a match – and not an inline change either.
  assert.deepEqual(compareBlocks([p("Titel")], [h("Titel")]), {
    changes: [
      { type: "removed", kind: "paragraph", text: "Titel" },
      { type: "added", kind: "heading", text: "Titel" },
    ],
    words: { added: 1, removed: 1 },
  });
});

test("document comparison works on stored HTML and refuses documents that are too large", () => {
  const result = compareDocuments(
    "<h1>Plan</h1><ul><li>Milch</li><li>Brot</li></ul>",
    "<h1>Plan</h1><ul><li>Milch</li><li>Butter</li><li>Brot</li></ul>",
  );
  assert.deepEqual(result, {
    changes: [
      { type: "same", kind: "heading", text: "Plan" },
      { type: "same", kind: "item", text: "Milch" },
      { type: "added", kind: "item", text: "Butter" },
      { type: "same", kind: "item", text: "Brot" },
    ],
    words: { added: 1, removed: 0 },
  });
  const words = Array.from({ length: MAX_DIFF_WORDS / 2 + 1 }, (_, i) => `w${i}`).join(" ");
  assert.equal(compareDocuments(`<p>${words}</p>`, `<p>${words}</p>`), "size");
  // Just below the cap the comparison still runs.
  const fewer = Array.from({ length: MAX_DIFF_WORDS / 2 - 1 }, (_, i) => `w${i}`).join(" ");
  const below = compareDocuments(`<p>${fewer}</p>`, `<p>${fewer}</p>`);
  assert.ok(typeof below === "object" && below.words.added === 0);
  // Too many differing blocks: no comparison, but the documents were small enough.
  const many = (p: string) => Array.from({ length: 5000 }, (_, i) => `<p>${p}${i}</p>`).join("");
  assert.equal(compareDocuments(many("a"), many("b")), "edits");
});
