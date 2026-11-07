import { aboutInfo } from "../lib/about";
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
const admin = await account("inst-admin", true),
  person = await account("inst-person");
const wid = await createWorkspace(person.id, "Eigener");

test("admins configure the instance; stored values override the environment", async () => {
  process.env.FLOWPLAN_WORKSPACE_QUOTA_MB = "50";
  process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS = "30";
  assert.equal(await defaultQuotaMb(), 50);
  assert.equal(await retentionDays(), 30);
  const settings = {
    name: "Muster GmbH",
    announcement: "Wartung am Samstag",
    defaultQuotaMb: 200,
    retentionDays: 0,
    maxUploadMb: 25,
    allowWorkspaceCreation: false,
  };
  await assert.rejects(
    async () => await command(person, { action: "admin.settings", settings }),
    /Administrator/,
  );
  await assert.rejects(async () =>
    await command(admin, {
      action: "admin.settings",
      settings: { ...settings, maxUploadMb: 0 },
    }),
  );
  await command(admin, { action: "admin.settings", settings });
  assert.equal(await defaultQuotaMb(), 200);
  assert.equal(await retentionDays(), 0);
  assert.deepEqual((await bootstrap(person, wid)).instance, {
    name: "Muster GmbH",
    announcement: "Wartung am Samstag",
    // No banners to click away (lib/instance-banners.ts).
    banners: [],
    allowWorkspaceCreation: false,
    transcription: false,
    // No DRAWIO_URL: the public diagrams.net (lib/drawio.ts).
    drawio: { url: "https://embed.diagrams.net/", origin: "https://embed.diagrams.net", external: true },
    mail: false,
    // No IMPRINT_URL or PRIVACY_URL set.
    legal: {},
    // Settings → Über Flowplan (no update shown to non-admins).
    about: aboutInfo(),
  });
  await assert.rejects(
    async () => await command(person, { action: "workspace.create", name: "Noch einer" }),
    /nur Admins/,
  );
  assert.ok(
    (
      (await command(admin, { action: "workspace.create", name: "Admin-Bereich" })) as {
        id: string;
      }
    ).id,
  );
  // Empty values fall back to the environment again.
  await command(admin, {
    action: "admin.settings",
    settings: {
      ...settings,
      defaultQuotaMb: null,
      retentionDays: null,
      allowWorkspaceCreation: true,
    },
  });
  assert.equal(await defaultQuotaMb(), 50);
  assert.equal(await retentionDays(), 30);
  assert.ok(
    (
      (await command(person, {
        action: "workspace.create",
        name: "Jetzt erlaubt",
      })) as { id: string }
    ).id,
  );
  delete process.env.FLOWPLAN_WORKSPACE_QUOTA_MB;
  delete process.env.FLOWPLAN_SNAPSHOT_RETENTION_DAYS;
});
