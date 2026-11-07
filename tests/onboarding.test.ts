import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-onboarding-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");

async function person(name: string, extra: Partial<Identity> = {}): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}

test("a new account sees the introduction once", async () => {
  const ada = await person("Ada");
  const wid = await createWorkspace(ada.id, "Mein Arbeitsbereich");
  assert.equal((await bootstrap(ada, wid)).onboarding, true);
  await command(ada, { action: "profile.onboarded", workspaceId: wid });
  assert.equal((await bootstrap(ada, wid)).onboarding, false);
  // Demo accounts go straight in.
  const demo = await person("Demo", { demo: true } as Partial<Identity>);
  assert.equal((await bootstrap(demo, await createWorkspace(demo.id, "Demo"))).onboarding, false);
});

test("the introduction turns e-mail summaries off and on for every kind", async () => {
  const ben = await person("Ben");
  const wid = await createWorkspace(ben.id, "Ben");
  const off = (await command(ben, { action: "notification.email", workspaceId: wid, email: false })) as Record<string, { email: boolean; inbox: boolean }>;
  assert.ok(Object.values(off).every((p) => p.email === false && p.inbox === true));
  const on = (await command(ben, { action: "notification.email", workspaceId: wid, email: true })) as Record<string, { email: boolean }>;
  // On means: as by default – what concerns the person, not every edit.
  assert.equal(on.mention.email, true);
  assert.equal(on.change.email, false);
  await assert.rejects(async () => await command(ben, { action: "notification.email", workspaceId: wid, email: "ja" }));
});
