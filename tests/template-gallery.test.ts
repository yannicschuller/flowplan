import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tplg-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { listPageTemplates } = await import("../lib/page-templates");

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
const admin = await account("tpl-admin", true),
  owner = await account("tpl-owner"),
  other = await account("tpl-other");
const home = await createWorkspace(admin.id, "Zentrale"),
  own = await createWorkspace(owner.id, "Eigene"),
  elsewhere = await createWorkspace(other.id, "Anderswo");
await run("INSERT INTO members VALUES(?,?,?)", home, owner.id, "owner");

test("templates carry categories and admins share them with every workspace", async () => {
  const page = (
    (await command(admin, {
      action: "page.create",
      workspaceId: home,
      spaceId: (await bootstrap(admin, home)).spaces[0].id,
      title: "Retro",
    })) as { id: string }
  ).id;
  await run("UPDATE documents SET html='<p>Was lief gut?</p>' WHERE page_id=?", page);
  const template = (
    (await command(admin, {
      action: "template.save",
      pageId: page,
      name: "Retrospektive",
      category: "meetings",
    })) as { id: string }
  ).id;
  const find = async (as: Identity, wid: string) =>
    (await listPageTemplates(as, wid)).find((t) => t.id === template);
  assert.equal((await find(admin, home))?.category, "meetings");
  assert.equal(await find(other, elsewhere), undefined);
  const update = async (as: Identity, visibility: string, category = "meetings") =>
    await command(as, {
      action: "template.update",
      workspaceId: home,
      templateId: template,
      version: (await one<{ version: number }>(
        "SELECT version FROM templates WHERE id=?",
        template,
      ))!.version,
      name: "Retrospektive",
      visibility,
      category,
    });
  // Workspace owners may not publish to the whole instance.
  await assert.rejects(async () => await update(owner, "instance"), /Nur Admins/);
  // Unknown categories are dropped instead of stored.
  await update(owner, "workspace", "unknown");
  assert.equal((await find(admin, home))?.category, "");
  await update(admin, "instance");
  const shared = (await find(other, elsewhere))!;
  assert.equal(shared.shared, true);
  assert.equal(shared.can_manage, false);
  assert.equal((await find(owner, home))?.can_manage, false);
  assert.equal((await find(admin, home))?.can_manage, true);
  // Other workspaces use it but cannot manage it.
  const created = (
    (await command(other, {
      action: "page.create",
      workspaceId: elsewhere,
      spaceId: (await bootstrap(other, elsewhere)).spaces[0].id,
      title: "Unsere Retro",
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
    /Was lief gut/,
  );
  await assert.rejects(async () =>
    await command(other, {
      action: "template.delete",
      workspaceId: elsewhere,
      templateId: template,
      version: 1,
    }),
  );
  // Deleted or unshared templates disappear elsewhere again.
  await update(admin, "workspace", "");
  assert.equal(await find(other, elsewhere), undefined);
  assert.equal((await find(admin, home))?.category, "");
  await assert.rejects(async () =>
    await command(other, {
      action: "page.create",
      workspaceId: elsewhere,
      spaceId: (await bootstrap(other, elsewhere)).spaces[0].id,
      title: "Nicht mehr",
      templateId: template,
    }),
  );
  void own;
});
