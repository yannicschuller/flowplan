// The traffic lights of the administrators' setup in the introduction
// (lib/admin-setup-status.ts) from the administration's summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminSetupStatus, type SetupFacts } from "../lib/admin-setup-status";

const ready: SetupFacts = {
  general: { plainHttp: false, appUrlSet: true, https: true },
  mail: { configured: true, failed: 0 },
  storage: { backup: { enabled: true, lastAt: Date.now(), failed: false } },
  signin: { oidc: true, ldap: false, ldapError: false },
  ai: { enabled: true, provider: "ollama" },
};
const light = (facts: SetupFacts, id: string) => adminSetupStatus(facts).find((i) => i.id === id)!;

test("a fully set up instance is green everywhere, in the order to work through", () => {
  const items = adminSetupStatus(ready);
  assert.deepEqual(items.map((i) => i.id), ["https", "mail", "backup", "signin", "ai"]);
  assert.ok(items.every((i) => i.light === "green" && i.reason === "ok"));
  // Each links to its section of the administration.
  assert.deepEqual(items.map((i) => i.section), ["general", "mail", "storage", "signin", "ai"]);
});

test("missing basics are red, optional ones yellow", () => {
  const fresh: SetupFacts = {
    general: { plainHttp: false, appUrlSet: false, https: false },
    mail: { configured: false, failed: 0 },
    storage: { backup: { enabled: false, lastAt: null, failed: false } },
    signin: { oidc: false, ldap: false, ldapError: false },
    ai: { enabled: false, provider: null },
  };
  assert.deepEqual(
    adminSetupStatus(fresh).map((i) => [i.id, i.light, i.reason]),
    [
      ["https", "yellow", "https-unset"],
      ["mail", "red", "mail-off"],
      ["backup", "red", "backup-off"],
      ["signin", "yellow", "signin-local"],
      ["ai", "yellow", "ai-off"],
    ],
  );
  assert.equal(light({ ...ready, general: { plainHttp: true, appUrlSet: true, https: false } }, "https").light, "red");
  assert.equal(light({ ...ready, general: { plainHttp: false, appUrlSet: true, https: false } }, "https").reason, "https-local");
  assert.equal(light({ ...ready, mail: { configured: true, failed: 2 } }, "mail").light, "yellow");
  assert.equal(light({ ...ready, storage: { backup: { enabled: true, lastAt: null, failed: false } } }, "backup").reason, "backup-pending");
  assert.equal(light({ ...ready, storage: { backup: { enabled: true, lastAt: 1, failed: true } } }, "backup").light, "red");
  assert.equal(light({ ...ready, signin: { oidc: false, ldap: true, ldapError: true } }, "signin").light, "red");
  assert.equal(light({ ...ready, signin: { oidc: false, ldap: true, ldapError: false } }, "signin").light, "green");
  assert.equal(light({ ...ready, ai: { enabled: true, provider: null } }, "ai").reason, "ai-no-provider");
});

test("the summary of a fresh instance carries the facts", async () => {
  process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-admin-setup-"));
  const before = { APP_URL: process.env.APP_URL, SMTP_HOST: process.env.SMTP_HOST, OIDC_ISSUER: process.env.OIDC_ISSUER };
  delete process.env.SMTP_HOST;
  delete process.env.OIDC_ISSUER;
  try {
    const { adminSummary } = await import("../lib/admin-summary");
    process.env.APP_URL = "https://flowplan.example";
    let summary = await adminSummary();
    assert.equal(summary.general.appUrlSet, true);
    assert.equal(summary.general.https, true);
    const items = adminSetupStatus(summary);
    assert.equal(items.find((i) => i.id === "https")?.light, "green");
    assert.equal(items.find((i) => i.id === "mail")?.light, "red");
    assert.equal(items.find((i) => i.id === "signin")?.light, "yellow");
    delete process.env.APP_URL;
    summary = await adminSummary();
    assert.equal(summary.general.appUrlSet, false);
    assert.equal(adminSetupStatus(summary).find((i) => i.id === "https")?.reason, "https-unset");
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
