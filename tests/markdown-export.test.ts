import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { marked } from "marked";
import { Window } from "happy-dom";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-markdown-"),
);
process.env.APP_URL = "https://flowplan.example.test";
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { replaceRowDocument } = await import("../lib/row-documents");
const { readExportZip: readZip } = await import("./helpers/read-export-zip");
const { exportMarkdown } = await import("../lib/markdown-export");
const { htmlToMarkdown, markdownText } = await import("../lib/markdown");
const { exportName } = await import("../lib/export-name");
const ctx = {
  url: (url: string) => (/^https?:|^\//.test(url) ? url : null),
  linked: () => null,
};
function parsed(markdown: string) {
  const doc = new Window().document;
  doc.body.innerHTML = marked.parse(markdown, { async: false });
  return doc;
}
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    name + "@example.test",
  );
  return {
    id: uid,
    name,
    email: name + "@example.test",
    disabled: 0,
    created_at: "",
    groups: [],
    isAdmin: false,
  };
}
const owner = user("Exporter"),
  viewer = user("Reader"),
  stranger = user("Stranger"),
  wid = createWorkspace(owner.id, "Markdown workspace");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = one<{ id: string }>(
  "SELECT id FROM spaces WHERE workspace_id=?",
  wid,
)!;
function page(title: string, kind = "document", parentId?: string) {
  return (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: space.id,
      title,
      kind,
      parentId,
    }) as { id: string }
  ).id;
}
function document(pageId: string, html: string) {
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    pageId,
  );
}
function file(
  pageId: string,
  name: string,
  bytes = Buffer.from("Binary attachment \0 ü"),
) {
  const fid = id();
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), {
    recursive: true,
  });
  writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), bytes);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    pageId,
    name,
    "text/plain",
    bytes.length,
    owner.id,
  );
  return { id: fid, bytes, url: `/api/files/${fid}` };
}
const exportPage = (
  pageId: string,
  format: "markdown" | "zip" = "markdown",
  includeSubpages = false,
  identity = owner,
) => exportMarkdown(identity, { pageId, format, includeSubpages });

test("Markdown preserves literal text, whitespace around marks and nested list semantics", () => {
  for (const literal of [
    "1. Plain text",
    "12) Plain text",
    "# Plain text",
    "- Plain text",
    "&copy;",
    "---",
    "*bold*",
    "[link](https://example.test)",
  ]) {
    const doc = parsed(markdownText(literal));
    assert.equal(doc.body.textContent?.trim(), literal);
    assert.equal(doc.querySelectorAll("li,h1,hr,strong").length, 0);
  }
  const html =
    '<h2>Heading</h2><p>&amp;copy; *literal* [brackets] $price &lt;script&gt;</p><p><strong> bold </strong><em> italic </em><s> removed </s><u>under</u> <mark>light</mark></p><ol start="3"><li><p>Third</p><ul><li><p>Nested</p></li></ul></li><li><p>Fourth</p></li></ol><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li><li data-type="taskItem" data-checked="false"><p>Open</p></li></ul>';
  const md = htmlToMarkdown(html, ctx),
    doc = parsed(md);
  assert.equal(doc.querySelector("h2")?.textContent, "Heading");
  assert.equal(
    doc.querySelector("p")?.textContent,
    "&copy; *literal* [brackets] $price <script>",
  );
  assert.equal(doc.querySelector("strong")?.textContent, "bold");
  assert.equal(doc.querySelector("em")?.textContent, "italic");
  assert.equal(doc.querySelector("del")?.textContent, "removed");
  assert.equal(doc.querySelector("ol")?.getAttribute("start"), "3");
  assert.equal(
    doc.querySelector("ol > li > ul > li")?.textContent?.trim(),
    "Nested",
  );
  assert.equal(doc.querySelectorAll('input[type="checkbox"]').length, 2);
  assert.ok(doc.querySelector("input[checked]"));
  assert.equal(doc.querySelectorAll("script").length, 0);
});

test("Markdown retains code fences, formulas, diagrams, merged tables and portable layouts", () => {
  const code = 'const source = "```";\n<script>alert(1)</script>';
  const html = `<pre><code class="language-javascript">${code.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre><p><span data-math="a_* + b_1">a_* + b_1</span></p><div data-math="x^2 + y_1">x^2 + y_1</div><div data-mermaid="flowchart LR&#10;A --&gt; B">flowchart LR</div><table><tr><th colspan="2"><p>Head</p></th></tr><tr><td><p><code>a|b</code></p><p>next</p></td><td><p>one | two</p></td></tr></table><details><summary>Details &lt;safe&gt;</summary><div><p>Hidden text</p></div></details><aside data-callout="true"><p>Important</p></aside>`;
  const md = htmlToMarkdown(html, ctx),
    doc = parsed(md);
  assert.equal(
    doc.querySelector("pre code.language-javascript")?.textContent,
    code + "\n",
  );
  assert.match(md, /\$`a_\* \+ b_1`\$/);
  assert.equal(
    doc.querySelector("code.language-math")?.textContent,
    "x^2 + y_1\n",
  );
  assert.equal(
    doc.querySelector("code.language-mermaid")?.textContent,
    "flowchart LR\nA --> B\n",
  );
  assert.equal(doc.querySelectorAll("tbody tr td").length, 2);
  assert.equal(doc.querySelector("td code")?.textContent, "a|b");
  assert.match(doc.querySelectorAll("td")[1].textContent!, /one \| two/);
  assert.equal(doc.querySelector("summary")?.textContent, "Details <safe>");
  assert.match(doc.querySelector("blockquote")?.textContent || "", /Important/);
  assert.equal(doc.querySelectorAll("script").length, 0);
});

test("ZIP contains navigable pages, record documents, byte-exact attachments and safe CSV", async () => {
  const root = page("Guide / Überblick"),
    child = page("../same", "document", root),
    other = page("../same", "document", root),
    table = page("Records", "database", root);
  page("𠮷".repeat(100), "document", root);
  const asset = file(root, "../notes.txt"),
    schema = database(table);
  command(owner, {
    action: "database.update",
    pageId: table,
    version: schema.version,
    fields: [
      ...schema.fields,
      { id: "amount", name: "Amount", type: "number" },
      { id: "notes", name: "Notes", type: "text" },
      { id: "file", name: "File", type: "files" },
    ],
    views: schema.views,
  });
  const row = command(owner, {
    action: "row.create",
    pageId: table,
    cells: {
      title: "=SUM(1,2)",
      amount: -5,
      notes: 'line 1\nline "2"',
      file: asset.url,
    },
  }) as { id: string };
  replaceRowDocument(
    row.id,
    `<h2>Record body</h2><p><a href="${asset.url}">File</a></p>`,
    owner.id,
  );
  document(
    root,
    `<h2>Start</h2><p><a href="/#page=${child}">Child</a></p><img src="${asset.url}" alt="Cover"><p><a href="https://example.org/external.png">Remote</a></p>`,
  );
  document(child, `<p><a href="/#page=${root}">Back</a></p>`);
  run("UPDATE pages SET cover=? WHERE id=?", asset.url, root);
  const before = all(
    "SELECT * FROM documents WHERE page_id IN (?,?,?)",
    root,
    child,
    other,
  );
  const exported = await exportPage(root, "zip", true),
    zip = await readZip(exported.bytes),
    index = zip.get("index.md")!.toString();
  assert.equal(exported.mime, "application/zip");
  const assets = [...zip.keys()].filter((k) => k.startsWith("assets/"));
  assert.equal(assets.length, 1);
  assert.deepEqual(zip.get(assets[0]), asset.bytes);
  const childPaths = [...zip.keys()].filter((k) => k.startsWith("pages/"));
  assert.equal(childPaths.length, 4);
  assert.ok(
    childPaths.every((path) => Buffer.byteLength(posix.basename(path)) <= 240),
  );
  assert.ok(childPaths.every((k) => !k.includes("..")));
  const childPath = childPaths.find((k) => k.includes(child))!;
  assert.match(zip.get(childPath)!.toString(), /\(<\.\.\/index.md>\)/);
  assert.ok(index.includes(childPath));
  assert.match(index, /https:\/\/example.org\/external.png/);
  const recordPath = [...zip.keys()].find((k) => k.startsWith("records/"))!,
    record = zip.get(recordPath)!.toString();
  assert.match(record, /## Record body/);
  assert.ok(
    record.includes(posix.relative(posix.dirname(recordPath), assets[0])),
  );
  const csv = zip.get(`tables/${table}.csv`)!.toString();
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"-5"/);
  assert.match(csv, /"line 1\nline ""2"""/);
  assert.deepEqual(
    all("SELECT * FROM documents WHERE page_id IN (?,?,?)", root, child, other),
    before,
  );
});

test("reader exports exclude private descendants, attachments, relation targets and rollup values", async () => {
  const root = page("Public"),
    hidden = page("Secret document", "document", root),
    table = page("Visible table", "database", root),
    secretDB = page("Secret database", "database", root);
  const privateSpace = command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Private",
    private: true,
  }) as { id: string };
  run(
    "UPDATE pages SET space_id=? WHERE id IN (?,?)",
    privateSpace.id,
    hidden,
    secretDB,
  );
  const asset = file(hidden, "secret-name.txt", Buffer.from("SECRET BYTES"));
  const secret = command(owner, {
    action: "row.create",
    pageId: secretDB,
    cells: { title: "SECRET RECORD" },
  }) as { id: string };
  const schema = database(table);
  command(owner, {
    action: "database.update",
    pageId: table,
    version: schema.version,
    fields: [
      ...schema.fields,
      { id: "rel", name: "Related", type: "relation", relationPage: secretDB },
      {
        id: "roll",
        name: "Count",
        type: "rollup",
        relationField: "rel",
        rollupField: "title",
        aggregate: "count",
      },
      { id: "file", name: "File", type: "files" },
    ],
    views: schema.views,
  });
  command(owner, {
    action: "row.create",
    pageId: table,
    cells: { title: "Visible", rel: [secret.id], file: asset.url },
  });
  document(
    root,
    `<p><a href="/#page=${hidden}">Restricted link</a><a href="${asset.url}">Restricted attachment</a></p><div data-linked-database="${id()}" data-linked-source="${secretDB}"></div><p><a href="javascript:alert(1)">Unsafe</a></p>`,
  );
  run("UPDATE pages SET locked=1 WHERE id=?", root);
  const zip = await readZip(
      (await exportPage(root, "zip", true, viewer)).bytes,
    ),
    text = [...zip.values()].map((v) => v.toString()).join("\n");
  for (const restricted of [
    hidden,
    secretDB,
    secret.id,
    asset.id,
    "SECRET RECORD",
    "SECRET BYTES",
    "Secret document",
    "Secret database",
    "secret-name.txt",
  ])
    assert.ok(!text.includes(restricted), restricted);
  assert.match(text, /Nicht verfügbar/);
  assert.ok(!text.includes("javascript:"));
  assert.equal(
    [...zip.keys()].filter((k) => k.startsWith("assets/")).length,
    0,
  );
  await assert.rejects(exportPage(root, "zip", true, stranger), {
    status: 403,
  });
  await assert.rejects(exportPage(hidden, "markdown", false, viewer), {
    status: 403,
  });
});

test("single Markdown keeps live links, inline record bodies and rejects invalid tree exports", async () => {
  assert.equal(exportName("CON.txt"), "_CON.txt");
  assert.doesNotMatch(exportName("../.."), /\/|\.\./);
  const root = page("Single"),
    child = page("Subpage", "document", root),
    asset = file(root, "file.txt");
  document(
    root,
    `<p><a href="${asset.url}">File</a><a href="/#page=${child}">Page</a></p>`,
  );
  const result = await exportPage(root),
    md = result.bytes.toString();
  assert.equal(result.name, "Single.md");
  assert.equal(result.mime, "text/markdown; charset=utf-8");
  assert.ok(md.includes(`https://flowplan.example.test${asset.url}`));
  assert.ok(md.includes(`https://flowplan.example.test/#page=${child}`));
  await assert.rejects(exportPage(root, "markdown", true), { status: 400 });
  const table = page("Inline records", "database"),
    row = command(owner, {
      action: "row.create",
      pageId: table,
      cells: { title: "Entry" },
    }) as { id: string };
  replaceRowDocument(row.id, "<p>Full record body</p>", owner.id);
  const record = (await exportPage(table)).bytes.toString();
  assert.match(record, /Full record body/);
  assert.ok(record.includes(`<a id="record-${row.id}"></a>`));
  command(owner, { action: "page.delete", pageId: root });
  await assert.rejects(exportPage(root), { status: 404 });
});

test("missing referenced files abort the ZIP without silently dropping attachments", async () => {
  const root = page("Missing attachment"),
    asset = file(root, "missing.txt");
  document(root, `<p><a href="${asset.url}">Attachment</a></p>`);
  unlinkSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", asset.id));
  await assert.rejects(exportPage(root, "zip"), { status: 409 });
  assert.match(
    (await exportPage(root)).bytes.toString(),
    /https:\/\/flowplan.example.test\/api\/files/,
  );
});
