import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiMarkdown } from "../components/ai-markdown";

const html = (text: string, renderText?: (t: string, key: string) => ReactNode) => renderToStaticMarkup(createElement(AiMarkdown, { text, renderText }));

test("AI answers: Markdown becomes structure, never HTML from the answer", () => {
  const out = html("Thema war **„Binomische Formeln“** [5]:\n\n- **Wiederholung**:\n  - Plus-Formel: (a + b)² = a² + 2ab + b²\n  - Minus-Formel\n- *Aufgabe 2*: `r² − 2rs + s²`\n\n1. eins\n2. zwei");
  assert.match(out, /<strong>„Binomische Formeln“<\/strong>/);
  assert.match(out, /<ul><li><strong>Wiederholung<\/strong>:<ul><li>Plus-Formel: \(a \+ b\)² = a² \+ 2ab \+ b²<\/li>/);
  assert.match(out, /<em>Aufgabe 2<\/em>/);
  assert.match(out, /<code>r² − 2rs \+ s²<\/code>/);
  assert.match(out, /<ol><li>eins<\/li><li>zwei<\/li><\/ol>/);
  assert.ok(!out.includes("**"));
  // Raw HTML and script links stay text.
  const unsafe = html('<img src=x onerror="alert(1)"> [klick](javascript:alert(1)) [web](https://example.com)');
  assert.ok(!unsafe.includes("<img"));
  assert.match(unsafe, /&lt;img/);
  assert.ok(!unsafe.includes('href="javascript'));
  assert.match(unsafe, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">web<\/a>/);
});

test("AI answers: plain text pieces go through the citation renderer", () => {
  const seen: string[] = [];
  html("Erstens [1].\n\n- Zweitens [2][3]", (text) => {
    seen.push(text);
    return text;
  });
  assert.ok(seen.some((t) => t.includes("[1]")));
  assert.ok(seen.some((t) => t.includes("[2][3]")));
});
