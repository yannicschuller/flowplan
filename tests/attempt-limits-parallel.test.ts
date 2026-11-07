// Audit (Nov 2026): the limits for wrong passwords, codes and share
// passwords counted first, checked the secret and wrote the failure
// afterwards. On PostgreSQL parallel requests all read the same count before
// any of them wrote one: 300 wrong codes at once, none refused. Now every
// attempt is reserved before the secret is checked (lib/local-auth.ts
// reserveAttempt), so parallel attempts count against each other – on both
// databases (DATABASE_URL=postgres://… npm test runs this on PostgreSQL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-attempt-limits-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_SECRETS_KEY;
const { one, id, run } = await import("../lib/db");
const auth = await import("../lib/local-auth");
const tf = await import("../lib/two-factor");
const totp = await import("../lib/totp");
const { confirmStep } = await import("../lib/step-up");
const { unlockShare } = await import("../lib/share-access");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");

await saveInstanceSettings({ allowSignup: true });
const PARALLEL = 40;
async function account(name: string) {
  const { user } = await auth.register({ name, email: `${name}@example.test`, password: `${name}-passwort-123` }, "de");
  return user;
}
// The status of each of `n` parallel calls.
async function statuses(n: number, fn: (i: number) => Promise<unknown>) {
  return await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      try {
        await fn(i);
        return 200;
      } catch (e) {
        return (e as { status?: number }).status ?? 500;
      }
    }),
  );
}
const count = (list: number[], status: number) => list.filter((s) => s === status).length;
// Parallel wrong attempts, then more one by one until refused: never more
// than `limit` wrong secrets are checked, and none stays reserved.
async function limitedTo(limit: number, attempt: () => Promise<unknown>, keyPrefix: string) {
  const burst = await statuses(PARALLEL, attempt);
  assert.equal(count(burst, 401) + count(burst, 429), PARALLEL, JSON.stringify(burst));
  assert.ok(count(burst, 401) <= limit, `at most ${limit} checked in parallel, got ${count(burst, 401)}`);
  let checked = count(burst, 401);
  for (let i = 0; i < limit + 2; i++) {
    const [status] = await statuses(1, attempt);
    if (status === 429) break;
    assert.equal(status, 401);
    checked++;
  }
  assert.equal(checked, limit, "exactly the limit, parallel or not");
  assert.equal(await statuses(1, attempt).then((s) => s[0]), 429);
  const reserved = await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE substr(key,1,?)=? AND key LIKE '%#%'", keyPrefix.length, keyPrefix);
  assert.equal(Number(reserved?.n), 0, "no reservation left behind");
}

test("parallel wrong codes from the app are limited per account", async () => {
  const user = await account("tina");
  const setup = await tf.startTotpSetup({ id: user.id }, "de");
  await tf.confirmTotpSetup(user.id, { code: totp.totpCode(setup.secret, Date.now()) }, "de");
  await limitedTo(auth.LIMITS.other, () => tf.confirmSecondFactor(user.id, "falsch", "203.0.113.10", "de"), `totp:${user.id}`);
});

test("parallel wrong passwords are limited per name and address", async () => {
  await account("paul");
  await limitedTo(
    auth.LIMITS.nameAddress,
    () => auth.passwordLogin({ email: "paul@example.test", password: "falsch-falsch" }, "198.51.100.20", "de"),
    "email:paul@example.test",
  );
  // The right password from elsewhere still works, and clears the name.
  assert.ok((await auth.passwordLogin({ email: "paul@example.test", password: "paul-passwort-123" }, "198.51.100.21", "de")).userId);
});

test("parallel wrong passwords for a sensitive step are limited", async () => {
  const user = await account("stella");
  await limitedTo(
    auth.LIMITS.other,
    () => confirmStep(user.id, { confirm: { password: "falsch-falsch" } }, { address: "192.0.2.30", locale: "de", sessionStart: null }),
    `totp:${user.id}`,
  );
});

test("parallel wrong share passwords are limited per link and address", async () => {
  const owner = { ...(await account("olivia")), groups: [], isAdmin: false } as unknown as Identity;
  const wid = await createWorkspace(owner.id, "Teilen");
  const boot = await bootstrap(owner, wid);
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Geteilt" })) as { id: string }).id;
  const token = ((await command(owner, { action: "share.create", pageId, role: "viewer", name: "Kunde", password: "geheim-123" })) as { token: string }).token;
  await limitedTo(10, () => unlockShare(token, "falsch", "198.51.100.40"), `share:${token}`);
  // Another address still gets in with the right password.
  assert.ok((await unlockShare(token, "geheim-123", "198.51.100.41")).value);
});

test("an attempt that ends without a verdict leaves no trace", async () => {
  const key = `test:${id()}`;
  const attempt = await auth.reserveAttempt([{ key, limit: 1, windowMs: 60_000 }]);
  assert.ok(attempt);
  // Running attempts count: a second one at the same time is refused.
  assert.equal(await auth.reserveAttempt([{ key, limit: 1, windowMs: 60_000 }]), null);
  await attempt.end();
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE substr(key,1,?)=?", key.length, key))?.n), 0);
  const failing = await auth.reserveAttempt([{ key, limit: 1, windowMs: 60_000 }]);
  await failing!.failed();
  await failing!.end();
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", key))?.n), 1);
  assert.equal(await auth.reserveAttempt([{ key, limit: 1, windowMs: 60_000 }]), null);
  await run("DELETE FROM login_failures WHERE key=?", key);
});
