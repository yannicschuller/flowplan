import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-pubtpl-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { publicTemplates, publicTemplate, publicTemplateFile } =
  await import("../lib/public-templates");

function account(name: string, isAdmin = false) {
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
    groups: isAdmin ? ["flowplan-admins"] : [],
    isAdmin,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const admin = account("pub-admin", true),
  owner = account("pub-owner");
const wid = createWorkspace(admin.id, "Galerie");
run("INSERT INTO members VALUES(?,?,?)", wid, owner.id, "owner");

test("admins publish templates to the public gallery with their files", () => {
  const page = (
    command(admin, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(admin, wid).spaces[0].id,
      title: "Wochenplan",
    }) as { id: string }
  ).id;
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), "PNGDATA");
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page,
    "plan.png",
    "image/png",
    7,
    admin.id,
  );
  run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p>Montag</p><img src="/api/files/${fid}" alt="Plan">`,
    page,
  );
  const template = (
    command(admin, {
      action: "template.save",
      pageId: page,
      name: "Wochenplan",
      category: "planning",
    }) as { id: string }
  ).id;
  const version = () =>
    one<{ version: number }>(
      "SELECT version FROM templates WHERE id=?",
      template,
    )!.version;
  assert.deepEqual(publicTemplates(), []);
  assert.throws(() => publicTemplate(template), /nicht gefunden/);
  // Only admins publish.
  assert.throws(
    () =>
      command(owner, {
        action: "template.update",
        workspaceId: wid,
        templateId: template,
        version: version(),
        name: "Wochenplan",
        visibility: "public",
        category: "planning",
      }),
    /Nur Admins/,
  );
  command(admin, {
    action: "template.update",
    workspaceId: wid,
    templateId: template,
    version: version(),
    name: "Wochenplan",
    visibility: "public",
    category: "planning",
  });
  assert.deepEqual(
    publicTemplates().map((t) => t.name),
    ["Wochenplan"],
  );
  assert.deepEqual(
    publicTemplates("planning").map((t) => t.id),
    [template],
  );
  assert.deepEqual(publicTemplates("meetings"), []);
  const preview = publicTemplate(template);
  assert.match(preview.html, /Montag/);
  assert.match(
    preview.html,
    new RegExp(`/api/public-templates/${template}/files/${fid}`),
  );
  assert.equal(
    Buffer.from(publicTemplateFile(template, fid).data).toString(),
    "PNGDATA",
  );
  assert.throws(() => publicTemplateFile(template, id()), /nicht gefunden/);
  // Any signed-in person can use it in their own workspace.
  const other = account("pub-visitor");
  const own = createWorkspace(other.id, "Eigener Bereich");
  const created = (
    command(other, {
      action: "page.create",
      workspaceId: own,
      spaceId: bootstrap(other, own).spaces[0].id,
      title: "Mein Wochenplan",
      templateId: template,
    }) as { id: string }
  ).id;
  assert.match(
    String(
      one<{ html: string }>(
        "SELECT html FROM documents WHERE page_id=?",
        created,
      )?.html,
    ),
    /Montag/,
  );
  // Unpublishing removes it from the gallery.
  command(admin, {
    action: "template.update",
    workspaceId: wid,
    templateId: template,
    version: version(),
    name: "Wochenplan",
    visibility: "workspace",
    category: "planning",
  });
  assert.deepEqual(publicTemplates(), []);
});
