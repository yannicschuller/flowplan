import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlState, stateHtml, cleanHtml } from "../lib/document-server";
import { renderMath, mathError, MAX_MATH_LENGTH } from "../lib/math-render";
import { documentPreview } from "../lib/document-preview";
import type { Identity } from "../lib/types";
const html =
  '<p>Die Gleichung <span data-math="E = mc^2" class="math-inline">E = mc^2</span> bleibt im Satz.</p><div data-math="\\frac{a}{b}" class="math-block">\\frac{a}{b}</div>';
function roundtrip(source: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(source));
  const result = stateHtml(doc);
  doc.destroy();
  return result;
}
test("inline and block math keep their placement, expressions and surrounding formatting through canonical CRDT serialization", () => {
  const result = roundtrip(html);
  assert.match(
    result,
    /<p>Die Gleichung <span data-math="E = mc\^2" class="math-inline">E = mc\^2<\/span> bleibt im Satz\.<\/p>/,
  );
  assert.match(result, /<div data-math="\\frac\{a\}\{b\}" class="math-block">/);
  assert.equal(roundtrip(result), result);
  const markup = roundtrip(
    '<p><strong>A <span data-math="x &lt; y">x &lt; y</span> B</strong></p>',
  );
  assert.match(markup, /<strong>/);
  assert.match(markup, /data-math="x &lt; y"/);
  assert.equal(
    documentPreview(result).text,
    "Die Gleichung E = mc^2 bleibt im Satz. \\frac{a}{b}",
  );
});
test("math rendering distinguishes inline layout, validates errors and rejects trusted HTML, URLs and unbounded input", () => {
  assert.match(renderMath("x^2", false), /katex-display/);
  assert.doesNotMatch(renderMath("x^2", true), /katex-display/);
  assert.equal(mathError("\\frac{a}{b}", true), null);
  assert.ok(mathError("\\frac{", true));
  assert.ok(mathError(" ", true));
  assert.ok(mathError("x".repeat(MAX_MATH_LENGTH + 1), true));
  assert.match(
    renderMath("x".repeat(MAX_MATH_LENGTH + 1), true),
    /Formel zu lang/,
  );
  for (const expression of [
    String.raw`\href{javascript:alert(1)}{run}`,
    String.raw`\htmlClass{evil}{test}`,
    String.raw`\includegraphics{https://evil.invalid/x}`,
  ]) {
    const rendered = renderMath(expression, true);
    assert.doesNotMatch(rendered, /<a |<img |class="evil"/);
  }
  const imported = cleanHtml(
    '<p><span data-math="&lt;img src=x onerror=alert(1)&gt;" onclick="alert(1)">safe</span></p>',
  );
  assert.doesNotMatch(imported, /onclick=/);
  assert.doesNotMatch(renderMath("<img src=x onerror=alert(1)>", true), /<img/);
});
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-math-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { exportArchive, importArchive } = await import("../lib/archive");
const { sharedContent, mutateSharedContent } =
  await import("../lib/shared-content");
const { replaceRowDocument } = await import("../lib/row-documents");
const uid = id();
run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "Math owner",
  "math@test.invalid",
);
const owner: Identity = {
  id: uid,
  name: "Math owner",
  email: "math@test.invalid",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
};
const wid = createWorkspace(uid, "Math workspace"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const create = (kind = "document") =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Mathematik",
    kind,
  }).id as string;
const check = (pid: string) => {
  const data = pageData(owner, pid) as { html: string; state: string };
  assert.match(data.html, /class="math-inline"/);
  assert.match(data.html, /class="math-block"/);
  assert.match(roundtrip(data.html), /bleibt im Satz/);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.state, "base64"));
  assert.match(stateHtml(doc), /data-math="E = mc\^2"/);
  doc.destroy();
};
test("math survives document and record copies, templates, ZIP, restore and permission-checked guest editing", async () => {
  const pid = create();
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    pid,
  );
  check(pid);
  act({ action: "page.snapshot", pageId: pid });
  check(act({ action: "page.duplicate", pageId: pid }).id);
  const template = act({
    action: "template.save",
    pageId: pid,
    name: "Math template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Math from template",
      templateId: template,
    }).id,
  );
  const db = create("database");
  const row = act({
    action: "row.create",
    pageId: db,
    cells: { title: "Math row" },
  }).id;
  replaceRowDocument(row, html, uid);
  const dbCopy = act({ action: "page.duplicate", pageId: db }).id;
  const copied = pageData(owner, dbCopy) as any;
  assert.match(copied.rows[0].preview.html, /math-inline/);
  const destination = createWorkspace(uid, "Math restore");
  const imported = await importArchive(
    owner,
    destination,
    await exportArchive(owner, wid),
  );
  const restored = imported.pageIds[pid];
  check(restored);
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  )!.id;
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    "<p>Changed</p>",
    htmlState("<p>Changed</p>"),
    restored,
  );
  act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  check(restored);
  const read = act({
    action: "share.create",
    pageId: pid,
    name: "Read math",
    role: "viewer",
  }).token;
  const edit = act({
    action: "share.create",
    pageId: pid,
    name: "Edit math",
    role: "editor",
  }).token;
  assert.match(sharedContent(read).html, /math-inline/);
  const data = sharedContent(edit);
  const mutation = {
    action: "save",
    pageId: pid,
    version: data.version,
    title: data.title,
    html: html.replaceAll("mc^2", "mc^3"),
  };
  assert.throws(
    () => mutateSharedContent(read, mutation),
    (error: unknown) => (error as { status: number }).status === 403,
  );
  mutateSharedContent(edit, mutation);
  assert.match(sharedContent(read).html, /mc\^3/);
  assert.match(roundtrip(sharedContent(read).html), /math-inline/);
});
