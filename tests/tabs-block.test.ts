// The tabs block (#272): schema and stored HTML, sanitizing, Markdown in
// the Obsidian Tabs plugin's syntax (export and import, round trip), the
// search text, the exports, the changes of the tab strip, and the tab shown
// as editor state (never a change of the document).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tabs-block-"));
process.env.APP_URL = "https://flowplan.example.test";
const { EditorState, TextSelection } = await import("@tiptap/pm/state");
const { documentSchema } = await import("../lib/document-schema");
const { cleanHtml, htmlJson, jsonHtml, htmlState, stateHtml } = await import("../lib/document-server");
const { htmlToMarkdown, markdownSource } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { documentText } = await import("../lib/search-index");
const { documentXhtml } = await import("../lib/export-xhtml");
const { documentJira } = await import("../lib/export-jira");
const { documentConfluence } = await import("../lib/export-confluence");
const { buildDocx } = await import("../lib/export-docx");
const { readExportZip } = await import("./helpers/read-export-zip");
const { splitTabs, tabsMarkdown } = await import("../lib/tabs-markdown");
const { addTab, blocksToTabs, deleteTab, moveTab, newTabs, renameTab, tabsOf, tabsToBlocks } = await import("../lib/tabs-commands");
const { activeTab, tabsBlocksPlugin, tabsKey } = await import("../lib/tabs-view");
const { readActiveTabs, writeActiveTabs, TABS_STORAGE_KEY } = await import("../lib/tabs-memory");
const { documentBlocks } = await import("../lib/document-blocks");

const schema = documentSchema();
const SAMPLE =
  '<p>Vor</p><div data-tabs="true" data-block-id="tabs1234">' +
  '<section data-tab="true"><h4 class="editor-tab-title">Eins</h4><div data-tab-body="true"><p>Erster <strong>Text</strong></p></div></section>' +
  '<section data-tab="true"><h4 class="editor-tab-title">Zwei &amp; drei</h4><div data-tab-body="true"><ul><li><p>Punkt</p></li></ul><details><summary>Mehr</summary><div><p>Innen</p></div></details></div></section>' +
  "</div><p>Nach</p>";
const ctx = { url: (u: string) => u, linked: () => null };
const shape = (html: string) => {
  const doc = schema.nodeFromJSON(htmlJson(cleanHtml(html)));
  const tabs: { title: string; text: string; types: string[] }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "tab") {
      const types: string[] = [];
      node.forEach((child) => types.push(child.type.name));
      tabs.push({ title: node.attrs.title, text: node.textContent, types });
    }
  });
  return tabs;
};

test("schema: tabs hold tabs with a title and any blocks; the stored HTML shows every tab with its title", () => {
  const json = htmlJson(cleanHtml(SAMPLE)) as { content: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }[] };
  const tabs = json.content[1];
  assert.equal(tabs.type, "tabs");
  assert.equal(tabs.attrs?.blockId, "tabs1234");
  assert.deepEqual(shape(SAMPLE), [
    { title: "Eins", text: "Erster Text", types: ["paragraph"] },
    { title: "Zwei & drei", text: "PunktInnen", types: ["bulletList", "toggle"] },
  ]);
  const html = jsonHtml(json);
  assert.match(html, /<div data-block-id="tabs1234" data-tabs="true" class="editor-tabs"><section data-tab="true" class="editor-tab"><h4 class="editor-tab-title">Eins<\/h4><div data-tab-body="true" class="editor-tab-body"><p>Erster/);
  assert.match(html, /<h4 class="editor-tab-title">Zwei &amp; drei<\/h4>/);
  // The same again when read back (stable), also through Yjs (collaboration).
  assert.equal(jsonHtml(htmlJson(html)), html);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  // (A toggle's title also as an attribute there – as before #272.)
  const plain = (h: string) => h.replace(" title=\"Mehr\"", "");
  assert.equal(plain(stateHtml(doc)), plain(html));
  doc.destroy();
  // A tab is never empty; an empty title stays empty.
  assert.deepEqual(shape('<div data-tabs><section data-tab><h4 class="editor-tab-title"></h4><div data-tab-body></div></section></div>'), [
    { title: "", text: "", types: ["paragraph"] },
  ]);
  // A tab on its own (pasted HTML) gets a tabs block around it.
  assert.deepEqual(shape('<section data-tab><h4 class="editor-tab-title">X</h4><div data-tab-body><p>Y</p></div></section>'), [
    { title: "X", text: "Y", types: ["paragraph"] },
  ]);
});

test("sanitizer: the tabs attributes pass, nothing else does", () => {
  const out = cleanHtml(
    '<div data-tabs="true" onclick="x()" data-evil="1"><section data-tab="true" style="position:fixed" data-x="y"><h4 class="editor-tab-title" onmouseover="y()">T<script>z()</script></h4><div data-tab-body="true"><p>A</p></div></section></div>',
  );
  assert.equal(out, '<div data-tabs="true"><section data-tab="true"><h4 class="editor-tab-title">T</h4><div data-tab-body="true"><p>A</p></div></section></div>');
});

test("search: the text of every tab and its title is indexed", () => {
  const text = documentText(SAMPLE);
  for (const word of ["Eins", "Erster", "Zwei & drei", "Punkt", "Innen", "Nach"]) assert.ok(text.includes(word), word);
});

test("Markdown: the Obsidian Tabs plugin's code block, read back the same", () => {
  const md = htmlToMarkdown(SAMPLE, ctx);
  assert.match(md, /^Vor\n\n```tabs\ntab: Eins\nErster \*\*Text\*\*\n\ntab: Zwei & drei\n- Punkt\n\n<details>/);
  assert.match(md, /<\/details>\n```\n\nNach\n$/);
  const back = markdownToHtml(md);
  assert.deepEqual(shape(back), shape(SAMPLE));
  // Imported tabs get a block id (the tab shown is remembered by it).
  assert.match(back, /<div data-block-id="[a-z0-9]{8}" data-tabs="true">/);
  // And the Markdown of that is the same again.
  assert.equal(htmlToMarkdown(back, ctx), md);
});

test("Markdown: code blocks inside a tab, lines that look like a tab, empty tabs", () => {
  const html =
    '<div data-tabs="true"><section data-tab="true"><h4 class="editor-tab-title">python</h4><div data-tab-body="true"><pre><code class="language-python">print("```")\ntab: kein Tab</code></pre></div></section>' +
    '<section data-tab="true"><h4 class="editor-tab-title">Text</h4><div data-tab-body="true"><p>tab: auch kein Tab</p></div></section>' +
    '<section data-tab="true"><h4 class="editor-tab-title">Leer</h4><div data-tab-body="true"><p></p></div></section></div>';
  const md = htmlToMarkdown(html, ctx);
  // The outer fence is longer than any inside.
  assert.match(md, /^`````tabs\ntab: python\n````python\n/);
  assert.match(md, /\n&#116;ab: auch kein Tab\n/);
  const tabs = shape(markdownToHtml(md));
  assert.deepEqual(
    tabs.map((t) => t.title),
    ["python", "Text", "Leer"],
  );
  assert.ok(tabs[0].text.startsWith('print("```")\ntab: kein Tab'));
  assert.deepEqual(tabs[0].types, ["codeBlock"]);
  assert.equal(tabs[1].text, "tab: auch kein Tab");
  assert.equal(tabs[2].text, "");
});

test("Markdown import: the plugin's examples (options, ~~~ fences, nested tabs)", () => {
  const md = [
    "~~~tabs",
    "top, multi",
    "tab: TAB-ONE",
    "An innerTab in TAB-ONE 👇",
    "",
    "```tabs",
    "tab: inner tab one",
    "This is an inner tab.",
    "",
    "tab: inner tab two",
    "This is an inner tab.",
    "```",
    "",
    "tab: TAB-TWO",
    "~~~",
  ].join("\n");
  const html = markdownToHtml(md);
  const doc = schema.nodeFromJSON(htmlJson(html));
  const outer = doc.firstChild!;
  assert.equal(outer.type.name, "tabs");
  assert.deepEqual(
    tabsOf(doc, 0).map((t) => t.node.attrs.title),
    ["TAB-ONE", "TAB-TWO"],
  );
  const inner = outer.firstChild!.child(1);
  assert.equal(inner.type.name, "tabs");
  assert.deepEqual([inner.child(0).attrs.title, inner.child(1).attrs.title], ["inner tab one", "inner tab two"]);
  assert.deepEqual(splitTabs("tab:A\nx\ntab: B"), [
    { title: "A", body: "x" },
    { title: "B", body: "" },
  ]);
  assert.equal(tabsMarkdown([{ title: " A  b ", body: "" }]), "```tabs\ntab: A b\n```");
});

test("Markdown source view: tabs stay Markdown, kept-aside blocks inside them come back", () => {
  const html =
    '<div data-tabs="true" data-block-id="tabs1234"><section data-tab="true"><h4 class="editor-tab-title">A</h4><div data-tab-body="true"><p>Text</p><div data-columns="true"><div data-column="true"><p>L</p></div><div data-column="true"><p>R</p></div></div></div></section></div>';
  const source = markdownSource(html);
  assert.match(source.markdown, /^```tabs\ntab: A\nText\n\n<!-- flowplan:block 0 /);
  const back = markdownToHtml(source.markdown, (href) => href, { source: true, blocks: (i) => source.blocks[i]?.html ?? null });
  const doc = schema.nodeFromJSON(htmlJson(back));
  const tab = doc.firstChild!.firstChild!;
  assert.deepEqual(
    [tab.child(0).type.name, tab.child(1).type.name],
    ["paragraph", "columns"],
  );
});

test("exports: every tab with its title as a heading (EPUB/PDF, Jira, Confluence, Word)", async () => {
  const xhtml = documentXhtml(SAMPLE, { url: (u) => u, image: () => null });
  assert.match(xhtml, /<div class="tabs"><section class="tab"><h4 class="tab-title">Eins<\/h4><p>Erster <strong>Text<\/strong><\/p><\/section><section class="tab"><h4 class="tab-title">Zwei &amp; drei<\/h4>/);
  const jira = documentJira(SAMPLE, { url: (u) => u, image: () => null });
  assert.match(jira, /h4\. Eins\n\nErster \*Text\*\n\nh4\. Zwei & drei\n\n\* Punkt/);
  const confluence = documentConfluence(SAMPLE, { url: (u) => u, image: () => null });
  assert.match(confluence, /<h4>Eins<\/h4><p>Erster <strong>Text<\/strong><\/p><h4>Zwei &amp; drei<\/h4>/);
  const bytes = await buildDocx({ title: "T", sections: [{ title: "T", html: SAMPLE }], file: () => null, url: (raw) => raw });
  const word = (await readExportZip(bytes)).get("word/document.xml")!.toString("utf8");
  assert.match(word, /<w:pStyle w:val="Heading4"\/>[^]*?Eins[^]*?Erster[^]*?<w:pStyle w:val="Heading4"\/>[^]*?Zwei &amp; drei/);
});

// The editor side: plain states with the plugin.
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const tab = (title: string, ...content: ReturnType<typeof p>[]) => schema.nodes.tab.create({ title }, content.length ? content : [p("")]);
const state = (storageKey: string | null = null) =>
  EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [p("Intro"), schema.nodes.tabs.create({ blockId: "tabs1234" }, [tab("A", p("Alpha")), tab("B", p("Bravo")), tab("C", p("Charlie"))]), p("Ende")]),
    plugins: [tabsBlocksPlugin({ storageKey })],
  });
// "Intro" is 7 long with its tags: the tabs block starts there.
const TABS = 7;
const titles = (s: InstanceType<typeof EditorState>) => tabsOf(s.doc, TABS).map((t) => t.node.attrs.title);
const hidden = (s: InstanceType<typeof EditorState>) =>
  tabsKey
    .getState(s)!
    .decorations.find()
    .filter((d) => (d as unknown as { type: { attrs: { class?: string } } }).type.attrs.class === "editor-tab-hidden").length;

test("the tab shown is editor state: switching never changes the document", () => {
  const s0 = state();
  assert.equal(activeTab(s0, TABS), 0);
  assert.equal(hidden(s0), 2);
  const trn = s0.tr.setMeta(tabsKey, { select: TABS, index: 2 });
  const s1 = s0.apply(trn);
  assert.equal(trn.docChanged, false);
  assert.ok(s1.doc.eq(s0.doc));
  assert.equal(activeTab(s1, TABS), 2);
  assert.equal(hidden(s1), 2);
  // Typing before the block keeps the tab (known by its block id).
  const s2 = s1.apply(s1.tr.insertText("Neu ", 1));
  assert.equal(activeTab(s2, TABS + 4), 2);
  // The caret getting into a hidden tab (a jump, a search hit) shows it.
  const bravo = tabsOf(s2.doc, TABS + 4)[1].pos + 2;
  const s3 = s2.apply(s2.tr.setSelection(TextSelection.create(s2.doc, bravo)));
  assert.equal(activeTab(s3, TABS + 4), 1);
  // Others' changes (Yjs) do not switch tabs.
  const s4 = s3.apply(s3.tr.setSelection(TextSelection.create(s3.doc, tabsOf(s3.doc, TABS + 4)[0].pos + 2)).setMeta("y-sync$", { isChangeOrigin: true }));
  assert.equal(activeTab(s4, TABS + 4), 1);
});

test("the tab shown is remembered per person and device by block id", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
  writeActiveTabs(storage, "u1:page", new Map([["tabs1234", 2], ["@7", 1], ["other123", 0]]));
  assert.deepEqual(JSON.parse(values.get(TABS_STORAGE_KEY)!)["u1:page"].tabs, { tabs1234: 2 });
  assert.deepEqual([...readActiveTabs(storage, "u1:page")], [["tabs1234", 2]]);
  assert.deepEqual([...readActiveTabs(storage, "u2:page")], []);
  writeActiveTabs(storage, "u1:page", new Map());
  assert.equal(values.has(TABS_STORAGE_KEY), false);
  // Broken storage is no error.
  values.set(TABS_STORAGE_KEY, "{");
  assert.deepEqual([...readActiveTabs(storage, "u1:page")], []);
});

test("tab strip changes: add, rename, reorder, delete (never the last)", () => {
  let s = state();
  let trn = s.tr;
  assert.equal(addTab(trn, TABS, "D"), 3);
  s = s.apply(trn);
  assert.deepEqual(titles(s), ["A", "B", "C", "D"]);
  // The caret went into the new tab.
  assert.equal(s.selection.$from.node(2).attrs.title, "D");
  trn = s.tr;
  assert.ok(renameTab(trn, TABS, 0, "  Erster \n Tab "));
  s = s.apply(trn);
  assert.deepEqual(titles(s), ["Erster Tab", "B", "C", "D"]);
  trn = s.tr;
  assert.ok(moveTab(trn, TABS, 0, 2));
  s = s.apply(trn);
  assert.deepEqual(titles(s), ["B", "C", "Erster Tab", "D"]);
  assert.equal(tabsOf(s.doc, TABS)[2].node.textContent, "Alpha");
  trn = s.tr;
  assert.ok(moveTab(trn, TABS, 3, 0));
  s = s.apply(trn);
  assert.deepEqual(titles(s), ["D", "B", "C", "Erster Tab"]);
  for (const index of [0, 0, 0]) {
    trn = s.tr;
    assert.ok(deleteTab(trn, TABS, index));
    s = s.apply(trn);
  }
  assert.deepEqual(titles(s), ["Erster Tab"]);
  assert.equal(deleteTab(s.tr, TABS, 0), false);
  assert.equal(moveTab(s.tr, TABS, 0, 0), false);
});

test("turning blocks into tabs (by their headings) and back", () => {
  const html = "<h2>Eins</h2><p>a</p><h3>Unter</h3><p>b</p><h2>Zwei</h2><p>c</p>";
  const s0 = EditorState.create({ schema, doc: schema.nodeFromJSON(htmlJson(html)) });
  const trn = s0.tr;
  assert.ok(blocksToTabs(trn, 0, s0.doc.content.size, (n) => `Tab ${n}`));
  const s1 = s0.apply(trn);
  assert.equal(s1.doc.childCount, 1);
  assert.deepEqual(titles(s1).length, 0); // tabs at 0 now
  assert.deepEqual(
    tabsOf(s1.doc, 0).map((t) => [t.node.attrs.title, t.node.textContent]),
    [
      ["Eins", "aUnterb"],
      ["Zwei", "c"],
    ],
  );
  const back = s1.tr;
  assert.ok(tabsToBlocks(back, 0));
  const s2 = s1.apply(back);
  assert.equal(jsonHtml(s2.doc.toJSON()).replace(/ data-block-id="[^"]*"/g, ""), "<h3>Eins</h3><p>a</p><h3>Unter</h3><p>b</p><h3>Zwei</h3><p>c</p>");
  // Without headings: one tab.
  const plain = EditorState.create({ schema, doc: schema.nodeFromJSON(htmlJson("<p>x</p><p>y</p>")) });
  const t2 = plain.tr;
  assert.ok(blocksToTabs(t2, 0, plain.doc.content.size, (n) => `Tab ${n}`));
  assert.deepEqual(
    tabsOf(plain.apply(t2).doc, 0).map((t) => t.node.attrs.title),
    ["Tab 1"],
  );
});

test("block handles: the tabs block by its titles, no handle for a tab itself", () => {
  const s = EditorState.create({ schema, doc: schema.nodes.doc.create(null, [newTabs(schema, ["Eins", "Zwei"])]) });
  const blocks = documentBlocks(s.doc);
  assert.equal(blocks[0].node.type.name, "tabs");
  assert.match(blocks[0].label, /Eins · Zwei$/);
  assert.ok(!blocks.some((b) => b.node.type.name === "tab"));
  assert.match(String(s.doc.firstChild!.attrs.blockId), /^[a-z0-9]{8}$/);
});
