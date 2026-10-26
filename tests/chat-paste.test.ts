import { test } from "node:test";
import assert from "node:assert/strict";
import { chatTextToHtml, looksLikeChatText } from "../lib/chat-paste";

const sample = `Grundlagen: Was ist ein Vektor?
Ein Vektor beschreibt eine Richtung und eine Länge.
\\[
\\vec{v}=
\\begin{pmatrix}
3\\\\
2
\\end{pmatrix}
\\]
Das bedeutet:
- 3 Einheiten in x-Richtung
- 2 Einheiten in y-Richtung
Setzen wir \\(t=0\\) ein.
Zeichen\tBedeutung
\\(g\\)\tName der Geraden
\\(t\\)\tParameter
☐ Habe ich einen Stützpunkt?
☐ Habe ich einen Richtungsvektor?
Fertig.`;

test("answers from chat assistants: formulas, lists, tables, checklists, paragraphs", () => {
  assert.equal(looksLikeChatText(sample), true);
  assert.equal(looksLikeChatText("Einfach ein Satz.\nUnd noch einer."), false);
  const html = chatTextToHtml(sample);
  // Display formula as a block with the LaTeX untouched.
  assert.match(html, /<div data-math="\\vec\{v\}=\n\\begin\{pmatrix\}\n3\\\\\n2\n\\end\{pmatrix\}"><\/div>/);
  // Inline formula inside a paragraph.
  assert.match(html, /<p>Setzen wir <span data-math="t=0"><\/span> ein\.<\/p>/);
  // Each line its own paragraph; list items stay one list.
  assert.match(html, /<p>Grundlagen: Was ist ein Vektor\?<\/p>\s*<p>Ein Vektor beschreibt/);
  assert.match(html, /<ul>\s*<li>3 Einheiten in x-Richtung<\/li>\s*<li>2 Einheiten in y-Richtung<\/li>\s*<\/ul>/);
  // Tab-separated lines: a table with formulas in the cells.
  assert.match(html, /<table>[\s\S]*<th>Zeichen<\/th>[\s\S]*<td><span data-math="g"><\/span><\/td>\s*<td>Name der Geraden<\/td>/);
  // Checklist.
  assert.match(html, /<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Habe ich einen Stützpunkt\?<\/p><\/li>/);
});

test("Markdown from the copy button and dollar formulas", () => {
  const html = chatTextToHtml("### Formel\n**Wichtig:** $$a^2+b^2=c^2$$\nPreis 5 $ und 6 $, aber $x^2$ ist Mathe.");
  assert.match(html, /<h3>Formel<\/h3>/);
  assert.match(html, /<strong>Wichtig:<\/strong>/);
  assert.match(html, /<div data-math="a\^2\+b\^2=c\^2"><\/div>/);
  assert.match(html, /Preis 5 \$ und 6 \$, aber <span data-math="x\^2"><\/span> ist Mathe\./);
  // Raw HTML is shown, never interpreted.
  assert.match(chatTextToHtml("**a**\n<img src=x onerror=alert(1)>"), /&lt;img/);
});

test("copied table cells keep backslashes and pipes", () => {
  const html = chatTextToHtml("Pfad\tZeichen\nC:\\Daten\\\ta\\|b\nx\ty");
  assert.match(html, /<td>C:\\Daten\\<\/td>\s*<td>a\\\|b<\/td>/);
  assert.equal(html.match(/<td>/g)?.length, 4);
});
