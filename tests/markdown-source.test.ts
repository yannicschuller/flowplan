import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-md-source-"));
const { id, run, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { markdownSource } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const Y = await import("yjs");

const canonical = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
// Markdown and back, as the source view does it.
function roundTrip(html: string) {
  const source = markdownSource(canonical(html));
  const back = markdownToHtml(source.markdown, (href) => href, {
    source: true,
    blocks: (index) => source.blocks[index]?.html ?? null,
  });
  return { source, html: canonical(back) };
}
const board = "11111111-2222-4333-8444-555555555555",
  synced = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("common blocks survive Markdown and back unchanged", () => {
  const html =
    "<h1>Titel</h1><h2>Teil</h2><h3>Unterteil</h3>" +
    "<p><strong>fett</strong> <em>kursiv</em> <s>weg</s> <u>unter</u> <code>code</code> <mark>markiert</mark> " +
    '<a href="https://example.test/x">Link</a> <a href="/#page=abc">Seite</a> H<sub>2</sub>O x<sup>2</sup> ' +
    '<span style="color: #e03131">rot</span> <mark data-color="#ffec99" style="background-color: #ffec99">gelb</mark> ' +
    '<span data-spoiler="">geheim</span> <span data-mention="u-1" class="mention">@Ann</span> <span data-math="a^2">a^2</span>' +
    '<sup data-footnote="Eine Fußnote"></sup></p>' +
    "<ul><li><p>eins</p><ul><li><p>tief</p></li></ul></li><li><p>zwei</p></li></ul>" +
    '<ol start="3"><li><p>drei</p></li><li><p>vier</p></li></ol>' +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>erledigt</p></li><li data-type="taskItem" data-checked="false" data-due="2026-11-02"><p>offen</p></li></ul>' +
    "<blockquote><p>Zitat</p></blockquote>" +
    '<aside data-callout="warning"><p>Achtung</p></aside>' +
    '<pre><code class="language-ts">const a = 1;\n</code></pre>' +
    '<div data-math="x^2 + 1">x^2 + 1</div>' +
    '<div data-mermaid="graph TD&#10;A --&gt; B">graph</div>' +
    "<details><summary>Mehr</summary><div><p>Innen</p></div></details>" +
    "<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>" +
    '<p><img src="/api/files/11111111-1111-4111-8111-111111111111" alt="Bild"></p>' +
    "<hr><p>Ende</p>";
  const before = canonical(html);
  const { source, html: after } = roundTrip(html);
  assert.equal(after, before);
  // All of it is real Markdown: no block had to be kept aside.
  assert.equal(source.blocks.length, 0);
  assert.match(source.markdown, /^# Titel\n\n## Teil/);
  assert.match(source.markdown, /- \[ \] offen 📅 2026-11-02/);
  assert.match(source.markdown, /```math\nx\^2 \+ 1\n```/);
  assert.match(source.markdown, /<details>\n<summary>Mehr<\/summary>/);
  assert.match(source.markdown, /\[\^1\]: Eine Fußnote/);
  // Stable: a second round gives the same text.
  assert.equal(roundTrip(after).source.markdown, source.markdown);
});

test("blocks without Markdown form become markers and come back unchanged", () => {
  const html =
    "<p>Vorher</p>" +
    `<div data-linked-database="db-view-1" data-linked-source="src-1" data-linked-views="[{&quot;id&quot;:&quot;v&quot;}]" data-linked-version="1"></div>` +
    `<div data-synced-block="${synced}"></div>` +
    `<div data-whiteboard="${board}" data-whiteboard-height="420"></div>` +
    '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" style="width: 50%"></iframe>' +
    '<div data-columns="true"><div data-column="true"><p>links</p></div><div data-column="true"><p>rechts<sup data-footnote="in Spalte"></sup></p></div></div>' +
    "<table><tr><td colspan=\"2\"><p>verbunden</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>" +
    "<p>Nachher</p>";
  const before = canonical(html);
  const { source, html: after } = roundTrip(html);
  assert.equal(after, before);
  assert.deepEqual(
    source.blocks.map((block) => block.label),
    ["Verknüpfte Datenbank", "Synchronisierter Block", "Whiteboard", "Medium", "Spalten", "Tabelle"],
  );
  assert.match(source.markdown, /^Vorher\n\n<!-- flowplan:block 0 Verknüpfte Datenbank -->\n\n<!-- flowplan:block 1 /);
  // Moved markers move their blocks.
  const moved = source.markdown.replace("<!-- flowplan:block 2 Whiteboard -->\n\n", "").replace("Nachher", "Nachher\n\n<!-- flowplan:block 2 Whiteboard -->");
  const html2 = canonical(markdownToHtml(moved, (h) => h, { source: true, blocks: (i) => source.blocks[i]?.html ?? null }));
  assert.match(html2, new RegExp(`<p>Nachher</p><div data-whiteboard="${board}"`));
});

test("what Markdown cannot hold is named before applying", () => {
  const { source } = roundTrip('<p style="text-align: center" dir="rtl" data-indent="2">مرحبا</p>');
  assert.deepEqual(source.lossy.sort(), ["Ausrichtung", "Einzug", "Textrichtung"]);
});

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  reader = user("reader");
const wid = createWorkspace(owner.id, "Source");
run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const boot = bootstrap(owner, wid);
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Quelltext" }) as { id: string }).id;
const seed = (html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);

test("the commands: reading for readers, applying for editors, a version first, missing markers reported", () => {
  const html = canonical(`<p>Hallo</p><div data-synced-block="${synced}"></div><p>Welt</p>`);
  seed(html);
  // Readers get the text, but cannot apply it.
  const read = command(reader, { action: "document.markdown", pageId, html }) as ReturnType<typeof markdownSource>;
  assert.match(read.markdown, /^Hallo\n\n<!-- flowplan:block 0 Synchronisierter Block -->\n\nWelt\n$/);
  const blocks = read.blocks.map((block) => block.html);
  assert.throws(
    () => command(reader, { action: "document.markdown.apply", pageId, markdown: "x", blocks }),
    /Keine Berechtigung/,
  );
  // Without the marker: the check names the block and keeps no version.
  const versions = () => all("SELECT id FROM snapshots WHERE page_id=?", pageId).length;
  const count = versions();
  const check = command(owner, { action: "document.markdown.apply", pageId, markdown: "Hallo\n\nWelt", blocks, check: true }) as { missing: number[] };
  assert.deepEqual(check.missing, [0]);
  assert.equal(versions(), count);
  // Applying keeps the current state as a version and returns the new content.
  const done = command(owner, { action: "document.markdown.apply", pageId, markdown: "# Hallo\n\n<!-- flowplan:block 0 -->\n\nWelt", blocks }) as { html: string; missing: number[] };
  assert.deepEqual(done.missing, []);
  assert.match(done.html, new RegExp(`^<h1>Hallo</h1>\\n?<div data-synced-block="${synced}"`));
  assert.equal(versions(), count + 1);
  assert.equal(one<{ html: string }>("SELECT html FROM snapshots WHERE page_id=? ORDER BY created_at DESC, rowid DESC", pageId)?.html, html);
  // A copied marker does not copy the block.
  const twice = command(owner, { action: "document.markdown.apply", pageId, markdown: "<!-- flowplan:block 0 -->\n\n<!-- flowplan:block 0 -->", blocks, check: true }) as { html: string };
  assert.equal((twice.html.match(/data-synced-block/g) || []).length, 1);
  // Locked pages refuse.
  command(owner, { action: "page.update", pageId, patch: { locked: true } });
  assert.throws(() => command(owner, { action: "document.markdown.apply", pageId, markdown: "x", blocks: [] }), /gesperrt/);
  command(owner, { action: "page.update", pageId, patch: { locked: false } });
});
