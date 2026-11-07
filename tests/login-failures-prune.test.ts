// Journal PIN attempts count over a day (lib/journal-extras.ts); the
// sign-in limits' cleanup (15 minutes) must not wipe them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-prune-"));
const { run, one } = await import("../lib/db");
const { pruneLoginFailures } = await import("../lib/local-auth");

test("old sign-in failures go, journal PIN failures stay for a day", async () => {
  const now = Date.now();
  const hour = 3600_000;
  await run("INSERT INTO login_failures(key,at) VALUES(?,?)", "email:a@example.test", now - hour);
  await run("INSERT INTO login_failures(key,at) VALUES(?,?)", "pin:u:j", now - hour);
  await run("INSERT INTO login_failures(key,at) VALUES(?,?)", "pin:u:j", now - 25 * hour);
  await pruneLoginFailures(now - 15 * 60_000, now);
  const count = async (key: string) => (await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", key))!.n;
  assert.equal(await count("email:a@example.test"), 0);
  assert.equal(await count("pin:u:j"), 1, "the PIN failure of an hour ago stays; the one older than a day goes");
});
