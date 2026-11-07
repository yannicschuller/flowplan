import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  highlightTokens,
  isLanguageReady,
  loadLanguage,
  renderCode,
  renderCodeAsync,
  MAX_HIGHLIGHT_LENGTH,
} from "../lib/code-highlight";
import {
  canonicalLanguage,
  codeLanguages,
  fenceLanguage,
  languageLabel,
  searchLanguages,
  SHIKI_LANGUAGE_IDS,
} from "../lib/code-languages";
import { detectLanguage } from "../lib/code-detect";
import { markdownToHtml } from "../lib/markdown-import";
import { htmlToMarkdown } from "../lib/markdown";
import { EditorState } from "@tiptap/pm/state";
import { documentSchema } from "../lib/document-schema";
import { codeHighlightKey, codeHighlightPlugin } from "../lib/code-highlight-plugin";
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
test("every bundled Shiki language is offered by its full name, including the ones of issue #91", () => {
  const languages = codeLanguages();
  assert.ok(languages.length > 240, String(languages.length));
  assert.equal(languages[0].id, "plaintext");
  const names = new Set(languages.map((l) => l.name));
  for (const name of [
    "ABAP", "Angular HTML", "Angular TypeScript", "Apex", "Astro", "Svelte", "Vue", "JSX", "TSX",
    "Terraform", "TOML", "Typst", "Zig", "Prisma", "GDScript", "Mojo", "nushell", "Systemd Units",
    "SSH Config", "Git Commit Message", "Git Rebase Message", "Log file", "CSV", "TSV", "dotEnv",
    "MDX", "WGSL", "JavaScript", "C++", "C#", "Python",
  ])
    assert.ok(names.has(name), name);
  assert.equal(languageLabel("cpp"), "C++");
  assert.equal(languageLabel("angular-ts"), "Angular TypeScript");
  assert.equal(languageLabel("js"), "JavaScript");
  assert.equal(languageLabel(null), "Klartext");
  assert.equal(languageLabel("text"), "Klartext");
  assert.equal(languageLabel("custom"), "custom");
});

test("older highlight.js ids and aliases map to Shiki's ids; unknown languages stay", () => {
  const cases: Record<string, string> = {
    js: "javascript", ts: "typescript", py: "python", sh: "shellscript", bash: "shellscript",
    yml: "yaml", cpp: "cpp", csharp: "csharp", cs: "csharp", plaintext: "plaintext", text: "plaintext",
    txt: "plaintext", golang: "go", rs: "rust", tf: "terraform", dos: "bat", vbnet: "vb",
    objectivec: "objective-c", xhtml: "html", svg: "xml", x86asm: "asm", delphi: "pascal",
    django: "jinja", pgsql: "sql", JS: "javascript", " Python ": "python", fortran: "fortran-free-form",
  };
  for (const [legacy, id] of Object.entries(cases)) {
    assert.equal(canonicalLanguage(legacy), id, legacy);
    assert.ok(id === "plaintext" || SHIKI_LANGUAGE_IDS.has(id), id);
  }
  assert.equal(canonicalLanguage(""), "");
  assert.equal(fenceLanguage("custom-lang"), "custom-lang");
  assert.equal(fenceLanguage("Py"), "python");
});

test("the picker search matches names, ids, aliases and file extensions", () => {
  const first = (query: string) => searchLanguages(query)[0]?.id;
  assert.equal(first("ts"), "typescript");
  assert.equal(first("py"), "python");
  assert.equal(first("yml"), "yaml");
  assert.equal(first("tf"), "terraform");
  assert.equal(first(".rs"), "rust");
  assert.equal(first("c++"), "cpp");
  assert.equal(first("javascript"), "javascript");
  assert.equal(first("Angular Type"), "angular-ts");
  assert.equal(first("klartext"), "plaintext");
  assert.equal(first("txt"), "plaintext");
  assert.ok(searchLanguages("script").some((l) => l.id === "typescript"));
  assert.deepEqual(searchLanguages("zzzz-nothing"), []);
  assert.equal(searchLanguages("").length, codeLanguages().length);
});

test("syntax rendering loads grammars on demand, escapes executable text and falls back for unknown or long blocks", async () => {
  assert.equal(isLanguageReady("javascript"), false);
  // Not loaded yet: plain, escaped text and no ranges.
  assert.equal(highlightTokens("javascript", source), null);
  assert.equal(renderCode(source, "javascript"), escaped(source));
  for (const language of ["javascript", "js", "typescript", "python", "rust", "sql", "xml", "bash", "terraform", "svelte", "vue", "tsx"]) {
    const output = await renderCodeAsync(source, language);
    assert.doesNotMatch(output, /<script|<img/i);
    assert.equal(output.replace(/<\/?span[^>]*>/g, ""), escaped(source), language);
  }
  assert.equal(isLanguageReady("js"), true);
  // Loaded: synchronous from now on.
  assert.match(renderCode(source, "javascript"), /<span class="tok-keyword">const<\/span>/);
  assert.match(renderCode(source, "javascript"), /class="tok-comment[^"]*"/);
  assert.match(renderCode(source, "javascript"), /class="tok-string[^"]*"/);
  assert.deepEqual(highlightTokens("unknown-language", source), []);
  assert.equal(await renderCodeAsync(source, "unknown-language"), escaped(source));
  assert.equal(await loadLanguage("plaintext"), false);
  const long = "x".repeat(MAX_HIGHLIGHT_LENGTH + 1);
  assert.equal(renderCode(long, "javascript"), long);
  assert.equal(
    renderCode('<img src=x onerror="alert(1)">', null),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
});

test("editor decorations: plain text while a grammar loads, highlighted after, never stored in the document", async () => {
  const schema = documentSchema();
  const code = (language: string, text: string) => schema.nodes.codeBlock.create({ language }, schema.text(text));
  const doc = schema.nodes.doc.create(null, [code("go", "package main\nfunc main() {}\n"), schema.nodes.paragraph.create(null, schema.text("x"))]);
  const plugin = codeHighlightPlugin();
  let state = EditorState.create({ doc, plugins: [plugin] });
  assert.equal(codeHighlightKey.getState(state)!.find().length, 0);
  await loadLanguage("go");
  state = state.apply(state.tr.setMeta(codeHighlightKey, "refresh"));
  const found = codeHighlightKey.getState(state)!.find();
  assert.ok(found.length > 0);
  assert.equal(doc.textBetween(found[0].from, found[0].to), "package");
  // Typing in the paragraph moves the decorations along; the document has no classes.
  state = state.apply(state.tr.insertText("y", state.doc.content.size - 1));
  assert.equal(state.doc.textBetween(codeHighlightKey.getState(state)!.find()[0].from, codeHighlightKey.getState(state)!.find()[0].to), "package");
  assert.equal(JSON.stringify(state.doc.toJSON()).includes("tok-"), false);
});

test("pasted code gets a language suggestion only when it is clear", () => {
  assert.equal(detectLanguage('def greet(name):\n    print(f"Hello {name}")\n\nif __name__ == "__main__":\n    greet("x")'), "python");
  assert.equal(detectLanguage('{"name": "flowplan", "version": 1}'), "json");
  assert.equal(detectLanguage("const x = 1;\nconsole.log(x);\nfunction f() { return x === 1; }"), "javascript");
  assert.equal(detectLanguage("interface User { name: string; age: number }\nconst u: User = { name: 'a', age: 1 };\nconsole.log(u);"), "typescript");
  assert.equal(detectLanguage("SELECT id, name FROM users WHERE age > 21 ORDER BY name;"), "sql");
  assert.equal(detectLanguage("#!/bin/bash\nset -e\necho $HOME"), "shellscript");
  assert.equal(detectLanguage('package main\n\nimport "fmt"\n\nfunc main() {\n  x := 1\n  fmt.Println(x)\n}'), "go");
  assert.equal(detectLanguage("fn main() {\n    let mut v = vec![1, 2];\n    println!(\"{:?}\", v);\n}"), "rust");
  assert.equal(detectLanguage("#include <iostream>\nint main() { std::cout << 1; }"), "cpp");
  assert.equal(detectLanguage("<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>"), "html");
  assert.equal(detectLanguage("FROM node:22\nRUN npm ci\nCOPY . .\nCMD [\"node\", \"app.js\"]"), "dockerfile");
  // Prose and very short text: no suggestion.
  assert.equal(detectLanguage("Hello, this is just a sentence about our meeting tomorrow."), null);
  assert.equal(detectLanguage("x = 1"), null);
});

test("Markdown round trip: fences with older ids import and export as Shiki ids, unknown ones unchanged", () => {
  const context = { url: (url: string) => url, linked: () => null };
  const imported = markdownToHtml("```js\nconst a = 1;\n```\n\n```py\nprint(1)\n```\n\n```tf\nresource \"x\" \"y\" {}\n```\n\n```custom\nraw\n```\n\n```\nplain\n```");
  assert.match(imported, /class="language-javascript"/);
  assert.match(imported, /class="language-python"/);
  assert.match(imported, /class="language-terraform"/);
  assert.match(imported, /class="language-custom"/);
  const markdown = htmlToMarkdown(imported, context);
  assert.match(markdown, /```javascript\nconst a = 1;\n```/);
  assert.match(markdown, /```python\nprint\(1\)\n```/);
  assert.match(markdown, /```terraform\n/);
  assert.match(markdown, /```custom\nraw\n```/);
  // Stored blocks with an older id export with Shiki's id.
  assert.match(htmlToMarkdown('<pre><code class="language-sh">ls</code></pre>', context), /```shellscript\nls\n```/);
  assert.equal(markdownToHtml(markdown), markdownToHtml(htmlToMarkdown(markdownToHtml(markdown), context)));
});

test("canonical code preserves whitespace, language and wrap without saving highlight spans or toolbar text", () => {
  const result = roundtrip(html);
  assert.equal(result, html);
  assert.equal(roundtrip(result), result);
  assert.doesNotMatch(result, /tok-|Kopieren|Code-Sprache/);
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
  assert.doesNotMatch(result, /<script/i);
  assert.equal(
    markdownHtml('~~~python\n\tprint("x")\n~~~'),
    '<pre><code class="language-python">\tprint("x")\n</code></pre>',
  );
  assert.equal(
    markdownHtml("````js\n```\n````"),
    '<pre><code class="language-javascript">```\n</code></pre>',
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
await run(
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
const wid = await createWorkspace(uid, "Code blocks"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const create = async (kind = "document", extra = {}) =>
  (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Code fixture",
    kind,
    ...extra,
  })).id as string;
test("code and display preferences survive page/record copies, templates, ZIP and snapshots; guest edits retain permissions and literal code", async () => {
  const host = await create();
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const check = async (p: string) =>
    assert.equal(((await pageData(owner, p)) as any).html, html);
  await check((await act({ action: "page.duplicate", pageId: host })).id);
  const template = (await act({
    action: "template.save",
    pageId: host,
    name: "Code template",
  })).id;
  await check(await create("document", { templateId: template }));
  await act({ action: "page.snapshot", pageId: host });
  const database = await create("database"),
    row = (await act({
      action: "row.create",
      pageId: database,
      cells: { title: "Code record" },
    })).id;
  await replaceRowDocument(row, html, uid);
  const copied = (await pageData(
    owner,
    (await act({ action: "page.duplicate", pageId: database })).id,
  )) as any;
  assert.equal(copied.rows[0].preview.html, html);
  const destination = await createWorkspace(uid, "Restore code"),
    restored = await importArchive(
      owner,
      destination,
      await exportArchive(owner, wid),
    );
  await check(restored.pageIds[host]);
  const snapshot = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored.pageIds[host],
  ))!.id;
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<p>Changed</p>",
    htmlState("<p>Changed</p>"),
    restored.pageIds[host],
  );
  await act({
    action: "snapshot.restore",
    pageId: restored.pageIds[host],
    snapshotId: snapshot,
  });
  await check(restored.pageIds[host]);
  const token = (await act({
    action: "share.create",
    pageId: host,
    role: "editor",
    name: "Edit code",
  })).token;
  const read = (await act({
    action: "share.create",
    pageId: host,
    role: "viewer",
    name: "Read code",
  })).token;
  const data = await sharedContent(token),
    change = {
      action: "save",
      pageId: host,
      version: data.version,
      title: data.title,
      html: html.replace("language-javascript", "language-typescript"),
    };
  await assert.rejects(async () => await mutateSharedContent(read, change), /erlaubt/);
  await mutateSharedContent(token, change);
  assert.match((await sharedContent(read)).html, /language-typescript/);
  assert.match((await sharedContent(read)).html, /data-code-wrap="true"/);
  assert.doesNotMatch((await sharedContent(read)).html, /<script/i);
});
