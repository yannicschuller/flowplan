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

async function account(name: string, isAdmin = false) {
  const uid = id();
  await run(
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
const admin = await account("pub-admin", true),
  owner = await account("pub-owner");
const wid = await createWorkspace(admin.id, "Galerie");
await run("INSERT INTO members VALUES(?,?,?)", wid, owner.id, "owner");

test("admins publish templates to the public gallery with their files", async () => {
  const page = (
    (await command(admin, {
      action: "page.create",
      workspaceId: wid,
      spaceId: (await bootstrap(admin, wid)).spaces[0].id,
      title: "Wochenplan",
    })) as { id: string }
  ).id;
  const fid = id(),
    dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fid), "PNGDATA");
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    fid,
    page,
    "plan.png",
    "image/png",
    7,
    admin.id,
  );
  await run(
    "UPDATE documents SET html=? WHERE page_id=?",
    `<p>Montag</p><img src="/api/files/${fid}" alt="Plan">`,
    page,
  );
  const template = (
    (await command(admin, {
      action: "template.save",
      pageId: page,
      name: "Wochenplan",
      category: "planning",
    })) as { id: string }
  ).id;
  const version = async () =>
    (await one<{ version: number }>(
      "SELECT version FROM templates WHERE id=?",
      template,
    ))!.version;
  assert.deepEqual(await publicTemplates(), []);
  await assert.rejects(async () => await publicTemplate(template), /nicht gefunden/);
  // Only admins publish.
  await assert.rejects(
    async () =>
      await command(owner, {
        action: "template.update",
        workspaceId: wid,
        templateId: template,
        version: await version(),
        name: "Wochenplan",
        visibility: "public",
        category: "planning",
      }),
    /Nur Admins/,
  );
  await command(admin, {
    action: "template.update",
    workspaceId: wid,
    templateId: template,
    version: await version(),
    name: "Wochenplan",
    visibility: "public",
    category: "planning",
  });
  assert.deepEqual(
    (await publicTemplates()).map((t) => t.name),
    ["Wochenplan"],
  );
  assert.deepEqual(
    (await publicTemplates("planning")).map((t) => t.id),
    [template],
  );
  assert.deepEqual(await publicTemplates("meetings"), []);
  const preview = await publicTemplate(template);
  assert.match(preview.html, /Montag/);
  assert.match(
    preview.html,
    new RegExp(`/api/public-templates/${template}/files/${fid}`),
  );
  assert.equal(
    Buffer.from((await publicTemplateFile(template, fid)).data).toString(),
    "PNGDATA",
  );
  await assert.rejects(async () => await publicTemplateFile(template, id()), /nicht gefunden/);
  // Any signed-in person can use it in their own workspace.
  const other = await account("pub-visitor");
  const own = await createWorkspace(other.id, "Eigener Bereich");
  const created = (
    (await command(other, {
      action: "page.create",
      workspaceId: own,
      spaceId: (await bootstrap(other, own)).spaces[0].id,
      title: "Mein Wochenplan",
      templateId: template,
    })) as { id: string }
  ).id;
  assert.match(
    String(
      (await one<{ html: string }>(
        "SELECT html FROM documents WHERE page_id=?",
        created,
      ))?.html,
    ),
    /Montag/,
  );
  // Unpublishing removes it from the gallery.
  await command(admin, {
    action: "template.update",
    workspaceId: wid,
    templateId: template,
    version: await version(),
    name: "Wochenplan",
    visibility: "workspace",
    category: "planning",
  });
  assert.deepEqual(await publicTemplates(), []);
});
