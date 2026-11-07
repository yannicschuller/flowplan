// Daily byte budgets of visitors without an account (lib/anonymous-budget.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-anonymous-budget-"));
const { one } = await import("../lib/db");
const { takeAnonymousBudget, anonymousBytesToday, anonymousInstanceMb, ANONYMOUS_UPLOAD_MB } = await import("../lib/anonymous-budget");

const MB = 1024 * 1024;
const fails = async (fn: () => unknown, status: number, text: RegExp) =>
  assert.rejects(async () => fn(), (e: any) => e.status === status && text.test(e.message));

test("each form or link has its own daily budget; the instance has one on top", async () => {
  delete process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB;
  assert.equal(anonymousInstanceMb(), 1024);
  const now = Date.UTC(2026, 9, 21, 12);
  await takeAnonymousBudget("form:a", 150 * MB, ANONYMOUS_UPLOAD_MB, now);
  assert.equal(await anonymousBytesToday("form:a", now), 150 * MB);
  // 200 MB per scope and day: the next 60 MB do not fit, 50 MB do.
  await fails(async () => await takeAnonymousBudget("form:a", 60 * MB, ANONYMOUS_UPLOAD_MB, now + 1), 413, /Tageslimit/);
  await takeAnonymousBudget("form:a", 50 * MB, ANONYMOUS_UPLOAD_MB, now + 2);
  // Another form is not affected by the first one's budget …
  await takeAnonymousBudget("form:b", 200 * MB, ANONYMOUS_UPLOAD_MB, now + 3);
  // … but the instance counts everything together.
  process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB = "450";
  await fails(async () => await takeAnonymousBudget("share:c", 60 * MB, ANONYMOUS_UPLOAD_MB, now + 4), 413, /Instanz/);
  await takeAnonymousBudget("share:c", 40 * MB, ANONYMOUS_UPLOAD_MB, now + 5);
  // A scope may carry its own limit; nothing is counted for a refused write.
  await fails(async () => await takeAnonymousBudget("live:d", 2 * MB, 1, now + 6), 413, /Tageslimit/);
  assert.equal(await anonymousBytesToday("live:d", now + 6), 0);
  // 0 switches the instance limit off; a day later the budgets are fresh.
  process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB = "0";
  assert.equal(anonymousInstanceMb(), 0);
  const tomorrow = now + 86_400_000 + 10;
  await takeAnonymousBudget("form:a", 200 * MB, ANONYMOUS_UPLOAD_MB, tomorrow);
  assert.equal(await anonymousBytesToday("form:a", tomorrow), 200 * MB);
  assert.equal(await one("SELECT 1 FROM anonymous_uploads WHERE at<?", tomorrow - 86_400_000), undefined, "old rows are swept");
  delete process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB;
});
