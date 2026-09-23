import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DIAGRAM,
  diagramSourceError,
  MAX_DIAGRAM_LENGTH,
} from "../lib/mermaid-source";
import {
  htmlState,
  stateHtml,
  escaped,
  markdownHtml,
} from "../lib/document-server";
import { documentPreview } from "../lib/document-preview";
import type { Identity } from "../lib/types";
const source = DEFAULT_DIAGRAM + '\n  C --> D["Prüfen & abschließen"]';
const html = `<div data-mermaid="${escaped(source)}" class="mermaid-block">${escaped(source).replaceAll("&quot;", '"')}</div>`;
function canonical(input: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(input));
  const result = stateHtml(doc);
  doc.destroy();
  return result;
}
test("Mermaid sources preserve syntax and reject resource/configuration injection before rendering", () => {
  assert.equal(diagramSourceError(source), null);
  assert.equal(
    diagramSourceError("sequenceDiagram\n  Alice->>Bob: Hallo"),
    null,
  );
  for (const input of [
    "",
    "a".repeat(MAX_DIAGRAM_LENGTH + 1),
    '%%{init: {securityLevel: "loose"}}%%\ngraph LR\nA-->B',
    "---\nconfig:\n theme: dark\n---\ngraph LR\nA-->B",
    'graph LR\nA["<img src=x onerror=alert(1)>"]',
    'graph LR\nA@{ img: "https://example.org/tracker" }',
    "graph LR\nclassDef red fill:url(https://example.org/x)",
    '@import "https://example.org/x"',
  ])
    assert.ok(diagramSourceError(input), input);
});
test("Mermaid nodes roundtrip through HTML/Yjs and Markdown without storing generated SVG", () => {
  assert.equal(canonical(html), html);
  assert.equal(canonical(canonical(html)), html);
  const imported = canonical(markdownHtml("```mermaid\n" + source + "\n```"));
  assert.match(imported, /data-mermaid=/);
  assert.match(imported, /Prüfen &amp; abschließen/);
  assert.doesNotMatch(imported, /<svg|<img|<script/);
  const preview = documentPreview(html);
  assert.ok(preview.hasContent);
  assert.ok(preview.text.includes("Prüfen & abschließen"));
  assert.equal(preview.image, undefined);
  const unsafe = 'graph LR\nA["<script>alert(1)</script>"]';
  assert.doesNotMatch(
    canonical(
      `<div data-mermaid="${escaped(unsafe)}">${escaped(unsafe)}</div>`,
    ),
    /<script>/,
  );
});
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-mermaid-"),
);
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
  "Diagram owner",
  "diagram@test.invalid",
);
const owner: Identity = {
  id: uid,
  name: "Diagram owner",
  email: "diagram@test.invalid",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
};
const wid = createWorkspace(uid, "Diagrams"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const create = (kind = "document", extra = {}) =>
  act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Diagram fixture",
    kind,
    ...extra,
  }).id as string;
test("diagram sources survive copies, templates, records, archives and snapshots with guest rights enforced", async () => {
  const host = create();
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const check = (page: string) =>
    assert.equal((pageData(owner, page) as any).html, html);
  check(act({ action: "page.duplicate", pageId: host }).id);
  check(
    create("document", {
      templateId: act({
        action: "template.save",
        pageId: host,
        name: "Diagram",
      }).id,
    }),
  );
  act({ action: "page.snapshot", pageId: host });
  const database = create("database"),
    row = act({
      action: "row.create",
      pageId: database,
      cells: { title: "Diagram entry" },
    }).id;
  replaceRowDocument(row, html, uid);
  assert.equal(
    (
      pageData(
        owner,
        act({ action: "page.duplicate", pageId: database }).id,
      ) as any
    ).rows[0].preview.html,
    html,
  );
  const destination = createWorkspace(uid, "Restored diagrams");
  const restored = await importArchive(
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
    "<p>changed</p>",
    htmlState("<p>changed</p>"),
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
    name: "Edit diagrams",
  }).token;
  const read = act({
    action: "share.create",
    pageId: host,
    role: "viewer",
    name: "View diagrams",
  }).token;
  const data = sharedContent(token),
    change = {
      action: "save",
      pageId: host,
      title: data.title,
      version: data.version,
      html: html.replaceAll("Idee", "Start"),
    };
  assert.throws(() => mutateSharedContent(read, change), /erlaubt/);
  mutateSharedContent(token, change);
  assert.match(sharedContent(read).html, /Start/);
  assert.doesNotMatch(sharedContent(read).html, /<svg|<img/);
});
