// The upgrade link of hosted offerings (lib/upgrade-link.ts): off unless
// both variables are set, and a token format another service can verify –
// tests/fixtures/upgrade-token.json is the shared test vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-upgrade-"));
process.env.APP_URL = "https://app.example.org/";
delete process.env.FLOWPLAN_UPGRADE_URL;
delete process.env.FLOWPLAN_UPGRADE_SECRET;
const { upgradeToken, upgradeConfig, upgradeUrlFor, upgradeRedirect, instanceOrigin, UPGRADE_TOKEN_SECONDS } = await import("../lib/upgrade-link");
const vector = JSON.parse(readFileSync(new URL("./fixtures/upgrade-token.json", import.meta.url), "utf8"));
const person = { id: "u1", email: "a@example.org", name: "A" };

test("the token matches the test vector byte for byte", () => {
  assert.equal(upgradeToken(vector.secret, vector.person, vector.origin, vector.nowMs), vector.token);
  // Recomputed from the description alone, as a verifier would.
  const [payload, signature] = vector.token.split(".");
  assert.equal(Buffer.from(payload, "base64url").toString("utf8"), vector.payloadJson);
  assert.equal(createHmac("sha256", vector.secret).update(payload).digest("base64url"), signature);
  assert.deepEqual(Object.keys(JSON.parse(vector.payloadJson)), ["u", "e", "n", "i", "exp"]);
  assert.equal(JSON.parse(vector.payloadJson).exp, Math.floor(vector.nowMs / 1000) + 15 * 60);
  assert.equal(UPGRADE_TOKEN_SECONDS, 900);
  assert.doesNotMatch(vector.token, /[=+/]/, "base64url without padding");
});

test("off unless an https address and a secret of 32+ characters are set", () => {
  assert.equal(upgradeConfig(), null);
  process.env.FLOWPLAN_UPGRADE_URL = "https://flowplan.example/upgrade";
  process.env.FLOWPLAN_UPGRADE_SECRET = "short";
  assert.equal(upgradeConfig(), null);
  process.env.FLOWPLAN_UPGRADE_SECRET = "s".repeat(32);
  assert.ok(upgradeConfig());
  process.env.FLOWPLAN_UPGRADE_URL = "http://flowplan.example/upgrade";
  assert.equal(upgradeConfig(), null);
  process.env.FLOWPLAN_UPGRADE_URL = "https://flowplan.example/upgrade";
});

test("the link carries a verifiable token for the instance's origin; demo accounts and API tokens get none", async () => {
  process.env.FLOWPLAN_UPGRADE_URL = "https://flowplan.example/upgrade";
  process.env.FLOWPLAN_UPGRADE_SECRET = "s".repeat(32);
  const now = Date.UTC(2026, 0, 1);
  const url = new URL(upgradeUrlFor(person, now)!);
  assert.equal(url.origin + url.pathname, "https://flowplan.example/upgrade");
  const token = url.searchParams.get("t")!;
  assert.equal(token, upgradeToken("s".repeat(32), person, "https://app.example.org", now));
  assert.equal(instanceOrigin(), "https://app.example.org");
  assert.equal(upgradeUrlFor({ ...person, demo: true }), null);
  assert.equal(upgradeUrlFor({ ...person, apiScope: "write" }), null);
  const redirect = upgradeRedirect(person);
  assert.equal(redirect.status, 303);
  assert.match(redirect.headers.get("location")!, /^https:\/\/flowplan\.example\/upgrade\?t=[\w-]+\.[\w-]+$/);
  assert.equal(upgradeRedirect(null).status, 401);
  delete process.env.FLOWPLAN_UPGRADE_URL;
  assert.equal(upgradeRedirect(person).status, 404);
  delete process.env.FLOWPLAN_UPGRADE_SECRET;
});
