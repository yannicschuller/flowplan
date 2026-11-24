import { nowText } from "../lib/db-driver/dialect";
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

const person = async (isAdmin = false): Promise<Identity> => {
  const userId = id();
  await run(
    "INSERT INTO users(id,subject,email,name,created_at) VALUES(?,?,?,?,?)",
    userId,
    `s-${userId}`,
    `${userId}@example.test`,
    "Mia", nowText(),
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
test("activity: open, in use, idle and closed", async () => {
  const admin = await person(true);
  const mia = await person();
  const of = async () => (await userActivity(admin)).find((a) => a.id === mia.id)!;
  assert.equal(activityState(await of(), T), "never");
  await recordActivity(mia, { idleMs: 10_000 }, T);
  assert.deepEqual([(await of()).openAt, (await of()).activeAt], [T, T - 10_000]);
  assert.equal(activityState(await of(), T + 30_000), "active");
  // Still open a few minutes later, but nobody touched it.
  await recordActivity(mia, { idleMs: 4 * 60_000 }, T + 4 * 60_000);
  assert.equal((await of()).activeAt, T, "the last use stays where it was");
  assert.equal(activityState(await of(), T + 4 * 60_000), "idle");
  // The app closed: no pings any more.
  assert.equal(activityState(await of(), T + 4 * 60_000 + ONLINE_MS + 1), "offline");
});

test("activity: only admins read it, API tokens do not ping", async () => {
  const mia = await person();
  await assert.rejects(async () => await userActivity(mia), /Administrator/);
  assert.deepEqual(
    await recordActivity({ ...mia, apiScope: "write" }, { idleMs: 0 }, T),
    { ok: false },
  );
  assert.equal(
    (await userActivity(await person(true))).find((a) => a.id === mia.id)!.openAt,
    null,
  );
});

// One ping per browser (#515, components/activity-share.ts): the leading
// tab pings for all tabs with the idle time of the most recently used one.
// "Who is here" reads the same; a silent leading tab is replaced by a
// follower before the account counts as closed.
test("activity: one ping per browser keeps who is here", async () => {
  const { EVERY_MS, SILENT_MS } = await import("../components/activity-share");
  assert.ok(SILENT_MS + EVERY_MS <= ONLINE_MS, "a follower takes over before the account looks closed");
  const admin = await person(true);
  const mia = await person();
  const of = async () => (await userActivity(admin)).find((a) => a.id === mia.id)!;
  // Minute 0: the leading tab is hidden, another tab was used 5 s ago.
  await recordActivity(mia, { idleMs: 5_000 }, T);
  // Minutes 1..3: only the leading tab pings, nobody uses anything.
  for (let m = 1; m <= 3; m++) await recordActivity(mia, { idleMs: m * 60_000 + 5_000 }, T + m * 60_000);
  assert.deepEqual([(await of()).openAt, (await of()).activeAt], [T + 3 * 60_000, T - 5_000]);
  assert.equal(activityState(await of(), T + 3 * 60_000), "idle");
  // Coming back in any tab: the next ping (sent at once) says so.
  await recordActivity(mia, { idleMs: 0 }, T + 3 * 60_000 + 1_000);
  assert.equal(activityState(await of(), T + 3 * 60_000 + 1_000), "active");
});
