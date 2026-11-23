// Formulas written with dollars (#446): the rule (lib/math-dollars.ts), the
// Markdown import and pasted text that follow it, and the editor's input
// rule (lib/math-input.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { findDollarMath, dollarMathAtEnd } from "../lib/math-dollars";
import { markdownToHtml } from "../lib/markdown-import";
import { chatTextToHtml, looksLikeChatText } from "../lib/chat-paste";

// [text, the formulas found as [expression, display]]
const CASES: [string, [string, boolean][]][] = [
  ["$x$", [["x", false]]],
  ["$x^2$ and $y$", [["x^2", false], ["y", false]]],
  ["costs $5 and $10", []],
  ["$ x$", []],
  ["$x $", []],
  ["$x$5", []],
  ["\\$x$", []],
  ["\\$x\\$", []],
  ["$$", []],
  ["$$ $$", []],
  ["$$x^2$$", [["x^2", true]]],
  ["a $$\\frac{1}{2}$$ b", [["\\frac{1}{2}", true]]],
  ["$x$$", []],
  ["$$x$", []],
  ["$a\\$b$", [["a\\$b", false]]],
  ["between $5 and 10$ more", [["5 and 10", false]]],
  ["$5-$10", []],
  ["$a$, $b$.", [["a", false], ["b", false]]],
  ["$a\n\nb$", []],
  ["Preis 5 $ und 6 $, aber $x^2$ ist Mathe.", [["x^2", false]]],
];

test("the dollar rule (Pandoc's tex_math_dollars)", () => {
  for (const [text, expected] of CASES)
    assert.deepEqual(
      findDollarMath(text).map((m) => [m.expression, m.display]),
      expected,
      JSON.stringify(text),
    );
  // Inside a code span when asked (Markdown, pasted text).
  assert.deepEqual(findDollarMath("`$x$` and $y$", { codeSpans: true }).map((m) => m.expression), ["y"]);
  assert.deepEqual(findDollarMath("``a`$x$`` b", { codeSpans: true }), []);
  // The formula that ends where the "$" was just typed.
  assert.equal(dollarMathAtEnd("so $a^2$")?.expression, "a^2");
  assert.equal(dollarMathAtEnd("costs $5 and $"), null);
  assert.equal(dollarMathAtEnd("$a$ and $"), null);
  assert.equal(dollarMathAtEnd("$$"), null);
  assert.equal(dollarMathAtEnd("$$x$"), null);
  assert.deepEqual(dollarMathAtEnd("$$x$$"), { from: 0, to: 5, expression: "x", display: true });
  // Not longer than a formula may be.
  assert.equal(dollarMathAtEnd(`$${"x".repeat(10_001)}$`), null);
});

test("Markdown import reads $…$ and $$…$$ by the same rule", () => {
  const html = (md: string) => markdownToHtml(md).replace(/\n/g, "");
  assert.equal(html("$x$ and $y^2$"), '<p><span data-math="x">x</span> and <span data-math="y^2">y^2</span></p>');
  assert.equal(html("costs $5 and $10"), "<p>costs $5 and $10</p>");
  assert.equal(html("a $x$5 b"), "<p>a $x$5 b</p>");
  assert.equal(html("\\$x$ c"), "<p>$x$ c</p>");
  assert.equal(html("$$\nx^2\n$$"), '<div data-math="x^2">x^2</div>');
  assert.equal(html("$$x^2$$"), '<div data-math="x^2">x^2</div>');
  assert.equal(html("line\n$$\na < b\n$$\nafter"), '<p>line</p><div data-math="a &lt; b">a &lt; b</div><p>after</p>');
  // Inside a sentence an inline formula (no display formula inside a line).
  assert.equal(html("text $$a$$ in"), '<p>text <span data-math="a">a</span> in</p>');
  assert.equal(html("`$x$` code"), "<p><code>$x$</code> code</p>");
  assert.equal(html("```\n$x$\n```"), "<pre><code>$x$</code></pre>");
  assert.equal(html("$$ alone"), "<p>$$ alone</p>");
  // Flowplan's own export ($`…`$, escaped dollars in text) reads as before.
  assert.equal(html("$`a^2`$ and \\$5"), '<p><span data-math="a^2">a^2</span> and $5</p>');
});

test("pasted text: $…$ by the rule, $$…$$ as formula blocks", () => {
  assert.equal(looksLikeChatText("Setze $x$ ein."), true);
  assert.equal(looksLikeChatText("costs $5 and $10"), false);
  assert.equal(looksLikeChatText("Zeile eins\ncosts $5 and $10"), false);
  assert.equal(looksLikeChatText("Zeile eins\nmit $a+b$ darin"), true);
  const html = chatTextToHtml("Setze $x$ ein, costs $5 and $10\n$$\na^2\n$$\n`$y$` bleibt");
  assert.match(html, /<p>Setze <span data-math="x"><\/span> ein, costs \$5 and \$10<\/p>/);
  assert.match(html, /<div data-math="a\^2"><\/div>/);
  assert.match(html, /<code>\$y\$<\/code> bleibt/);
  // Not inside fenced code.
  assert.match(chatTextToHtml("**Code**\n```\necho $a$\n```"), /<code>echo \$a\$\n<\/code>/);
});

// ---- The editor ----

const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser", "KeyboardEvent"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
after(async () => {
  await win.happyDOM.close();
});

async function editorWith(content: string) {
  const { Editor } = await import("@tiptap/core");
  const { documentExtensions } = await import("../lib/document-schema");
  const { MathDollars, outsideDollarMath } = await import("../lib/math-input");
  const { default: Typography } = await import("@tiptap/extension-typography");
  const element = win.document.createElement("div");
  win.document.body.appendChild(element);
  const opened = { count: 0 };
  const editor = new Editor({
    element: element as unknown as HTMLElement,
    extensions: [...documentExtensions, outsideDollarMath(Typography), MathDollars.configure({ openBlock: () => opened.count++ })],
    content,
  });
  const { Selection } = await import("@tiptap/pm/state");
  editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
  const type = (text: string) => {
    const view = editor.view;
    for (const ch of text) {
      const { from, to } = view.state.selection;
      const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  // A key as the browser sends it (⌘ on Apple systems, Ctrl elsewhere).
  const press = (key: string, mod = false) => {
    const view = editor.view;
    const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
    const event = new win.KeyboardEvent("keydown", { key, ctrlKey: mod && !mac, metaKey: mod && mac, bubbles: true }) as unknown as KeyboardEvent;
    return view.someProp("handleKeyDown", (f) => f(view, event));
  };
  const blocks = () => (editor.getJSON().content || []) as { type: string; attrs?: Record<string, unknown>; content?: { type: string; text?: string; attrs?: Record<string, unknown> }[] }[];
  const inlineOf = (index = 0) => (blocks()[index]?.content || []).map((n) => (n.type === "text" ? n.text : `[${n.attrs?.expression}]`)).join("");
  return { editor, type, press, blocks, inlineOf, opened };
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

test("typing $…$ makes an inline formula; amounts stay text", async () => {
  const e = await editorWith("<p></p>");
  e.type("so $a^2$ and costs $5 and $10 then $b$");
  assert.equal(e.inlineOf(), "so [a^2] and costs $5 and $10 then [b]");
  assert.equal(e.editor.state.doc.firstChild?.child(1).type.name, "mathInline");
  e.editor.destroy();
});

test("typographic replacements leave the LaTeX between dollars alone", async () => {
  const e = await editorWith("<p></p>");
  e.type("x^2 -> $a^2 -> b$ y^2");
  assert.equal(e.inlineOf(), "x² → [a^2 -> b] y²");
  e.editor.destroy();
});

test("undo (⌘/Ctrl+Z) and Backspace right after the conversion bring the typed text back", async () => {
  const e = await editorWith("<p></p>");
  e.type("x $a^2$");
  assert.equal(e.inlineOf(), "x [a^2]");
  assert.ok(e.press("z", true));
  assert.equal(e.inlineOf(), "x $a^2$");
  e.editor.destroy();
  const b = await editorWith("<p></p>");
  b.type("$y$");
  assert.ok(b.press("Backspace"));
  assert.equal(b.inlineOf(), "$y$");
  // Typing on afterwards does not convert the same text again.
  b.type(" z");
  assert.equal(b.inlineOf(), "$y$ z");
  b.editor.destroy();
});

test("a digit right after the closing $ takes the formula back", async () => {
  const e = await editorWith("<p></p>");
  e.type("between $5 and 6$5 more");
  assert.equal(e.inlineOf(), "between $5 and 6$5 more");
  e.editor.destroy();
});

test("no formula inside code, escaped dollars or across other content", async () => {
  const code = await editorWith("<pre><code>x</code></pre>");
  code.type(" $a$");
  assert.equal(code.blocks()[0].type, "codeBlock");
  assert.equal(code.editor.state.doc.textContent, "x $a$");
  code.editor.destroy();
  const mark = await editorWith("<p><code>$a</code></p>");
  mark.type("$");
  assert.equal(mark.editor.state.doc.firstChild?.childCount, 1);
  assert.equal(mark.editor.state.doc.textContent, "$a$");
  mark.editor.destroy();
  const escaped = await editorWith("<p></p>");
  escaped.type("\\$a$ and $");
  assert.equal(escaped.inlineOf(), "\\$a$ and $");
  escaped.editor.destroy();
  const across = await editorWith('<p>$a <span data-math="b"></span> c</p>');
  across.type("$");
  assert.equal(across.inlineOf(), "$a [b] c$");
  across.editor.destroy();
});

test("$$…$$: alone in its paragraph a formula block, inside a sentence an inline formula", async () => {
  const e = await editorWith("<p></p>");
  e.type("$$x^2$$");
  assert.equal(e.blocks()[0].type, "mathBlock");
  assert.equal(e.blocks()[0].attrs?.expression, "x^2");
  assert.equal(e.blocks()[1].type, "paragraph");
  // The caret is in the paragraph after it.
  e.type("go");
  assert.equal(e.inlineOf(1), "go");
  e.editor.destroy();
  const s = await editorWith("<p></p>");
  s.type("see $$\\frac{1}{2}$$ here");
  assert.equal(s.inlineOf(), "see [\\frac{1}{2}] here");
  s.editor.destroy();
  const empty = await editorWith("<p></p>");
  empty.type("$$$$");
  assert.equal(empty.inlineOf(), "$$$$");
  empty.editor.destroy();
});

test("“$$” + space or Enter in an empty paragraph opens the formula dialog", async () => {
  const e = await editorWith("<p></p>");
  e.type("$$ ");
  await wait();
  assert.equal(e.opened.count, 1);
  assert.equal(e.blocks()[0].type, "paragraph");
  assert.equal(e.editor.state.doc.textContent, "");
  e.type("$$");
  assert.ok(e.press("Enter"));
  await wait();
  assert.equal(e.opened.count, 2);
  assert.equal(e.editor.state.doc.childCount, 1);
  assert.equal(e.editor.state.doc.textContent, "");
  // Not in a line with other text.
  e.type("a $$ ");
  await wait();
  assert.equal(e.opened.count, 2);
  assert.equal(e.inlineOf(), "a $$ ");
  e.editor.destroy();
});
