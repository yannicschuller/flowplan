import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-my-security-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { mySecurity } = await import("../lib/my-security");
const { failed } = await import("../lib/local-auth");
const { hashPasswordSync } = await import("../lib/local-auth");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const person = async (name: string, local = false) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  if (local)
    await run("INSERT INTO local_accounts(user_id,email,password_hash,email_verified,created_at) VALUES(?,?,?,1,?)", uid, `${name.toLowerCase()}@example.test`, hashPasswordSync("ein langes Passwort 123"), Date.now());
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};

test("the check is tailored to the account: second factor, passkeys and failures for local accounts", async () => {
  const anna = await person("Anna", true);
  const state = (s: Awaited<ReturnType<typeof mySecurity>>, check: string) => s.checks.find((c) => c.id === check)?.state;
  let s = await mySecurity(anna, undefined);
  assert.equal(s.account.kind, "local");
  assert.equal(state(s, "second-factor"), "todo");
  assert.equal(state(s, "passkey"), "todo");
  assert.equal(state(s, "failures"), "ok");
  for (let i = 0; i < 6; i++) await failed(["ip:203.0.113.5", "email:anna@example.test"]);
  await settle();
  s = await mySecurity(anna, undefined);
  assert.equal(state(s, "failures"), "todo");
  assert.equal(s.checks.find((c) => c.id === "failures")?.count, 6);
  assert.ok(s.activity.some((e) => e.kind === "login.failure" && e.network === "203.0.113.0/24"));
  // SSO accounts get the provider's note instead of password points.
  const ben = await person("Ben");
  const sso = await mySecurity(ben, undefined);
  assert.equal(sso.account.kind, "sso");
  assert.ok(sso.checks.some((c) => c.id === "provider" && c.state === "info"));
  assert.ok(!sso.checks.some((c) => c.id === "second-factor"));
});

test("shared content: links, public pages and people with access to one's own pages", async () => {
  const cara = await person("Cara");
  const dana = await person("Dana");
  const wid = await createWorkspace(cara.id, "Team");
  await run("INSERT INTO members VALUES(?,?,?)", wid, dana.id, "viewer");
  const space = (await bootstrap(cara, wid)).spaces[0].id;
  const pageId = ((await command(cara, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan", kind: "document" })) as { id: string }).id;
  await command(cara, { action: "share.create", workspaceId: wid, pageId, name: "Team-Link", role: "editor" });
  await command(cara, { action: "page.publish", workspaceId: wid, pageId, enabled: true });
  await run("INSERT INTO grants VALUES(?,?,?,?)", pageId, dana.id, "", "editor");
  const s = await mySecurity(cara, undefined);
  assert.equal(s.links.length, 1);
  assert.equal(s.links[0].role, "editor");
  assert.equal(s.checks.find((c) => c.id === "links")?.state, "todo");
  assert.deepEqual(s.published.map((p) => p.pageId), [pageId]);
  assert.deepEqual(s.people.map((p) => p.userId), [dana.id]);
  // Closing them with the existing commands.
  await command(cara, { action: "share.revoke", workspaceId: wid, pageId, token: s.links[0].token });
  await command(cara, { action: "page.publish", workspaceId: wid, pageId, enabled: false });
  await command(cara, { action: "page.shareUpdate", workspaceId: wid, pageId, userId: dana.id, role: "remove" });
  const after = await mySecurity(cara, undefined);
  assert.equal(after.links.length, 0);
  assert.equal(after.published.length, 0);
  assert.equal(after.people.length, 0);
  assert.equal(after.checks.find((c) => c.id === "links")?.state, "ok");
  // Others do not see Cara's shares.
  assert.equal((await mySecurity(dana, undefined)).links.length, 0);
});

test("API tokens never read the security check", async () => {
  const eve = await person("Eve");
  await assert.rejects(async () => await mySecurity({ ...eve, apiScope: "read" } as Identity, undefined), /API-Token/);
});
