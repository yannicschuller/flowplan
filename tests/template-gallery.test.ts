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
const admin = account("tpl-admin", true),
  owner = account("tpl-owner"),
  other = account("tpl-other");
const home = createWorkspace(admin.id, "Zentrale"),
  own = createWorkspace(owner.id, "Eigene"),
  elsewhere = createWorkspace(other.id, "Anderswo");
run("INSERT INTO members VALUES(?,?,?)", home, owner.id, "owner");

test("templates carry categories and admins share them with every workspace", () => {
  const page = (
    command(admin, {
      action: "page.create",
      workspaceId: home,
      spaceId: bootstrap(admin, home).spaces[0].id,
      title: "Retro",
    }) as { id: string }
  ).id;
  run("UPDATE documents SET html='<p>Was lief gut?</p>' WHERE page_id=?", page);
  const template = (
    command(admin, {
      action: "template.save",
      pageId: page,
      name: "Retrospektive",
      category: "meetings",
    }) as { id: string }
  ).id;
  const find = (as: Identity, wid: string) =>
    listPageTemplates(as, wid).find((t) => t.id === template);
  assert.equal(find(admin, home)?.category, "meetings");
  assert.equal(find(other, elsewhere), undefined);
  const update = (as: Identity, visibility: string, category = "meetings") =>
    command(as, {
      action: "template.update",
      workspaceId: home,
      templateId: template,
      version: one<{ version: number }>(
        "SELECT version FROM templates WHERE id=?",
        template,
      )!.version,
      name: "Retrospektive",
      visibility,
      category,
    });
  // Workspace owners may not publish to the whole instance.
  assert.throws(() => update(owner, "instance"), /Nur Admins/);
  // Unknown categories are dropped instead of stored.
  update(owner, "workspace", "unknown");
  assert.equal(find(admin, home)?.category, "");
  update(admin, "instance");
  const shared = find(other, elsewhere)!;
  assert.equal(shared.shared, true);
  assert.equal(shared.can_manage, false);
  assert.equal(find(owner, home)?.can_manage, false);
  assert.equal(find(admin, home)?.can_manage, true);
  // Other workspaces use it but cannot manage it.
  const created = (
    command(other, {
      action: "page.create",
      workspaceId: elsewhere,
      spaceId: bootstrap(other, elsewhere).spaces[0].id,
      title: "Unsere Retro",
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
    /Was lief gut/,
  );
  assert.throws(() =>
    command(other, {
      action: "template.delete",
      workspaceId: elsewhere,
      templateId: template,
      version: 1,
    }),
  );
  // Deleted or unshared templates disappear elsewhere again.
  update(admin, "workspace", "");
  assert.equal(find(other, elsewhere), undefined);
  assert.equal(find(admin, home)?.category, "");
  assert.throws(() =>
    command(other, {
      action: "page.create",
      workspaceId: elsewhere,
      spaceId: bootstrap(other, elsewhere).spaces[0].id,
      title: "Nicht mehr",
      templateId: template,
    }),
  );
  void own;
});
