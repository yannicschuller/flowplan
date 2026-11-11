// A workspace's automatic link rules on the server (#202,
// lib/auto-link-rules.ts): only owners change them, every member and guest
// gets them in the bootstrap, invalid rules are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-auto-links-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames } = await import("../lib/openapi");

async function account(name: string, extra: Partial<Identity> = {}) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}
const owner = await account("links-owner"),
  editor = await account("links-editor"),
  guest = await account("links-guest"),
  stranger = await account("links-stranger");
const wid = await createWorkspace(owner.id, "Tickets");
await createWorkspace(stranger.id, "Anderswo");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

const JIRA = { name: "Jira", pattern: "\\bABC-\\d+\\b", template: "https://jira.example/browse/{match}", enabled: true };
const ISSUES = { pattern: "#(\\d+)", template: "https://github.com/acme/app/issues/$1", enabled: false };

test("only owners change the rules; members, guests, strangers and read tokens are refused", async () => {
  for (const user of [editor, guest, stranger, { ...owner, apiScope: "read" as const }])
    await rejects(() => command(user, { action: "workspace.linkRules", workspaceId: wid, rules: [JIRA] }), 403);
  assert.equal((await one<{ link_rules: string | null }>("SELECT link_rules FROM workspaces WHERE id=?", wid))?.link_rules, null);
  const saved = (await command(owner, { action: "workspace.linkRules", workspaceId: wid, rules: [JIRA, ISSUES] })) as { rules: { id: string; name: string; pattern: string; enabled: boolean }[] };
  assert.equal(saved.rules.length, 2);
  assert.ok(saved.rules.every((r) => r.id), "every rule gets an id");
  assert.deepEqual(saved.rules.map((r) => [r.name, r.pattern, r.enabled]), [["Jira", JIRA.pattern, true], ["", ISSUES.pattern, false]]);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workspace.linkRules' AND resource_id=?", wid), "recorded in the activity log");
  assert.ok(commandActionNames.includes("workspace.linkRules"), "listed for the API");
});

test("every member and guest gets the rules in the bootstrap, not as a raw column", async () => {
  for (const user of [owner, editor, guest]) {
    const boot = await bootstrap(user, wid);
    assert.deepEqual(boot.linkRules.map((r) => r.template), [JIRA.template, ISSUES.template], user.name);
    assert.ok(!boot.workspaces.some((w) => "link_rules" in w), "the raw column stays out of the list");
  }
  // Another workspace has none.
  assert.deepEqual((await bootstrap(stranger)).linkRules, []);
});

test("invalid or unsafe rules are refused and nothing changes", async () => {
  const before = (await one<{ link_rules: string }>("SELECT link_rules FROM workspaces WHERE id=?", wid))!.link_rules;
  const bad = [
    { pattern: "(ABC", template: "https://x.example/{match}" },
    { pattern: "a*", template: "https://x.example/{match}" },
    { pattern: "(a+)+$", template: "https://x.example/{match}" },
    { pattern: "x".repeat(201), template: "https://x.example/{match}" },
    { pattern: "ABC", template: "javascript:alert(1)" },
    { pattern: "ABC", template: "{match}" },
    { pattern: "ABC", template: "" },
  ];
  for (const r of bad) await rejects(() => command(owner, { action: "workspace.linkRules", workspaceId: wid, rules: [JIRA, r] }), 400);
  await rejects(() => command(owner, { action: "workspace.linkRules", workspaceId: wid, rules: Array.from({ length: 51 }, () => JIRA) }), 400);
  assert.equal((await one<{ link_rules: string }>("SELECT link_rules FROM workspaces WHERE id=?", wid))!.link_rules, before);
  // An empty list removes them.
  assert.deepEqual(await command(owner, { action: "workspace.linkRules", workspaceId: wid, rules: [] }), { rules: [] });
  assert.equal((await one<{ link_rules: string | null }>("SELECT link_rules FROM workspaces WHERE id=?", wid))?.link_rules, null);
  assert.deepEqual((await bootstrap(editor, wid)).linkRules, []);
});
