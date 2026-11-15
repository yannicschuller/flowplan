// Formatted form descriptions (#306): the inline Markdown dialect with
// underline and text colours, what the server stores (unsafe parts
// stripped, plain legacy text untouched) and how it renders – as elements,
// never as HTML, colours as classes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-form-description-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { formSettings } = await import("../lib/forms");
const { formConfigSchema } = await import("../lib/form-settings");
const { cleanFormText, formTextPlain, FORM_TEXT } = await import("../lib/form-text");
const { parseInline, serializeInline, htmlRuns } = await import("../lib/inline-markdown");
type HtmlNode = import("../lib/inline-markdown").HtmlNode;
const { htmlToInline } = await import("../lib/inline-markdown-html");
const { FormText, InlineText } = await import("../components/inline-text");

const html = (value: string) => renderToStaticMarkup(createElement(FormText, { value }));

test("underline and colours are bracketed spans in the form dialect only", () => {
  assert.deepEqual(parseInline("a [b]{.underline} [c]{.color-blue} [d]{.underline .color-red}", FORM_TEXT), [
    { text: "a " },
    { text: "b", underline: true },
    { text: " " },
    { text: "c", color: "blue" },
    { text: " " },
    { text: "d", underline: true, color: "red" },
  ]);
  // Text properties (#126) read the same text as before.
  assert.deepEqual(parseInline("[b]{.underline}"), [{ text: "[b]{.underline}" }]);
  // Unknown classes and colours are dropped, the text stays.
  assert.deepEqual(parseInline("[x]{.color-hotpink .evil}", FORM_TEXT), [{ text: "x" }]);
  // No span without a closing brace or with anything but classes.
  assert.deepEqual(parseInline('[x]{style="color:red"}', FORM_TEXT), [{ text: '[x]{style="color:red"}' }]);
});

test("the editor's runs round-trip with links, nesting and every mark", () => {
  const runs = [
    { text: "Bitte " },
    { text: "alle", bold: true, underline: true },
    { text: " Felder " },
    { text: "rot", color: "red" as const, italic: true },
    { text: "\n" },
    { text: "Hilfe", href: "https://example.test/hilfe", color: "blue" as const },
    { text: " und " },
    { text: "code", code: true, strike: true },
  ];
  const markdown = serializeInline(runs);
  assert.deepEqual(parseInline(markdown, FORM_TEXT), runs);
  assert.equal(formTextPlain(markdown), "Bitte alle Felder rot\nHilfe und code");
});

test("random runs with spans survive serialize → parse", () => {
  const chars = ["a", " ", "*", "_", "~", "`", "[", "]", "{", "}", ".", "\\", "\n", "(", ")"];
  const colors = ["red", "blue", "green"] as const;
  let seed = 306;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 3000; k++) {
    const runs = Array.from({ length: 1 + rnd(4) }, () => ({
      text: Array.from({ length: 1 + rnd(5) }, () => chars[rnd(chars.length)]).join(""),
      ...(rnd(4) === 0 ? { bold: true } : rnd(3) === 0 ? { italic: true } : {}),
      strike: rnd(5) === 0,
      code: rnd(5) === 0,
      underline: rnd(4) === 0,
      color: rnd(4) === 0 ? colors[rnd(3)] : undefined,
      href: rnd(6) === 0 ? `https://x.test/${rnd(2)}` : undefined,
    }));
    const md = serializeInline(runs);
    const back = parseInline(md, FORM_TEXT);
    assert.equal(back.map((r) => r.text).join(""), runs.map((r) => r.text).join(""), md);
    assert.equal(serializeInline(back), md, md);
  }
});

test("pasted HTML keeps underline and the palette's colours, only in the form dialect", () => {
  const nodes: HtmlNode[] = [
    { type: "element" as const, name: "u", attrs: {}, children: [{ type: "text" as const, text: "u" }] },
    { type: "element" as const, name: "span", attrs: { style: "color: #1C7ED6" }, children: [{ type: "text" as const, text: "b" }] },
    { type: "element" as const, name: "span", attrs: { style: "color: #123456" }, children: [{ type: "text" as const, text: "x" }] },
  ];
  assert.deepEqual(htmlRuns(nodes, FORM_TEXT), [{ text: "u", underline: true }, { text: "b", color: "blue" }, { text: "x" }]);
  assert.deepEqual(htmlRuns(nodes), [{ text: "ubx" }]);
  // Imports into text properties never write spans.
  assert.equal(htmlToInline("<u>u</u>"), "u");
});

test("the server keeps legacy plain text as it was and strips what is unsafe", () => {
  const legacy = "Zeile eins\nZeile zwei: a * b, 5 < 6 & <b>kein HTML</b>";
  assert.equal(cleanFormText(legacy), legacy);
  assert.equal(cleanFormText("[klick](javascript:alert(1))"), "klick");
  assert.equal(cleanFormText("[x](data:text/html,<script>alert(1)</script>)"), "x");
  assert.equal(cleanFormText("[x]{.color-evil .underline}"), "[x]{.underline}");
  assert.equal(cleanFormText("**fett**"), "**fett**");
  // Idempotent.
  const once = cleanFormText("[a](https://x.test) [b]{.color-green}");
  assert.equal(cleanFormText(once), once);
});

test("descriptions render as elements, links safe, colours as classes, no style attributes", () => {
  const out = html('**fett** _kursiv_ [unter]{.underline} ~~weg~~ `code` [blau]{.color-blue} [Link](https://example.test/a)\nneu <script>alert(1)</script> [x](javascript:alert(1))');
  assert.match(out, /<strong>fett<\/strong>/);
  assert.match(out, /<em>kursiv<\/em>/);
  assert.match(out, /<u>unter<\/u>/);
  assert.match(out, /<s>weg<\/s>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<span class="text-color-blue">blau<\/span>/);
  assert.match(out, /<a href="https:\/\/example.test\/a" target="_blank" rel="noopener noreferrer" class="inline-link">Link<\/a>/);
  assert.match(out, /<br\/>neu &lt;script&gt;/);
  assert.doesNotMatch(out, /<script|javascript:|style=/);
  // A legacy plain description keeps its line breaks.
  assert.equal(html("Eins\nZwei"), "Eins<br/>Zwei");
  // Text properties do not read spans.
  assert.equal(renderToStaticMarkup(createElement(InlineText, { value: "[a]{.underline}" })), '<span class="inline-text">[a]{.underline}</span>');
});

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}

test("form.update stores cleaned descriptions", async () => {
  const owner = await user("owner");
  const wid = await createWorkspace(owner.id, "Forms");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const table = (await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Anfragen", kind: "database" })) as { id: string };
  await command(owner, {
    action: "form.update",
    pageId: table.id,
    config: formConfigSchema.parse({
      description: "**Hallo** [böse](javascript:alert(1)) [rot]{.color-red .onclick}\nZeile 2",
      descriptions: { title: "Alt\nohne Format * _", other: "[Hilfe](https://example.test)" },
    }),
  });
  const config = (await formSettings(table.id))!.config;
  assert.equal(config.description, "**Hallo** böse [rot]{.color-red}\nZeile 2");
  assert.equal(config.descriptions.title, "Alt\nohne Format * _");
  assert.equal(config.descriptions.other, "[Hilfe](https://example.test)");
});
