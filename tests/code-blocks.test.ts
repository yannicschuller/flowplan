import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeLanguages,
  highlightCode,
  renderCode,
  MAX_HIGHLIGHT_LENGTH,
} from "../lib/code-highlight";
import {
  htmlState,
  stateHtml,
  markdownHtml,
  escaped,
} from "../lib/document-server";
import type { Identity } from "../lib/types";
const source =
  'const message = "<script>alert(1)</script>";\n  // /path @member\nconsole.log(message);\n';
const html = `<pre data-code-wrap="true"><code class="language-javascript">${escaped(source).replaceAll("&quot;", '"')}</code></pre>`;
function roundtrip(html: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  const result = stateHtml(doc);
  doc.destroy();
  return result;
}
test("syntax rendering handles registered languages and aliases, escapes executable text and falls back for unknown or long blocks", () => {
  assert.equal(codeLanguages.length, 192);
  for (const language of [
    "javascript",
    "js",
    "typescript",
    "python",
    "rust",
    "sql",
    "xml",
    "bash",
  ]) {
    const output = renderCode(source, language);
    assert.doesNotMatch(output, /<script>|<img/);
    assert.equal(output.replace(/<\/?span[^>]*>/g, ""), escaped(source));
  }
  assert.match(renderCode(source, "javascript"), /hljs-keyword/);
  assert.deepEqual(highlightCode("unknown-language", source).children, [
    { type: "text", value: source },
  ]);
  const long = "x".repeat(MAX_HIGHLIGHT_LENGTH + 1);
  assert.equal(renderCode(long, "javascript"), long);
  assert.equal(
    renderCode('<img src=x onerror="alert(1)">', null),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
});
test("canonical code preserves whitespace, language and wrap without saving highlight spans or toolbar text", () => {
  const result = roundtrip(html);
  assert.equal(result, html);
  assert.equal(roundtrip(result), result);
  assert.doesNotMatch(result, /hljs-|Kopieren|Code-Sprache/);
  assert.equal(
    roundtrip(
      '<pre><code class="language-custom">  raw\n\tcode\n</code></pre>',
    ),
    '<pre><code class="language-custom">  raw\n\tcode\n</code></pre>',
  );
  assert.equal(
    roundtrip("<pre><code>  plain\n</code></pre>"),
    '<pre><code class="language-plaintext">  plain\n</code></pre>',
  );
});
test("Markdown fenced imports preserve language, tabs and literal fences, including unclosed and tilde blocks", () => {
  const result = markdownHtml("```javascript\n" + source + "```");
  assert.match(result, /class="language-javascript"/);
  assert.match(result, /  \/\/ \/path @member/);
  assert.doesNotMatch(result, /<script>/);
  assert.equal(
    markdownHtml('~~~python\n\tprint("x")\n~~~'),
    '<pre><code class="language-python">\tprint("x")\n</code></pre>',
  );
  assert.equal(
    markdownHtml("````js\n```\n````"),
    '<pre><code class="language-js">```\n</code></pre>',
  );
  assert.equal(
    markdownHtml("```rust\nlet x = 2;"),
    '<pre><code class="language-rust">let x = 2;\n</code></pre>',
  );
});
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-code-"));
const { run, id, one } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const { sharedContent, mutateSharedContent } =
  await import("../lib/shared-content");
const { replaceRowDocument } = await import("../lib/row-documents");
const uid = id();
run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "Code owner",
  "code@test.invalid",
);
const owner: Identity = {
  id: uid,
  name: "Code owner",
  email: "code@test.invalid",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
};
const wid = createWorkspace(uid, "Code blocks"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const create = (kind = "document", extra = {}) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Code fixture",
    kind,
    ...extra,
  }).id as string;
test("code and display preferences survive page/record copies, templates, ZIP and snapshots; guest edits retain permissions and literal code", async () => {
  const host = create();
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const check = (p: string) =>
    assert.equal((pageData(owner, p) as any).html, html);
  check(act({ action: "page.duplicate", pageId: host }).id);
  const template = act({
    action: "template.save",
    pageId: host,
    name: "Code template",
  }).id;
  check(create("document", { templateId: template }));
  act({ action: "page.snapshot", pageId: host });
  const database = create("database"),
    row = act({
      action: "row.create",
      pageId: database,
      cells: { title: "Code record" },
    }).id;
  replaceRowDocument(row, html, uid);
  const copied = pageData(
    owner,
    act({ action: "page.duplicate", pageId: database }).id,
  ) as any;
  assert.equal(copied.rows[0].preview.html, html);
  const destination = createWorkspace(uid, "Restore code"),
    restored = await importArchive(
      owner,
      destination,
      await exportArchive(owner, wid),
    );
  check(restored.pageIds[host]);
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored.pageIds[host],
  )!.id;
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<p>Changed</p>",
    htmlState("<p>Changed</p>"),
    restored.pageIds[host],
  );
  act({
    action: "snapshot.restore",
    pageId: restored.pageIds[host],
    snapshotId: snapshot,
  });
  check(restored.pageIds[host]);
  const token = act({
    action: "share.create",
    pageId: host,
    role: "editor",
    name: "Edit code",
  }).token;
  const read = act({
    action: "share.create",
    pageId: host,
    role: "viewer",
    name: "Read code",
  }).token;
  const data = sharedContent(token),
    change = {
      action: "save",
      pageId: host,
      version: data.version,
      title: data.title,
      html: html.replace("language-javascript", "language-typescript"),
    };
  assert.throws(() => mutateSharedContent(read, change), /erlaubt/);
  mutateSharedContent(token, change);
  assert.match(sharedContent(read).html, /language-typescript/);
  assert.match(sharedContent(read).html, /data-code-wrap="true"/);
  assert.doesNotMatch(sharedContent(read).html, /<script>/);
});
