import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-template-assets-"),
);
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { listPageTemplates } = await import("../lib/page-templates");
const { exportArchive, importArchive, readZip, writeZip } =
  await import("../lib/archive");
const { requirePage } = await import("../lib/permissions");
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@test.example`,
  );
  return {
    id: uid,
    name,
    email: `${name}@test.example`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  editor = user("editor"),
  viewer = user("viewer");
const wid = createWorkspace(owner.id, "Template tests");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const boot = bootstrap(owner, wid);
const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
mkdirSync(dir, { recursive: true });
const bytes = Buffer.from("Saved independent attachment\0original bytes");
function fixture() {
  const space = command(owner, {
    action: "space.create",
    workspaceId: wid,
    name: "Private original",
    private: true,
  }) as { id: string };
  const page = command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: space.id,
    title: "Private source",
  }) as { id: string };
  const fid = id();
  writeFileSync(join(dir, fid), bytes);
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page.id,
    "original.txt",
    "text/plain",
    bytes.length,
    owner.id,
  );
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><a href="/api/files/${fid}">Read the attachment</a></p><p>Literal: /api/files/${fid}</p>`,
    page.id,
  );
  const template = command(owner, {
    action: "template.save",
    pageId: page.id,
    name: `Reusable ${id()}`,
  }) as { id: string };
  return { page, fid, template };
}
function create(templateId: string, extra = {}) {
  return command(editor, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Independent copy",
    templateId,
    ...extra,
  }) as { id: string };
}
test("template files survive source deletion and create independently authorized copies with rollback cleanup", () => {
  const { page, fid, template } = fixture();
  assert.throws(() => requirePage(editor, page.id), /Berechtigung/);
  writeFileSync(join(dir, fid), "Changed source bytes");
  run("DELETE FROM pages WHERE id=?", page.id);
  const copied = create(template.id);
  const file = one<{ id: string }>(
    "SELECT id FROM files WHERE page_id=?",
    copied.id,
  )!;
  assert.notEqual(file.id, fid);
  assert.deepEqual(readFileSync(join(dir, file.id)), bytes);
  assert.equal(requirePage(editor, copied.id).id, copied.id);
  const html = one<{ html: string }>(
    "SELECT html FROM documents WHERE page_id=?",
    copied.id,
  )!.html;
  assert.match(html, new RegExp(`href="/api/files/${file.id}"`));
  assert.match(html, new RegExp(`Literal: /api/files/${fid}`));
  const before = readdirSync(dir).sort();
  assert.throws(
    () =>
      create(template.id, {
        title: "Rollback template",
        starterTemplate: "meeting",
      }),
    /Nur eine Vorlage/,
  );
  assert.equal(
    one("SELECT id FROM pages WHERE title=?", "Rollback template"),
    undefined,
  );
  assert.deepEqual(readdirSync(dir).sort(), before);
});
test("template management enforces creator ownership, versions, visibility and recoverable deletion", () => {
  const { template } = fixture();
  let current = listPageTemplates(owner, wid).find(
    (t) => t.id === template.id,
  )!;
  assert.equal(
    listPageTemplates(editor, wid).find((t) => t.id === template.id)!
      .can_manage,
    false,
  );
  assert.throws(
    () =>
      command(editor, {
        action: "template.delete",
        workspaceId: wid,
        templateId: template.id,
        version: current.version,
      }),
    /Ersteller/,
  );
  assert.throws(
    () =>
      command(viewer, {
        action: "template.delete",
        workspaceId: wid,
        templateId: template.id,
        version: current.version,
      }),
    /Berechtigung/,
  );
  command(owner, {
    action: "template.update",
    workspaceId: wid,
    templateId: template.id,
    version: current.version,
    name: "Renamed private template",
    visibility: "private",
  });
  assert.equal(
    listPageTemplates(editor, wid).some((t) => t.id === template.id),
    false,
  );
  assert.throws(() => create(template.id), /Private Vorlage/);
  assert.throws(
    () =>
      command(owner, {
        action: "template.delete",
        workspaceId: wid,
        templateId: template.id,
        version: current.version,
      }),
    /zwischenzeitlich/,
  );
  current = listPageTemplates(owner, wid).find((t) => t.id === template.id)!;
  command(owner, {
    action: "template.delete",
    workspaceId: wid,
    templateId: template.id,
    version: current.version,
  });
  assert.throws(
    () =>
      command(owner, {
        action: "page.create",
        workspaceId: wid,
        spaceId: boot.spaces[0].id,
        title: "Deleted copy",
        templateId: template.id,
      }),
    /Vorlage fehlt/,
  );
  current = listPageTemplates(owner, wid).find((t) => t.id === template.id)!;
  assert.ok(current.deleted_at);
  command(owner, {
    action: "template.restore",
    workspaceId: wid,
    templateId: template.id,
    version: current.version,
  });
  assert.equal(
    listPageTemplates(owner, wid).find((t) => t.id === template.id)!.deleted_at,
    null,
  );
  assert.ok(
    one("SELECT id FROM template_files WHERE template_id=?", template.id),
  );
});
test("ZIP archives preserve template-only binaries and reject corrupted attachment checksums atomically", async () => {
  const { page, template } = fixture();
  run("DELETE FROM pages WHERE id=?", page.id);
  const archive = await exportArchive(owner, wid);
  const target = createWorkspace(owner.id, "Asset restore");
  await importArchive(owner, target, archive);
  const name = one<{ name: string }>(
    "SELECT name FROM templates WHERE id=?",
    template.id,
  )!.name;
  const imported = listPageTemplates(owner, target).find(
    (t) => t.name === name,
  )!;
  const space = bootstrap(owner, target).spaces[0];
  const copied = command(owner, {
    action: "page.create",
    workspaceId: target,
    spaceId: space.id,
    title: "Restored attachment",
    templateId: imported.id,
  }) as { id: string };
  const file = one<{ id: string }>(
    "SELECT id FROM files WHERE page_id=?",
    copied.id,
  )!;
  assert.deepEqual(readFileSync(join(dir, file.id)), bytes);
  const entries = await readZip(archive);
  const assetEntry = [...entries.keys()].find((key) =>
    key.startsWith("template-files/"),
  )!;
  entries.set(assetEntry, Buffer.from("corrupted"));
  const before = listPageTemplates(owner, target).length;
  await assert.rejects(
    importArchive(owner, target, await writeZip(entries)),
    /Prüfsumme/,
  );
  assert.equal(listPageTemplates(owner, target).length, before);
});
test("saving a template cannot capture attachments from an inaccessible page", () => {
  const { fid } = fixture();
  const own = command(editor, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Forged attachment",
  }) as { id: string };
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p><a href="/api/files/${fid}">Private file</a></p>`,
    own.id,
  );
  assert.throws(
    () =>
      command(editor, {
        action: "template.save",
        pageId: own.id,
        name: "Forbidden capture",
      }),
    /Berechtigung/,
  );
  assert.equal(
    one("SELECT id FROM templates WHERE name=?", "Forbidden capture"),
    undefined,
  );
});
