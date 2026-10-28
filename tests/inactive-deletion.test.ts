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
function account(
  name: string,
  away: number,
  email = `${name.toLowerCase()}@example.test`,
) {
  const userId = id();
  run(
    "INSERT INTO users(id,subject,email,name,created_at,last_login_at) VALUES(?,?,?,?,'2026-01-01 00:00:00',?)",
    userId,
    `s-${userId}`,
    email,
    name,
    T - away * DAY,
  );
  return userId;
}
const mails = () =>
  all<{ recipient: string; subject: string; text: string }>(
    "SELECT recipient,subject,text FROM mail_queue ORDER BY rowid",
  );
const exists = (userId: string) =>
  !!one("SELECT 1 FROM users WHERE id=?", userId);

test("without e-mail delivery nobody is deleted", () => {
  saveInstanceSettings({ deleteInactiveDays: 90 });
  const old = account("Ohne", 400);
  assert.deepEqual(deleteInactiveAccounts(T).deleted, []);
  assert.ok(exists(old));
  run("DELETE FROM users WHERE id=?", old);
});

test("inactive accounts get two e-mails, then go – unless they come back", () => {
  process.env.SMTP_HOST = "smtp.example.test";
  saveInstanceSettings({ deleteInactiveDays: 90 });
  const gone = account("Lena", 80);
  const back = account("Jonas", 85);
  const fresh = account("Mia", 10);
  const noMail = account("Noah", 300, "");
  // 80 days away: deletion is due at day 90, the notice comes 14 days before.
  let r = deleteInactiveAccounts(T);
  assert.deepEqual(new Set(r.noticed), new Set([gone, back]));
  const due = one<{ due: number }>(
    "SELECT deletion_due_at due FROM users WHERE id=?",
    gone,
  )!.due;
  assert.equal(
    due,
    T + DELETION_NOTICE_DAYS * DAY,
    "never sooner than the notice says",
  );
  assert.match(mails()[0].subject, /wird am .* gelöscht/);
  assert.match(mails()[0].text, /melde dich vorher einfach einmal an/);
  // A second run sends nothing new.
  assert.deepEqual(deleteInactiveAccounts(T + DAY).noticed, []);
  // Jonas signs in.
  run("UPDATE users SET last_login_at=? WHERE id=?", T + 2 * DAY, back);
  r = deleteInactiveAccounts(T + 3 * DAY);
  assert.deepEqual(r.kept, [back]);
  // Three days before: the reminder.
  r = deleteInactiveAccounts(due - 2 * DAY);
  assert.deepEqual(r.reminded, [gone]);
  assert.match(mails().at(-1)!.subject, /^Erinnerung:/);
  // The day comes.
  r = deleteInactiveAccounts(due + 1);
  assert.deepEqual(r.deleted, [gone]);
  assert.ok(
    !exists(gone) ||
      one<{ subject: string }>(
        "SELECT subject FROM users WHERE id=?",
        gone,
      )!.subject.startsWith("deleted:"),
  );
  assert.ok(
    exists(back) && exists(fresh) && exists(noMail),
    "used again, recent and without address stay",
  );
  assert.ok(
    one(
      "SELECT 1 FROM audit WHERE action='user.inactiveDeleted' AND resource_id=?",
      gone,
    ),
  );
});

test("a blocked account is told to ask the admins; enabling it keeps it", () => {
  const blocked = account("Ida", 200);
  run("UPDATE users SET disabled=1 WHERE id=?", blocked);
  deleteInactiveAccounts(T);
  const mail = mails().at(-1)!;
  assert.equal(mail.recipient, "ida@example.test");
  assert.match(mail.text, /wegen Inaktivität gesperrt/);
  setUserDisabled(blocked, false);
  assert.equal(
    one<{ due: number | null }>(
      "SELECT deletion_due_at due FROM users WHERE id=?",
      blocked,
    )!.due,
    null,
  );
  assert.deepEqual(
    deleteInactiveAccounts(T + DAY).noticed,
    [],
    "enabled counts as used",
  );
});

test("deleting must come after blocking; switched off clears what is pending", () => {
  assert.throws(
    () => saveInstanceSettings({ inactiveDays: 120, deleteInactiveDays: 90 }),
    /später kommen als Sperren/,
  );
  const pending = account("Ben", 200);
  deleteInactiveAccounts(T);
  saveInstanceSettings({ inactiveDays: null, deleteInactiveDays: null });
  deleteInactiveAccounts(T);
  assert.equal(
    one<{ due: number | null }>(
      "SELECT deletion_due_at due FROM users WHERE id=?",
      pending,
    )!.due,
    null,
  );
});
