import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-first-account-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_SETUP_TOKEN;
const { all } = await import("../lib/db");
const auth = await import("../lib/local-auth");

test("without a setup token on a public address the setup is flagged", () => {
  assert.equal(auth.firstAccount(), true);
  assert.equal(auth.unprotectedSetup(), true);
  assert.match(auth.setupWarning(), /FLOWPLAN_SETUP_TOKEN/);
  assert.equal(auth.loginOptions().unprotectedSetup, true);
  const before = process.env.APP_URL;
  try {
    // A local address is a test on this machine, not worth a warning.
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      process.env.APP_URL = url;
      assert.equal(auth.unprotectedSetup(), false, url);
      assert.equal(auth.setupWarning(), "", url);
    }
    process.env.APP_URL = before;
    process.env.FLOWPLAN_SETUP_TOKEN = "einrichten";
    assert.equal(auth.unprotectedSetup(), false);
    assert.equal(auth.loginOptions("einrichten").unprotectedSetup, false);
  } finally {
    process.env.APP_URL = before;
    delete process.env.FLOWPLAN_SETUP_TOKEN;
  }
});

test("two sign-ups at the same moment: only one becomes the administrator", async () => {
  const results = await Promise.allSettled([
    auth.register({ name: "Ana", email: "ana@example.test", password: "ein-langes-passwort" }, "en"),
    auth.register({ name: "Ben", email: "ben@example.test", password: "ein-langes-passwort" }, "en"),
    auth.register({ name: "Cem", email: "cem@example.test", password: "ein-langes-passwort" }, "de"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(refused.length, 2);
  for (const r of refused) assert.equal(r.reason.status, 409);
  assert.deepEqual(
    all<{ is_admin: number }>("SELECT is_admin FROM local_accounts").map((a) => a.is_admin),
    [1],
  );
  assert.equal(all("SELECT id FROM users WHERE subject LIKE 'local:%'").length, 1);
  // Set up: no warning and no note any more.
  assert.equal(auth.setupWarning(), "");
  assert.equal(auth.loginOptions().unprotectedSetup, false);
});
