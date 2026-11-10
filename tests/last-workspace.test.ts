// #188: a reload opens the workspace the person was last in (remembered in a
// cookie on the device), as long as they are still a member.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-last-workspace-"));
const { run, id } = await import("../lib/db");
const { bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { WORKSPACE_COOKIE, lastWorkspace, workspaceCookie } = await import("../lib/last-workspace");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}

test("the remembered workspace opens on reload, the first one once membership is gone", async () => {
  const ada = await user("Ada"),
    bob = await user("Bob");
  const first = await createWorkspace(ada.id, "First");
  const other = await createWorkspace(bob.id, "Other");
  await run("INSERT INTO members VALUES(?,?,?)", other, ada.id, "editor");
  // Without a remembered workspace: the first one, as before.
  assert.equal((await bootstrap(ada, lastWorkspace(undefined))).workspace.id, first);
  // Remembered: that one.
  assert.equal((await bootstrap(ada, lastWorkspace(other))).workspace.id, other);
  // No longer a member: the first one again.
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", other, ada.id);
  assert.equal((await bootstrap(ada, lastWorkspace(other))).workspace.id, first);
});

test("only a workspace id is taken from the cookie", () => {
  const wid = id();
  assert.equal(lastWorkspace(wid), wid);
  assert.equal(lastWorkspace(wid.toUpperCase()), wid.toUpperCase());
  for (const value of [undefined, "", "abc", `${wid}x`, `${wid};x`, "../../etc"]) assert.equal(lastWorkspace(value), undefined);
  const cookie = workspaceCookie(wid);
  assert.ok(cookie.startsWith(`${WORKSPACE_COOKIE}=${wid};`));
  assert.match(cookie, /path=\//);
  assert.match(cookie, /samesite=lax/i);
  assert.match(cookie, /max-age=\d{7,}/);
  // Nothing else is ever written into the cookie.
  assert.equal(workspaceCookie("x; path=/evil"), "");
});
