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

function person(name: string, extra: Partial<Identity> = {}): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}

test("a new account sees the introduction once", () => {
  const ada = person("Ada");
  const wid = createWorkspace(ada.id, "Mein Arbeitsbereich");
  assert.equal(bootstrap(ada, wid).onboarding, true);
  command(ada, { action: "profile.onboarded", workspaceId: wid });
  assert.equal(bootstrap(ada, wid).onboarding, false);
  // Demo accounts go straight in.
  const demo = person("Demo", { demo: true } as Partial<Identity>);
  assert.equal(bootstrap(demo, createWorkspace(demo.id, "Demo")).onboarding, false);
});

test("the introduction turns e-mail summaries off and on for every kind", () => {
  const ben = person("Ben");
  const wid = createWorkspace(ben.id, "Ben");
  const off = command(ben, { action: "notification.email", workspaceId: wid, email: false }) as Record<string, { email: boolean; inbox: boolean }>;
  assert.ok(Object.values(off).every((p) => p.email === false && p.inbox === true));
  const on = command(ben, { action: "notification.email", workspaceId: wid, email: true }) as Record<string, { email: boolean }>;
  assert.ok(Object.values(on).every((p) => p.email === true));
  assert.throws(() => command(ben, { action: "notification.email", workspaceId: wid, email: "ja" }));
});
