// Formatted text properties (#126): the inline Markdown of text values –
// parsing, escaping, plain text, the editor's round trip, HTML from paste
// and imports, and that nothing unsafe becomes a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotatedToInline,
  escapeInline,
  inlineToHtml,
  isFormattedText,
  normalizeInline,
  parseInline,
  safeHref,
  serializeInline,
  toPlain,
  type InlineRun,
} from "../lib/inline-markdown";
import { htmlToInline } from "../lib/inline-markdown-html";

test("parses bold, italic, strike, code, links and line breaks", () => {
  assert.deepEqual(parseInline("a **b** _c_ *d* ~~e~~ `f` [g](https://x.test/)\nh"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", italic: true },
    { text: " " },
    { text: "e", strike: true },
    { text: " " },
    { text: "f", code: true },
    { text: " " },
    { text: "g", href: "https://x.test/" },
    { text: "\nh" },
  ]);
  assert.deepEqual(parseInline("***both***"), [{ text: "both", bold: true, italic: true }]);
  assert.deepEqual(parseInline("**bold _and italic_**"), [
    { text: "bold ", bold: true },
    { text: "and italic", bold: true, italic: true },
  ]);
  assert.deepEqual(parseInline("[**x** y](mailto:a@b.test)"), [
    { text: "x", bold: true, href: "mailto:a@b.test" },
    { text: " y", href: "mailto:a@b.test" },
  ]);
  assert.deepEqual(parseInline("__bold__"), [{ text: "bold", bold: true }]);
  assert.deepEqual(parseInline("a\r\nb"), [{ text: "a\nb" }]);
});

test("no blocks and no accidental emphasis", () => {
  for (const s of ["# Heading", "- item", "> quote", "1. one", "| a | b |", "![x](https://x.test/a.png)"])
    assert.equal(toPlain(s), s.startsWith("!") ? "!x" : s);
  assert.equal(toPlain("snake_case_name"), "snake_case_name");
  assert.equal(toPlain("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(toPlain("**unclosed"), "**unclosed");
  assert.equal(toPlain("a ~ b ~~ c"), "a ~ b ~~ c");
  assert.equal(toPlain("`unclosed"), "`unclosed");
  assert.equal(toPlain("[label] (x)"), "[label] (x)");
  assert.equal(toPlain("** not bold **"), "** not bold **");
});

test("escapes keep * _ ~ ` [ ] \\ literal", () => {
  const plain = "*stars* _under_ ~~gone~~ `tick` [a](https://x.test) back\\slash";
  const escaped = escapeInline(plain);
  assert.equal(escaped, "\\*stars\\* \\_under\\_ \\~\\~gone\\~\\~ \\`tick\\` \\[a\\](https://x.test) back\\\\slash");
  assert.deepEqual(parseInline(escaped), [{ text: plain }]);
  assert.equal(toPlain(escaped), plain);
  assert.equal(escapeInline("a\r\nb"), "a\nb");
  // Other backslashes stay.
  assert.equal(toPlain("C:\\path\\n"), "C:\\path\\n");
});

test("code spans keep their content and use longer fences", () => {
  assert.deepEqual(parseInline("`a*b*`"), [{ text: "a*b*", code: true }]);
  assert.deepEqual(parseInline("``a`b``"), [{ text: "a`b", code: true }]);
  assert.equal(serializeInline([{ text: "a`b", code: true }]), "``a`b``");
  assert.equal(serializeInline([{ text: "`x", code: true }]), "`` `x ``");
  assert.deepEqual(parseInline("`` `x ``"), [{ text: "`x", code: true }]);
});

test("serializer round trips what the editor produces", () => {
  const cases: InlineRun[][] = [
    [{ text: "plain *with* stars_and_underscores [x] \\ ~" }],
    [{ text: "Hello " }, { text: "world", bold: true }, { text: "!\nNext line" }],
    [{ text: "foo" }, { text: "bar", italic: true }, { text: "baz" }],
    [{ text: "bold", bold: true }, { text: "italic", italic: true }],
    [{ text: "a", bold: true, italic: true, strike: true }],
    [{ text: "trailing space ", bold: true }, { text: "after" }],
    [{ text: " lead", italic: true }],
    [{ text: "link ", href: "https://example.test/a_(b)" }, { text: "bold", href: "https://example.test/a_(b)", bold: true }],
    [{ text: "code*", code: true }, { text: " and " }, { text: "x", code: true, bold: true }],
    [{ text: "two\nlines", bold: true }],
    [{ text: "l1\nl2", code: true }],
    [{ text: "_", italic: true }],
    [{ text: "a" }, { text: "*", bold: true }, { text: "b" }],
  ];
  for (const runs of cases) {
    const md = serializeInline(runs);
    const back = serializeInline(parseInline(md));
    assert.equal(back, md, `stable: ${JSON.stringify(runs)}`);
    assert.equal(toPlain(md), runs.map((r) => r.text).join(""), `plain: ${md}`);
  }
  assert.equal(serializeInline([{ text: "Hello " }, { text: "world", bold: true }]), "Hello **world**");
  assert.equal(serializeInline([{ text: "foo" }, { text: "bar", italic: true }]), "foo*bar*");
  assert.equal(serializeInline([{ text: "x", italic: true }]), "_x_");
  assert.equal(serializeInline([{ text: "trailing ", bold: true }, { text: "x" }]), "**trailing** x");
  assert.equal(normalizeInline("*a*  **b**"), "_a_  **b**");
});

test("random runs survive serialize → parse", () => {
  const chars = ["a", "é", "1", " ", "*", "_", "~", "`", "[", "]", "\\", "\n", "(", ")"];
  let seed = 126;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 3000; k++) {
    const runs: InlineRun[] = Array.from({ length: 1 + rnd(4) }, () => ({
      text: Array.from({ length: 1 + rnd(5) }, () => chars[rnd(chars.length)]).join(""),
      // Bold with italic inside is left out: "***a*b*c***" is ambiguous in
      // any Markdown.
      ...(rnd(4) === 0 ? { bold: true } : rnd(3) === 0 ? { italic: true } : {}),
      strike: rnd(5) === 0,
      code: rnd(5) === 0,
      href: rnd(6) === 0 ? `https://x.test/${rnd(2)}` : undefined,
    }));
    const md = serializeInline(runs);
    const back = parseInline(md);
    assert.equal(back.map((r) => r.text).join(""), runs.map((r) => r.text).join(""), md);
    assert.equal(serializeInline(back), md, md);
  }
});

test("links: only http, https and mailto; the rest keeps its label", () => {
  assert.equal(safeHref("https://a.test/x?y=1"), "https://a.test/x?y=1");
  assert.equal(safeHref("mailto:a@b.test"), "mailto:a@b.test");
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>", "vbscript:x", "/relative", "#hash", "ftp://x.test", " "])
    assert.equal(safeHref(bad), undefined, bad);
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ text: "click" }]);
  assert.deepEqual(parseInline("[click](data:text/html,x)"), [{ text: "click" }]);
  assert.deepEqual(parseInline("[x](JAVASCRIPT:alert(1))"), [{ text: "x" }]);
  // HTML stays text everywhere.
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ text: "<img src=x onerror=alert(1)>" }]);
  assert.equal(inlineToHtml("<b>x</b> **y** [z](javascript:alert(1)) [w](https://w.test/\"onmouseover=\"x)"),
    "&#60;b&#62;x&#60;/b&#62; <strong>y</strong> z <a href=\"https://w.test/&#34;onmouseover=&#34;x\" target=\"_blank\" rel=\"noopener noreferrer\">w</a>");
  assert.equal(htmlToInline('<a href="javascript:alert(1)">x</a>'), "x");
});

test("HTML → inline Markdown keeps marks and drops blocks", () => {
  assert.equal(htmlToInline("<p>Hello <b>bold</b> and <i>it</i>, <s>old</s> <code>a*b</code></p>"), "Hello **bold** and _it_, ~~old~~ `a*b`");
  assert.equal(htmlToInline('<a href="https://x.test/">site</a>'), "[site](https://x.test/)");
  assert.equal(htmlToInline("<h1>Title</h1><p>one</p><p>two<br>three</p>"), "**Title**\n\none\n\ntwo\nthree");
  assert.equal(htmlToInline("<ul><li>a</li><li>b</li></ul>"), "a\n\nb".replace("\n\n", "\n\n"));
  assert.equal(htmlToInline('<span style="font-weight:700">w</span><span style="font-style:italic">i</span><span style="text-decoration:line-through">s</span>'), "**w**_i_~~s~~");
  // Google Docs wraps everything in <b style="font-weight:normal">.
  assert.equal(htmlToInline('<b style="font-weight:normal" id="docs-internal-guid-1"><span>plain *text*</span></b>'), "plain \\*text\\*");
  assert.equal(htmlToInline("<script>alert(1)</script><style>p{}</style>ok <img src=x onerror=alert(1)>"), "ok");
  assert.equal(htmlToInline("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(htmlToInline("<u>under</u>"), "under");
});

test("annotated rich text (Notion, AFFiNE) → inline Markdown", () => {
  assert.equal(
    annotatedToInline([
      { text: "Read " },
      { text: "this", bold: true },
      { text: " now", italic: true, link: "https://x.test/" },
      { text: "\nbad", link: "javascript:x" },
    ]),
    "Read **this**[ _now_](https://x.test/)\nbad".replace("[ _now_]", " [_now_]"),
  );
});

test("only text properties other than the title are formatted", () => {
  const fields = [
    { id: "title", type: "text" as const },
    { id: "notes", type: "text" as const },
    { id: "n", type: "number" as const },
  ];
  assert.equal(isFormattedText(fields[0], fields), false);
  assert.equal(isFormattedText(fields[1], fields), true);
  assert.equal(isFormattedText(fields[2], fields), false);
  assert.equal(isFormattedText(undefined, fields), false);
});

test("toPlain of non-strings", () => {
  assert.equal(toPlain(undefined), "");
  assert.equal(toPlain(null), "");
  assert.equal(toPlain(3), "3");
});
