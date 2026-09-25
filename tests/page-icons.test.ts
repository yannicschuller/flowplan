import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-icons-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { pageIconSchema } = await import("../lib/page-appearance");

const uid = id();
run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "icons",
  "icons@example.test",
);
const owner = {
  id: uid,
  name: "icons",
  email: "icons@example.test",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
} as Identity;
const wid = createWorkspace(owner.id, "Symbole");

test("library icons are validated and icon sizes survive copies", () => {
  assert.ok(pageIconSchema.safeParse("icon:Rocket:#d44c47").success);
  for (const bad of [
    "icon:Unknown:#d44c47",
    "icon:Rocket:#123456",
    "icon:Rocket:red",
  ])
    assert.equal(pageIconSchema.safeParse(bad).success, false, bad);
  const page = (
    command(owner, {
      action: "page.create",
      workspaceId: wid,
      spaceId: bootstrap(owner, wid).spaces[0].id,
      title: "Start",
    }) as { id: string }
  ).id;
  command(owner, {
    action: "page.update",
    pageId: page,
    patch: { icon: "icon:Rocket:#d44c47", icon_size: "large" },
  });
  assert.throws(() =>
    command(owner, {
      action: "page.update",
      pageId: page,
      patch: { icon_size: "huge" },
    }),
  );
  const copy = (
    command(owner, { action: "page.duplicate", pageId: page }) as { id: string }
  ).id;
  assert.deepEqual(one("SELECT icon,icon_size FROM pages WHERE id=?", copy), {
    icon: "icon:Rocket:#d44c47",
    icon_size: "large",
  });
});
