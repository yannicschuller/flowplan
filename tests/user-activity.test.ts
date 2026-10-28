import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-activity-"),
);
const { id, run } = await import("../lib/db");
const { adminGroup } = await import("../lib/auth");
const { recordActivity, userActivity } = await import("../lib/user-activity");
const { activityState, ONLINE_MS } = await import("../lib/user-activity-state");

const person = (isAdmin = false): Identity => {
  const userId = id();
  run(
    "INSERT INTO users(id,subject,email,name,created_at) VALUES(?,?,?,?,datetime('now'))",
    userId,
    `s-${userId}`,
    `${userId}@example.test`,
    "Mia",
  );
  return {
    id: userId,
    name: "Mia",
    email: "",
    groups: isAdmin ? [adminGroup()] : [],
    isAdmin,
    disabled: 0,
    created_at: "",
  };
};
const T = Date.UTC(2026, 9, 28, 12, 0, 0);

// The open app pings; the administration sees in use, idle (and since
// when) and closed.
test("activity: open, in use, idle and closed", () => {
  const admin = person(true);
  const mia = person();
  const of = () => userActivity(admin).find((a) => a.id === mia.id)!;
  assert.equal(activityState(of(), T), "never");
  recordActivity(mia, { idleMs: 10_000 }, T);
  assert.deepEqual([of().openAt, of().activeAt], [T, T - 10_000]);
  assert.equal(activityState(of(), T + 30_000), "active");
  // Still open a few minutes later, but nobody touched it.
  recordActivity(mia, { idleMs: 4 * 60_000 }, T + 4 * 60_000);
  assert.equal(of().activeAt, T, "the last use stays where it was");
  assert.equal(activityState(of(), T + 4 * 60_000), "idle");
  // The app closed: no pings any more.
  assert.equal(activityState(of(), T + 4 * 60_000 + ONLINE_MS + 1), "offline");
});

test("activity: only admins read it, API tokens do not ping", () => {
  const mia = person();
  assert.throws(() => userActivity(mia), /Administrator/);
  assert.deepEqual(
    recordActivity({ ...mia, apiScope: "write" }, { idleMs: 0 }, T),
    { ok: false },
  );
  assert.equal(
    userActivity(person(true)).find((a) => a.id === mia.id)!.openAt,
    null,
  );
});
