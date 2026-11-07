import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-inactive-delete-"),
);
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
const { id, one, all, run } = await import("../lib/db");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { deleteInactiveAccounts, DELETION_NOTICE_DAYS } =
  await import("../lib/inactive-accounts");
const { setUserDisabled } = await import("../lib/account-deletion");

const DAY = 86400_000;
const T = Date.UTC(2026, 9, 28, 12, 0, 0);
// An account last used `away` days before T.
async function account(
  name: string,
  away: number,
  email = `${name.toLowerCase()}@example.test`,
) {
  const userId = id();
  await run(
    "INSERT INTO users(id,subject,email,name,created_at,last_login_at) VALUES(?,?,?,?,'2026-01-01 00:00:00',?)",
    userId,
    `s-${userId}`,
    email,
    name,
    T - away * DAY,
  );
  return userId;
}
const mails = async () =>
  await all<{ recipient: string; subject: string; text: string }>(
    "SELECT recipient,subject,text FROM mail_queue ORDER BY seq",
  );
const exists = async (userId: string) =>
  !!(await one("SELECT 1 FROM users WHERE id=?", userId));

test("without e-mail delivery nobody is deleted", async () => {
  await saveInstanceSettings({ deleteInactiveDays: 90 });
  const old = await account("Ohne", 400);
  assert.deepEqual((await deleteInactiveAccounts(T)).deleted, []);
  assert.ok(await exists(old));
  await run("DELETE FROM users WHERE id=?", old);
});

test("inactive accounts get two e-mails, then go – unless they come back", async () => {
  process.env.SMTP_HOST = "smtp.example.test";
  await saveInstanceSettings({ deleteInactiveDays: 90 });
  const gone = await account("Lena", 80);
  const back = await account("Jonas", 85);
  const fresh = await account("Mia", 10);
  const noMail = await account("Noah", 300, "");
  // 80 days away: deletion is due at day 90, the notice comes 14 days before.
  let r = await deleteInactiveAccounts(T);
  assert.deepEqual(new Set(r.noticed), new Set([gone, back]));
  const due = (await one<{ due: number }>(
    "SELECT deletion_due_at due FROM users WHERE id=?",
    gone,
  ))!.due;
  assert.equal(
    due,
    T + DELETION_NOTICE_DAYS * DAY,
    "never sooner than the notice says",
  );
  assert.match((await mails())[0].subject, /wird am .* gelöscht/);
  assert.match((await mails())[0].text, /melde dich vorher einfach einmal an/);
  // A second run sends nothing new.
  assert.deepEqual((await deleteInactiveAccounts(T + DAY)).noticed, []);
  // Jonas signs in.
  await run("UPDATE users SET last_login_at=? WHERE id=?", T + 2 * DAY, back);
  r = await deleteInactiveAccounts(T + 3 * DAY);
  assert.deepEqual(r.kept, [back]);
  // Three days before: the reminder.
  r = await deleteInactiveAccounts(due - 2 * DAY);
  assert.deepEqual(r.reminded, [gone]);
  assert.match((await mails()).at(-1)!.subject, /^Erinnerung:/);
  // The day comes.
  r = await deleteInactiveAccounts(due + 1);
  assert.deepEqual(r.deleted, [gone]);
  assert.ok(
    !(await exists(gone)) ||
      (await one<{ subject: string }>(
        "SELECT subject FROM users WHERE id=?",
        gone,
      ))!.subject.startsWith("deleted:"),
  );
  assert.ok(
    await exists(back) && await exists(fresh) && await exists(noMail),
    "used again, recent and without address stay",
  );
  assert.ok(
    await one(
      "SELECT 1 FROM audit WHERE action='user.inactiveDeleted' AND resource_id=?",
      gone,
    ),
  );
});

test("a blocked account is told to ask the admins; enabling it keeps it", async () => {
  const blocked = await account("Ida", 200);
  await run("UPDATE users SET disabled=1 WHERE id=?", blocked);
  await deleteInactiveAccounts(T);
  const mail = (await mails()).at(-1)!;
  assert.equal(mail.recipient, "ida@example.test");
  assert.match(mail.text, /wegen Inaktivität gesperrt/);
  await setUserDisabled(blocked, false);
  assert.equal(
    (await one<{ due: number | null }>(
      "SELECT deletion_due_at due FROM users WHERE id=?",
      blocked,
    ))!.due,
    null,
  );
  assert.deepEqual(
    (await deleteInactiveAccounts(T + DAY)).noticed,
    [],
    "enabled counts as used",
  );
});

test("deleting must come after blocking; switched off clears what is pending", async () => {
  await assert.rejects(
    async () => await saveInstanceSettings({ inactiveDays: 120, deleteInactiveDays: 90 }),
    /später kommen als Sperren/,
  );
  const pending = await account("Ben", 200);
  await deleteInactiveAccounts(T);
  await saveInstanceSettings({ inactiveDays: null, deleteInactiveDays: null });
  await deleteInactiveAccounts(T);
  assert.equal(
    (await one<{ due: number | null }>(
      "SELECT deletion_due_at due FROM users WHERE id=?",
      pending,
    ))!.due,
    null,
  );
});
