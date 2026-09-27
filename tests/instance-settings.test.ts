import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-instance-"),
);
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { defaultQuotaMb } = await import("../lib/instance-ops");
const { retentionDays } = await import("../lib/version-history");

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
const admin = account("inst-admin", true),
  person = account("inst-person");
const wid = createWorkspace(person.id, "Eigener");

test("admins configure the instance; stored values override the environment", () => {
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "50";
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "30";
  assert.equal(defaultQuotaMb(), 50);
  assert.equal(retentionDays(), 30);
  const settings = {
    name: "Muster GmbH",
    announcement: "Wartung am Samstag",
    defaultQuotaMb: 200,
    retentionDays: 0,
    maxUploadMb: 25,
    allowWorkspaceCreation: false,
  };
  assert.throws(
    () => command(person, { action: "admin.settings", settings }),
    /Administrator/,
  );
  assert.throws(() =>
    command(admin, {
      action: "admin.settings",
      settings: { ...settings, maxUploadMb: 0 },
    }),
  );
  command(admin, { action: "admin.settings", settings });
  assert.equal(defaultQuotaMb(), 200);
  assert.equal(retentionDays(), 0);
  assert.deepEqual(bootstrap(person, wid).instance, {
    name: "Muster GmbH",
    announcement: "Wartung am Samstag",
    allowWorkspaceCreation: false,
    transcription: false,
  });
  assert.throws(
    () => command(person, { action: "workspace.create", name: "Noch einer" }),
    /nur Admins/,
  );
  assert.ok(
    (
      command(admin, { action: "workspace.create", name: "Admin-Bereich" }) as {
        id: string;
      }
    ).id,
  );
  // Empty values fall back to the environment again.
  command(admin, {
    action: "admin.settings",
    settings: {
      ...settings,
      defaultQuotaMb: null,
      retentionDays: null,
      allowWorkspaceCreation: true,
    },
  });
  assert.equal(defaultQuotaMb(), 50);
  assert.equal(retentionDays(), 30);
  assert.ok(
    (
      command(person, {
        action: "workspace.create",
        name: "Jetzt erlaubt",
      }) as { id: string }
    ).id,
  );
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  delete process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
});
