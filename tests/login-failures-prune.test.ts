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

test("old sign-in failures go, journal PIN failures stay for a day", () => {
  const now = Date.now();
  const hour = 3600_000;
  run("INSERT INTO login_failures(key,at) VALUES(?,?)", "email:a@example.test", now - hour);
  run("INSERT INTO login_failures(key,at) VALUES(?,?)", "pin:u:j", now - hour);
  run("INSERT INTO login_failures(key,at) VALUES(?,?)", "pin:u:j", now - 25 * hour);
  pruneLoginFailures(now - 15 * 60_000, now);
  const count = (key: string) => one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", key)!.n;
  assert.equal(count("email:a@example.test"), 0);
  assert.equal(count("pin:u:j"), 1, "the PIN failure of an hour ago stays; the one older than a day goes");
});
