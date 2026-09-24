import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tplx-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, rows } = await import("../lib/api");
const { exportTemplate, importTemplate } =
  await import("../lib/template-exchange");
const { readZip, writeZip } = await import("../lib/archive");

function account(name: string) {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = account("tpl-owner"),
  other = account("tpl-other");
const source = createWorkspace(owner.id, "Quelle"),
  target = createWorkspace(other.id, "Ziel");
const space = bootstrap(owner, source).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) =>
  command(as, input) as { id: string };

test("templates round-trip between instances with attachments and stay validated", async () => {
  const page = act({
    action: "page.create",
    workspaceId: source,
    spaceId: space,
    title: "Protokoll",
  }).id;
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), "PDF");
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page,
    "anlage.pdf",
    "application/pdf",
    3,
    owner.id,
  );
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p>Agenda</p><p><a href="/api/files/${fid}">Anlage</a></p>`,
    page,
  );
  const template = act({
    action: "template.save",
    pageId: page,
    name: "Meeting-Protokoll",
  }).id;
  const exported = await exportTemplate(owner, source, template);
  assert.equal(exported.name, "Meeting-Protokoll");
  const imported = await importTemplate(
    other,
    target,
    exported.zip,
    "workspace",
  );
  const stored = one<{ name: string; kind: string; created_by: string }>(
    "SELECT name,kind,created_by FROM templates WHERE id=?",
    imported.id,
  )!;
  assert.deepEqual(
    [stored.name, stored.kind, stored.created_by],
    ["Meeting-Protokoll", "document", other.id],
  );
  assert.equal(
    all("SELECT id FROM template_files WHERE template_id=?", imported.id)
      .length,
    1,
  );
  // Using the imported template creates the page with its own attachment copy.
  const created = act(
    {
      action: "page.create",
      workspaceId: target,
      spaceId: bootstrap(other, target).spaces[0].id,
      title: "Neu",
      templateId: imported.id,
    },
    other,
  ).id;
  const html = one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    created,
  )!.html;
  assert.match(html, /Agenda/);
  assert.doesNotMatch(html, new RegExp(fid));
  assert.equal(
    one<{ page_id: string }>(
      "SELECT page_id FROM files WHERE name='anlage.pdf' AND page_id=?",
      created,
    )?.page_id,
    created,
  );

  // Tampered files, missing attachments and foreign workspaces are rejected.
  const entries = await readZip(exported.zip, { foreign: true });
  entries.set(`files/${fid}`, Buffer.from("anders"));
  await assert.rejects(
    importTemplate(other, target, await writeZip(entries), "workspace"),
    /beschädigt/,
  );
  entries.delete(`files/${fid}`);
  const manifest = JSON.parse(entries.get("template.json")!.toString());
  manifest.files = [];
  entries.set("template.json", Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(
    importTemplate(other, target, await writeZip(entries), "workspace"),
    /Vorlagenanhang fehlt/,
  );
  manifest.payload = JSON.stringify({ html: 5 });
  entries.set("template.json", Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(
    importTemplate(other, target, await writeZip(entries), "workspace"),
    /ungültig/,
  );
  await assert.rejects(
    importTemplate(other, source, exported.zip, "workspace"),
    /Berechtigung|Mitglied|Zugriff/i,
  );
  await assert.rejects(
    exportTemplate(other, source, template),
    /Berechtigung|Mitglied|Zugriff/i,
  );
});

test("database templates keep records and views after import", async () => {
  const db = act({
    action: "page.create",
    workspaceId: source,
    spaceId: space,
    title: "Checkliste",
    kind: "database",
  }).id;
  act({ action: "row.create", pageId: db, cells: { title: "Punkt 1" } });
  const template = act({
    action: "template.save",
    pageId: db,
    name: "Checkliste",
  }).id;
  const imported = await importTemplate(
    other,
    target,
    (await exportTemplate(owner, source, template)).zip,
    "private",
  );
  const created = act(
    {
      action: "page.create",
      workspaceId: target,
      spaceId: bootstrap(other, target).spaces[0].id,
      title: "Aus Datei",
      kind: "database",
      templateId: imported.id,
    },
    other,
  ).id;
  assert.deepEqual(
    rows(created).map((r) => r.cells.title),
    ["Punkt 1"],
  );
});
