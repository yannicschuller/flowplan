// Accounts that have not signed in (or used a session) for the configured number of days are
// disabled (Administration → Instanz). A disabled account loses its
// sessions and API tokens stop working; an admin can enable it again, and
// the next sign-in through the identity provider needs that.
//
// After a second, longer number of days without any use they are deleted
// (deleteInactiveAccounts): an e-mail 14 days and one 3 days before name the
// day; signing in before it (or an admin enabling a blocked account) keeps
// the account. Without e-mail delivery, an address or for administrators
// nothing is deleted.
import { all, run, transaction } from "./db";
import { instanceSettings } from "./instance-settings";
import {
  mailConfig,
  mailAppUrl,
  mailEscape,
  mailLayout,
  queueMail,
} from "./mail";
import { deleteInactiveAccount } from "./account-deletion";
import { userLocale } from "./user-locale";
import type { Locale } from "./i18n";

export function disableInactiveAccounts(now = Date.now()) {
  const days = instanceSettings().inactiveDays;
  if (!days) return [];
  const cutoff = now - days * 86400_000;
  // Long sessions (stay signed in, the apps) rarely sign in anew: their use
  // counts as activity too, in the browser and through the apps' widgets.
  const stale = all<{ id: string }>(
    `SELECT id FROM users u WHERE disabled=0 AND demo_until IS NULL
       AND COALESCE(last_login_at, CAST(strftime('%s', created_at) AS INTEGER) * 1000) < ?
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.last_seen>=?)
       AND NOT EXISTS (SELECT 1 FROM mobile_devices d WHERE d.user_id=u.id AND d.last_seen_at>=?)`,
    cutoff,
    cutoff,
    cutoff,
  );
  for (const u of stale) {
    run("UPDATE users SET disabled=1 WHERE id=?", u.id);
    run("DELETE FROM sessions WHERE user_id=?", u.id);
    run(
      "INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(lower(hex(randomblob(16))),NULL,'user.inactive',?,?)",
      u.id,
      `${days} Tage ohne Anmeldung`,
    );
  }
  return stale.map((u) => u.id);
}

const DAY = 86400_000;
export const DELETION_NOTICE_DAYS = 14;
export const DELETION_REMINDER_DAYS = 3;

// The last sign of use: a sign-in, a session, the apps, the open app (or
// the account's creation).
const LAST_USE = `MAX(COALESCE(u.last_login_at,0),COALESCE(u.last_active_at,0),
  COALESCE((SELECT max(s.last_seen) FROM sessions s WHERE s.user_id=u.id),0),
  COALESCE((SELECT max(d.last_seen_at) FROM mobile_devices d WHERE d.user_id=u.id),0),
  CAST(strftime('%s', u.created_at) AS INTEGER) * 1000)`;

type Candidate = {
  id: string;
  name: string;
  email: string;
  disabled: number;
  last: number;
  notice: number | null;
  reminder: number | null;
  due: number | null;
  admin: number;
};

export function deleteInactiveAccounts(now = Date.now()) {
  const days = instanceSettings().deleteInactiveDays;
  const done = {
    noticed: [] as string[],
    reminded: [] as string[],
    deleted: [] as string[],
    kept: [] as string[],
  };
  if (!days) {
    // Switched off: nothing pending any more.
    run(
      "UPDATE users SET deletion_notice_at=NULL,deletion_reminder_at=NULL,deletion_due_at=NULL WHERE deletion_due_at IS NOT NULL",
    );
    return done;
  }
  // Nobody is deleted without being told first.
  if (!mailConfig()) return done;
  const people = all<Candidate>(
    `SELECT u.id,u.name,u.email,u.disabled,${LAST_USE} last,u.deletion_notice_at notice,u.deletion_reminder_at reminder,u.deletion_due_at due,
       EXISTS (SELECT 1 FROM local_accounts a WHERE a.user_id=u.id AND a.is_admin=1) admin
     FROM users u WHERE u.demo_until IS NULL AND u.subject NOT LIKE 'deleted:%'`,
  );
  for (const p of people) {
    // Used since the notice: the account stays.
    if (p.notice && p.last > p.notice) {
      run(
        "UPDATE users SET deletion_notice_at=NULL,deletion_reminder_at=NULL,deletion_due_at=NULL WHERE id=?",
        p.id,
      );
      done.kept.push(p.id);
      continue;
    }
    if (p.admin || !/^[^\s@]+@[^\s@]+$/.test(p.email || "")) continue;
    if (!p.due) {
      const deleteAt = p.last + days * DAY;
      if (now < deleteAt - DELETION_NOTICE_DAYS * DAY) continue;
      // Never sooner than the notice promises.
      const due = Math.max(deleteAt, now + DELETION_NOTICE_DAYS * DAY);
      run(
        "UPDATE users SET deletion_notice_at=?,deletion_due_at=? WHERE id=?",
        now,
        due,
        p.id,
      );
      deletionMail(p, due, days, now, false);
      done.noticed.push(p.id);
      continue;
    }
    if (now >= p.due) {
      transaction(() => {
        const plan = deleteInactiveAccount(p.id);
        run(
          "INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(lower(hex(randomblob(16))),NULL,'user.inactiveDeleted',?,?)",
          p.id,
          `${plan.name} · ${days} Tage ohne Nutzung`,
        );
      });
      done.deleted.push(p.id);
      continue;
    }
    if (!p.reminder && now >= p.due - DELETION_REMINDER_DAYS * DAY) {
      run("UPDATE users SET deletion_reminder_at=? WHERE id=?", now, p.id);
      deletionMail(p, p.due, days, now, true);
      done.reminded.push(p.id);
    }
  }
  return done;
}

// The e-mail before the deletion, in the person's language.
function deletionMail(
  p: Candidate,
  due: number,
  days: number,
  now: number,
  reminder: boolean,
) {
  const locale: Locale = userLocale(p.id);
  const de = locale === "de";
  const instance = instanceSettings().name || "Flowplan";
  const date = new Date(due).toLocaleDateString(de ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const away = Math.max(1, Math.floor((now - p.last) / DAY));
  const subject = de
    ? `${reminder ? "Erinnerung: " : ""}Dein Konto bei ${instance} wird am ${date} gelöscht`
    : `${reminder ? "Reminder: " : ""}Your ${instance} account will be deleted on ${date}`;
  const title = de
    ? "Dein Konto wird bald gelöscht"
    : "Your account will be deleted soon";
  const lines = [
    de ? `Hallo ${p.name},` : `Hi ${p.name},`,
    de
      ? `du hast ${instance} seit ${away} Tagen nicht genutzt. Konten ohne Nutzung werden hier nach ${days} Tagen gelöscht – deines am ${date}.`
      : `you have not used ${instance} for ${away} days. Accounts without use are deleted here after ${days} days – yours on ${date}.`,
    p.disabled
      ? de
        ? "Dein Konto ist wegen Inaktivität gesperrt. Wenn du es behalten möchtest, wende dich vor diesem Tag an die Administration dieser Flowplan-Instanz – sie kann es wieder freischalten."
        : "Your account is blocked for inactivity. If you want to keep it, contact the administrators of this Flowplan instance before that day – they can enable it again."
      : de
        ? "Wenn du dein Konto behalten möchtest, melde dich vorher einfach einmal an. Dann bleibt alles, wie es ist. Vorher kannst du deine Inhalte auch exportieren."
        : "If you want to keep your account, simply sign in once before then and everything stays as it is. You can also export your content first.",
    de
      ? "Beim Löschen werden deine persönlichen Daten entfernt, ebenso Arbeitsbereiche und private Bereiche, die nur dir gehören. Was du in gemeinsamen Arbeitsbereichen geschrieben hast, bleibt dort unter „Gelöschtes Konto“ erhalten."
      : "Deleting removes your personal data and the workspaces and private spaces only you belong to. What you wrote in shared workspaces stays there under “Deleted account”.",
  ];
  const action = p.disabled
    ? undefined
    : {
        label: de
          ? "Anmelden und Konto behalten"
          : "Sign in and keep the account",
        url: mailAppUrl(),
      };
  const text = `${lines.join("\n\n")}${action ? `\n\n${action.label}: ${action.url}` : ""}\n`;
  queueMail(
    p.email,
    subject,
    text,
    mailLayout(title, lines.map(mailEscape), action, locale),
  );
}

const runtime = globalThis as unknown as {
  flowplanInactiveTimer?: ReturnType<typeof setInterval>;
};
export function startInactiveWorker() {
  if (runtime.flowplanInactiveTimer) return;
  runtime.flowplanInactiveTimer = setInterval(() => {
    try {
      disableInactiveAccounts();
      deleteInactiveAccounts();
    } catch (error) {
      console.error("Prüfung inaktiver Konten fehlgeschlagen", error);
    }
  }, 6 * 3600_000);
  runtime.flowplanInactiveTimer.unref?.();
}
