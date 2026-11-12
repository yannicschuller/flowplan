// Jira wiki markup and Confluence storage format (#221): every node type,
// escaping, nesting, code with braces and CDATA ends, tables with pipes,
// and the export of a page and a record with the reader's rights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-export-jira-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { replaceRowDocument } = await import("../lib/row-documents");
const { documentJira, jiraText, codeLanguage, exportJira } = await import("../lib/export-jira");
const { documentConfluence, cdata, exportConfluence } = await import("../lib/export-confluence");
const { assertWellFormedXml } = await import("./helpers/xml-check");
const { exportName } = await import("../lib/export-name");

const BASE = "https://flowplan.example.test";
// Links and pictures as the export keeps them: absolute, files of the instance.
const context = {
  url: (raw: string) => {
    try {
      const url = new URL(raw, BASE);
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  },
  // The file 2222… is one the reader may not download.
  image: (raw: string) => (/^(https?:|\/api\/files\/)/.test(raw) && !raw.includes("22222222") ? new URL(raw, BASE).href : null),
  whiteboard: (pageId: string) => (pageId === "board" ? { title: "Skizze", url: `${BASE}/#page=board` } : null),
  linked: (source: string) => (source === "db" ? { title: "Aufgaben", url: `${BASE}/#page=db` } : null),
  ink: () => ({ text: "Handschrift" }),
};
const jira = (html: string, extra = {}) => documentJira(html, { ...context, ...extra });
const confluence = (html: string, extra = {}) => documentConfluence(html, { ...context, ...extra });
// Confluence's storage format is XHTML with the ac:/ri: prefixes: wrapped in
// a root that declares them, it must be well-formed XML.
const wellFormed = (body: string) =>
  assertWellFormedXml(`<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${body}</root>`);

test("Jira: headings, marks, links and a rule", () => {
  const out = jira(
    `<h1>Titel</h1><h3>Drei</h3><h6>Sechs</h6><p>Hallo <strong>fett</strong> <em>kursiv</em> <s>weg</s> <u>unter</u> <code>x = 1</code> <sup>2</sup> <sub>i</sub> ` +
      `<a href="https://example.org/a?b=1">Link</a> <a href="/#page=abc">intern</a> <a href="javascript:alert(1)">böse</a></p><hr><p><strong>fett </strong>danach</p>`,
  );
  assert.match(out, /^h1\. Titel$/m);
  assert.match(out, /^h3\. Drei$/m);
  assert.match(out, /^h6\. Sechs$/m);
  assert.ok(out.includes("Hallo *fett* _kursiv_ -weg- +unter+ {{x = 1}} ^2^ ~i~ "), out);
  assert.ok(out.includes("[Link|https://example.org/a?b=1]"));
  assert.ok(out.includes(`[intern|${BASE}/#page=abc]`));
  // A link that may not stay keeps its text.
  assert.ok(out.includes(" böse") && !out.includes("javascript"));
  assert.match(out, /^----$/m);
  // The space at the edge of a mark goes outside, or Jira shows the stars.
  assert.ok(out.includes("*fett* danach"), out);
});

test("Jira: special characters show as typed", () => {
  assert.equal(jiraText("a*b_c{d}[e]|f!g^h~i+j"), "a\\*b\\_c\\{d\\}\\[e\\]\\|f\\!g\\^h\\~i\\+j");
  // Dashes only where they would strike through, list or become a dash.
  assert.equal(jiraText("Projekt-Plan - heute -- morgen"), "Projekt-Plan \\- heute \\-\\- morgen");
  assert.equal(jiraText("-weg-"), "\\-weg\\-");
  // A backslash as an entity ("\\" would be a line break).
  assert.equal(jiraText("C:\\Daten"), "C:&#92;Daten");
  assert.equal(jiraText("Was?? (y) (i) (/) ok (yes)"), "Was\\?\\? \\(y) \\(i) \\(/) ok (yes)");
  assert.equal(jiraText("eins\nzwei"), "eins zwei");
  // Lines that would start markup.
  const out = jira(`<p># keine Liste</p><p>h2. kein Titel</p><p>bq. kein Zitat</p><p>* kein Punkt</p><p>- kein Strich</p><p>---- keine Linie</p>`);
  assert.ok(out.includes("\\# keine Liste"), out);
  assert.ok(out.includes("\\h2. kein Titel"));
  assert.ok(out.includes("\\bq. kein Zitat"));
  assert.ok(out.includes("\\* kein Punkt"));
  assert.ok(out.includes("\\- kein Strich"));
  assert.ok(out.includes("\\-\\-\\-\\- keine Linie"));
  assert.doesNotMatch(out, /^(#|h2\.|bq\.|\*|-)/m);
});

test("Jira: nested bullet, numbered and task lists", () => {
  const out = jira(
    `<ul><li><p>Eins</p><ol><li><p>Unter</p><ul><li><p>Tief</p></li></ul></li></ol></li><li><p>Zwei</p><p>Zweiter Absatz</p></li></ul>` +
      `<ol start="3"><li><p>Drei</p></li></ol>` +
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt</p></li><li data-type="taskItem" data-checked="false" data-due="2026-05-04"><p>Offen</p>` +
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-status="progress"><p>Läuft</p></li></ul></li>` +
      `<li data-type="taskItem" data-checked="true" data-status="cancelled"><p>Abgesagt</p></li></ul>`,
  );
  assert.ok(out.includes("* Eins\n*# Unter\n*#* Tief\n* Zwei \\\\ Zweiter Absatz"), out);
  assert.ok(out.includes("# Drei"));
  assert.ok(out.includes("* \\[x\\] Erledigt\n* \\[ \\] Offen (📅 2026-05-04)\n** \\[ \\] Läuft\n* \\[x\\] -Abgesagt-"), out);
});

test("Jira: code with braces, {noformat}, quotes and callouts", () => {
  const out = jira(
    `<pre><code class="language-js">function f() { return {a: 1}; } // {code} inside</code></pre>` +
      `<pre><code>plain {text} *stays*</code></pre>` +
      `<pre><code class="language-typescript">let x: {y: string};</code></pre>` +
      `<blockquote><p>Zitat</p><p>zwei</p></blockquote>` +
      `<aside data-callout="note"><p>Notiz</p></aside><aside data-callout="tip"><p>Tipp</p></aside><aside data-callout="important"><p>Wichtig</p></aside>` +
      `<aside data-callout="warning"><p>Warnung</p></aside><aside data-callout="caution"><p>Achtung</p></aside>` +
      `<details><summary>Mehr</summary><div><p>Innen</p></div></details>`,
  );
  // Code as typed, only a closing {code} inside is defused.
  assert.ok(out.includes("{code:javascript}\nfunction f() { return {a: 1}; } // {\u200bcode} inside\n{code}"), out);
  assert.ok(out.includes("{noformat}\nplain {text} *stays*\n{noformat}"));
  assert.ok(out.includes("{code:typescript}\nlet x: {y: string};\n{code}"));
  assert.ok(out.includes("{quote}\nZitat\n\nzwei\n{quote}"));
  assert.ok(out.includes("{info}\nNotiz\n{info}"));
  assert.ok(out.includes("{tip}\nTipp\n{tip}"));
  assert.ok(out.includes("{info:title=Wichtig}\nWichtig\n{info}"));
  assert.ok(out.includes("{note}\nWarnung\n{note}"));
  assert.ok(out.includes("{warning}\nAchtung\n{warning}"));
  assert.ok(out.includes("{panel:title=Mehr}\nInnen\n{panel}"));
  assert.equal(codeLanguage("sh"), "bash");
  assert.equal(codeLanguage("plaintext"), null);
  assert.equal(codeLanguage("<script>"), null);
});

test("Jira: tables with header cells, pipes, spans and lists in cells", () => {
  const out = jira(
    `<table><tr><th><p>Name</p></th><th><p>Wert | Einheit</p></th></tr><tr><td><p>a|b</p></td><td><p>1</p><p>2</p></td></tr>` +
      `<tr><td colspan="2"><p>breit</p></td></tr><tr><td><p></p></td><td><ul><li><p>x</p></li></ul></td></tr></table>`,
  );
  assert.ok(out.includes("||Name||Wert \\| Einheit||\n|a\\|b|1 \\\\ 2|\n|breit| |\n| |• x|"), out);
});

test("Jira: pictures, media, mentions, footnotes, math and placeholders", () => {
  const out = jira(
    `<p>Siehe <span data-mention="u1">@Anna</span><sup data-footnote="Quelle https://example.org/q"></sup> und <span data-math="a^2">a^2</span>.</p>` +
      `<img src="/api/files/11111111-1111-4111-8111-111111111111" alt="Bild" width="300"><img src="/api/files/22222222-2222-4222-8222-222222222222" alt="Inline">` +
      `<div data-whiteboard="board"></div><div data-whiteboard="weg"></div><div data-linked-database="x" data-linked-source="db"></div>` +
      `<div data-math="E = mc^2"></div><p>Zeile<br>neu</p><div data-link-card="https://example.org/x" data-link-title="Beispiel [1]" data-link-description="Mehr dazu"></div>`,
  );
  assert.ok(out.includes("[Beispiel \\[1\\]|https://example.org/x] – Mehr dazu"), out);
  assert.ok(out.includes("Siehe @Anna^1^ und {{a\\^2}}."), out);
  assert.ok(out.includes(`!${BASE}/api/files/11111111-1111-4111-8111-111111111111|width=300!`));
  assert.ok(out.includes("_Inline (nicht verfügbar)_"));
  assert.ok(out.includes(`Whiteboard: [Skizze|${BASE}/#page=board]`));
  assert.ok(out.includes("_Whiteboard nicht verfügbar_"));
  assert.ok(out.includes(`Verknüpfte Datenbank: [Aufgaben|${BASE}/#page=db]`));
  assert.ok(out.includes("{noformat}\nE = mc^2\n{noformat}"));
  assert.ok(out.includes("Zeile\\\\ neu"));
  assert.ok(out.includes("----\n*Fußnoten*\n# Quelle [https://example.org/q|https://example.org/q]"), out);
});

test("Confluence: code macro with language and CDATA, also with ]]> inside", () => {
  const out = confluence(
    `<pre><code class="language-js">if (a < b && c) { x = "]]>"; }</code></pre><pre><code>plain</code></pre><div data-math="x &lt; 1"></div>`,
  );
  assert.ok(
    out.includes(
      `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">javascript</ac:parameter><ac:plain-text-body><![CDATA[if (a < b && c) { x = "]]]]><![CDATA[>"; }]]></ac:plain-text-body></ac:structured-macro>`,
    ),
    out,
  );
  assert.ok(out.includes(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[plain]]></ac:plain-text-body></ac:structured-macro>`));
  assert.ok(out.includes("<![CDATA[x < 1]]>"));
  assert.equal(cdata("a]]>b"), "<![CDATA[a]]]]><![CDATA[>b]]>");
  wellFormed(out);
});

test("Confluence: callouts, toggles, tasks, tables, pictures and text", () => {
  const out = confluence(
    `<h2>Titel &amp; mehr</h2><p>Text mit <strong>fett</strong>, <mark>Markierung</mark>, <a href="https://example.org/?a=1&amp;b=2">Link</a> und <span data-mention="u1">@Anna</span><sup data-footnote="Notiz"></sup>.</p>` +
      `<aside data-callout="note"><p>Notiz</p></aside><aside data-callout="important"><p>Wichtig</p></aside><aside data-callout="warning"><p>W</p></aside><aside data-callout="caution"><p>C</p></aside><aside data-callout="tip"><p>T</p></aside>` +
      `<details><summary>Mehr</summary><div><p>Innen</p></div></details>` +
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt</p></li><li data-type="taskItem" data-checked="false" data-due="2026-05-04"><p>Offen</p>` +
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Unter</p></li></ul></li></ul>` +
      `<table><tr><th><p>A | B</p></th></tr><tr><td><p>1</p></td></tr></table>` +
      `<figure><table><tr><td><p>x</p></td></tr></table><figcaption>Zahlen</figcaption></figure>` +
      `<img src="/api/files/11111111-1111-4111-8111-111111111111" alt="Bild &quot;1&quot;" width="200"><img src="/api/files/22222222-2222-4222-8222-222222222222" alt="Inline">` +
      `<div data-columns><div data-column><p>Links</p></div><div data-column><p>Rechts</p></div></div>`,
  );
  assert.ok(out.includes("<h2>Titel &amp; mehr</h2>"));
  assert.ok(out.includes(`<a href="https://example.org/?a=1&amp;b=2">Link</a>`));
  assert.ok(out.includes("<span>Markierung</span>") && !out.includes("<mark"));
  assert.ok(out.includes("@Anna"));
  assert.ok(out.includes("<sup>1</sup>") && !out.includes("footnote-ref"));
  assert.ok(out.includes(`<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Notiz</p></ac:rich-text-body></ac:structured-macro>`));
  assert.ok(out.includes(`<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Wichtig</ac:parameter><ac:rich-text-body><p>Wichtig</p>`));
  assert.ok(out.includes(`<ac:structured-macro ac:name="note"><ac:rich-text-body><p>W</p>`));
  assert.ok(out.includes(`<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>C</p>`));
  assert.ok(out.includes(`<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>T</p>`));
  assert.ok(out.includes(`<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Mehr</ac:parameter><ac:rich-text-body><p>Innen</p>`));
  assert.ok(
    out.includes(
      `<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Erledigt</ac:task-body></ac:task>` +
        `<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Offen <time datetime="2026-05-04" />` +
        `<ac:task-list><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Unter</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task></ac:task-list>`,
    ),
    out,
  );
  assert.ok(out.includes("<table><tbody><tr><th><p>A | B</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>"));
  assert.ok(out.includes("<p><em>Zahlen</em></p><table><tbody>"), out);
  assert.ok(out.includes(`<p><ac:image ac:alt="Bild &quot;1&quot;" ac:width="200"><ri:url ri:value="${BASE}/api/files/11111111-1111-4111-8111-111111111111" /></ac:image></p>`));
  assert.ok(out.includes("<p><em>Inline (nicht verfügbar)</em></p>"));
  assert.ok(out.includes("<p>Links</p><p>Rechts</p>"));
  assert.ok(out.includes("<hr /><p><strong>Fußnoten</strong></p><ol><li>Notiz</li></ol>"));
  assert.doesNotMatch(out, /<(section|figure|aside|div)\b/);
  wellFormed(out);
});

// ---- The export of a page and a record ----

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await person("Autor"),
  stranger = await person("Fremd");
const wid = await createWorkspace(owner.id, "Werkstatt");
const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Doku" })) as { id: string }).id;
const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
const page = async (title: string, kind = "document", spaceId = space) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;
const write = async (pageId: string, html: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
async function file(pageId: string) {
  const fid = id();
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
  writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), Buffer.from("png"));
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "bild.png", "image/png", 3, owner.id);
  return `/api/files/${fid}`;
}

test("a page exports as Jira markup and Confluence storage format, with the reader's rights", async () => {
  const root = await page("Plan | Q4"),
    hidden = await page("Geheim", "document", privateSpace);
  const picture = await file(root),
    secret = await file(hidden);
  await write(root, `<h2>Ziele</h2><p><a href="/#page=${hidden}">geheim</a></p><img src="${picture}" alt="Bild"><img src="${secret}" alt="Geheim"><pre><code class="language-sql">SELECT '{x}' FROM t</code></pre>`);
  const j = await exportJira(owner, { pageId: root });
  assert.equal(j.name, `${exportName("Plan | Q4")}.jira.txt`);
  assert.equal(j.mime, "text/plain; charset=utf-8");
  assert.ok(j.text.startsWith("h2. Ziele\n"), j.text);
  assert.ok(j.text.includes(`!${BASE}${picture}!`));
  assert.ok(j.text.includes(`[geheim|${BASE}/#page=${hidden}]`), "the owner may read the private page");
  assert.ok(j.text.includes("{code:sql}\nSELECT '{x}' FROM t\n{code}"));
  const c = await exportConfluence(owner, { pageId: root });
  assert.ok(c.name.endsWith(".confluence.xhtml"));
  assert.ok(c.text.includes(`<ri:url ri:value="${BASE}${picture}" />`));
  wellFormed(c.text);
  const logged = await all<{ action: string }>("SELECT action FROM audit WHERE resource_id=? AND action LIKE '%.export'", root);
  assert.deepEqual(logged.map((r) => r.action).sort(), ["page.confluence.export", "page.jira.export"]);
  // Someone without access gets nothing.
  await assert.rejects(exportJira(stranger, { pageId: root }), (e: { status?: number }) => e.status === 403 || e.status === 404);
});

test("a picture of a page the reader may not see stays out", async () => {
  const viewer = await person("Leserin");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const root = await page("Öffentlich"),
    hidden = await page("Privat2", "document", privateSpace);
  const secret = await file(hidden);
  await write(root, `<p><a href="/#page=${hidden}">geheim</a></p><img src="${secret}" alt="Geheim">`);
  const j = await exportJira(viewer, { pageId: root });
  assert.ok(!j.text.includes(secret) && j.text.includes("_Geheim (nicht verfügbar)_"), j.text);
  assert.ok(!j.text.includes(`#page=${hidden}`) && j.text.includes("geheim"));
  const c = await exportConfluence(viewer, { pageId: root });
  assert.ok(!c.text.includes(secret));
});

test("a record exports with its properties and document; a whiteboard as its link", async () => {
  const table = await page("Aufgaben", "database");
  const schema = await database(table);
  await command(owner, {
    action: "database.update",
    pageId: table,
    version: schema.version,
    fields: [...schema.fields, { id: "amount", name: "Betrag", type: "number" }],
    views: schema.views,
  });
  const row = (await command(owner, { action: "row.create", pageId: table, cells: { [schema.fields[0].id]: "Erste|Aufgabe", amount: 3 } })) as { id: string };
  await replaceRowDocument(row.id, "<p>Notiz zum Eintrag</p>", owner.id);
  const j = await exportJira(owner, { pageId: table, rowId: row.id });
  assert.ok(j.text.includes("||Eigenschaft||Wert||"), j.text);
  assert.ok(j.text.includes("Erste\\|Aufgabe"));
  assert.ok(j.text.includes("|Betrag|3|"));
  assert.ok(j.text.includes("Notiz zum Eintrag"));
  const c = await exportConfluence(owner, { pageId: table, rowId: row.id });
  assert.ok(c.text.includes("<td><p>Erste|Aufgabe</p></td>"), c.text);
  wellFormed(c.text);
  const board = await page("Skizze", "whiteboard");
  const b = await exportJira(owner, { pageId: board });
  assert.equal(b.text, `Whiteboard: [Skizze|${BASE}/#page=${board}]\n`);
});
