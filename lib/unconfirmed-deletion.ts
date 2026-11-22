// Accounts whose e-mail address was never confirmed, marked for deletion
// (#436): spam sign-ups and mistyped addresses go, real people keep their
// account by confirming.
//
// - Administration → Benutzer marks one account or every filtered one
//   ("Zur Löschung vormerken …"); optionally the automatic rule under
//   Anmeldung & SSO marks accounts still unconfirmed X days (at least 7)
//   after they were created (instance setting unconfirmedAutoDays). An
//   account whose marking an administrator cancelled is not marked by the
//   rule again – only by hand.
// - Which accounts count: accounts with e-mail and password whose address
//   is unconfirmed, not demo accounts, none linked to SSO, LDAP or SCIM
//   (their provider vouches for the address, there is no local
//   confirmation). An account an administrator created (#433, "Eingeladen")
//   counts only once its link to set the password has expired: until then
//   the person had no chance to confirm. Never marked: administrators and
//   the acting administrator.
// - Only while the instance sends e-mail: nobody is deleted without being
//   told. Without SMTP the action is hidden, the commands refuse, and the
//   job waits (nothing is reminded or deleted until e-mail works again).
// - The marked person gets an e-mail with the day of deletion (today + 14
//   days) and a link that confirms the address; it works once and until that
//   day (kind 'verify-keep' in auth_tokens, opened through /api/auth/verify
//   like the confirmation link, lib/local-auth.ts verifyEmail). Confirming
//   the address in any way (that link, the confirmation link, a password
//   reset, an administrator's "Als bestätigt markieren", an e-mail change)
//   ends the marking. Signing in does not; the app shows a notice with
//   "Bestätigungslink erneut senden" instead.
// - 3 days before, a reminder with a fresh link (the first stays valid);
//   on the day the account is deleted like any deletion (lib/account-deletion.ts):
//   what it wrote in shared workspaces stays as "Gelöschtes Konto".
// - The job runs on the leader only (lib/cluster/leader.ts) and every step
//   is a conditional write, so two rounds at once never send a mail twice
//   or delete twice.
// - Every step is in the activity log and in the security events.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, id as newId, one, run, transaction } from "./db";
import { db } from "./db-driver";
import { HttpError, adminUserIds, appUrl, hash } from "./auth";
import { instanceSettings } from "./instance-settings";
import { mailConfig, queueLinkMail } from "./mail";
import { securityEvent } from "./security-events";
import { userLocale } from "./user-locale";
import { localeTag, translate, type Locale } from "./i18n";
import { allow } from "./action-limits";
import { deleteInactiveAccount } from "./account-deletion";
import { fireBeforeDeletion } from "./dead-man-switch";
import { leaderDuty } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import type { Identity } from "./types";

const DAY = 86_400_000;
export const UNCONFIRMED_NOTICE_DAYS = 14;
export const UNCONFIRMED_REMINDER_DAYS = 3;
export const UNCONFIRMED_AUTO_MIN_DAYS = 7;
const KEEP_KIND = "verify-keep";
const MAX_ACCOUNTS = 5000;

// Password sign-in (lib/local-auth.ts localLoginEnabled, not imported: that
// module imports this one).
const localLogin = () => process.env.FLOWPLAN_LOCAL_LOGIN !== "false";
export const unconfirmedDeletionAvailable = () => !!mailConfig() && localLogin();

type Candidate = {
  id: string;
  name: string;
  email: string;
  admin: number;
  created: number;
  due: number | null;
  reminder: number | null;
  cancelled: number | null;
};

// Every account whose address counts as unconfirmed (see above), with its
// marking if any.
async function candidates(now: number, only?: string[]): Promise<Candidate[]> {
  if (only && !only.length) return [];
  const filter = only ? ` AND u.id IN (${only.map(() => "?").join(",")})` : "";
  return (await all<Candidate>(
    `SELECT u.id,u.name,u.email,a.is_admin admin,COALESCE(a.created_at,${db.dialect.textMs("u.created_at")}) created,
       d.due_at due,d.reminder_at reminder,d.cancelled_at cancelled
     FROM local_accounts a JOIN users u ON u.id=a.user_id
     LEFT JOIN unconfirmed_deletions d ON d.user_id=u.id
     WHERE a.email_verified=0 AND u.demo_until IS NULL AND u.subject NOT LIKE 'deleted:%'
       AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM scim_users s WHERE s.user_id=u.id)
       AND NOT EXISTS (SELECT 1 FROM auth_tokens t WHERE t.user_id=u.id AND t.kind IN ('welcome','welcome-link') AND t.expires>=?)${filter}`,
    now,
    ...(only || []),
  )).map((c) => ({ ...c, created: Number(c.created), due: c.due === null ? null : Number(c.due), reminder: c.reminder === null ? null : Number(c.reminder), cancelled: c.cancelled === null ? null : Number(c.cancelled) }));
}
const validAddress = (email: string) => /^[^\s@]+@[^\s@]+$/.test(email || "");
const active = (c: Candidate) => c.due !== null && c.cancelled === null;

// Why an account cannot be marked (null: it can).
function exemption(c: Candidate, admins: Set<string>, actorId: string | null) {
  if (c.id === actorId) return "self";
  if (c.admin || admins.has(c.id)) return "admin";
  if (!validAddress(c.email)) return "address";
  if (active(c)) return "marked";
  return null;
}

// Administration → Benutzer: which accounts are unconfirmed, which can be
// marked, and the marked ones with their day.
export async function unconfirmedOverview(admin: Identity, now = Date.now()) {
  const list = await candidates(now);
  const admins = new Set(await adminUserIds());
  return {
    available: unconfirmedDeletionAvailable(),
    ids: list.map((c) => c.id),
    markable: list.filter((c) => !exemption(c, admins, admin.id)).map((c) => c.id),
    marks: Object.fromEntries(list.filter(active).map((c) => [c.id, c.due!])),
  };
}

function requireAvailable(locale: Locale) {
  const t = translate(locale);
  if (!unconfirmedDeletionAvailable())
    throw new HttpError(
      409,
      t(
        "Diese Instanz versendet keine E-Mails: Ohne Vorwarnung per E-Mail wird kein Konto zur Löschung vorgemerkt.",
        "This instance sends no e-mail: without a warning by e-mail no account is marked for deletion.",
      ),
    );
}
const idsSchema = z.array(z.uuid()).min(1).max(MAX_ACCOUNTS);

// Has the person written something in a workspace someone else belongs to?
async function sharedContent(userId: string) {
  return !!(await one(
    `SELECT 1 FROM members m WHERE m.user_id=? AND EXISTS (SELECT 1 FROM members o WHERE o.workspace_id=m.workspace_id AND o.user_id<>m.user_id)
       AND (EXISTS (SELECT 1 FROM pages p WHERE p.workspace_id=m.workspace_id AND p.created_by=?)
         OR EXISTS (SELECT 1 FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=m.workspace_id AND r.created_by=?)
         OR EXISTS (SELECT 1 FROM comments c JOIN pages p ON p.id=c.page_id WHERE p.workspace_id=m.workspace_id AND c.author_id=?))
     LIMIT 1`,
    userId,
    userId,
    userId,
    userId,
  ));
}

// The dialog before marking: how many, the day, how many have content in
// shared workspaces (it stays as "Gelöschtes Konto"), how many are left out.
export async function unconfirmedPlan(admin: Identity, input: unknown, locale: Locale, now = Date.now()) {
  requireAvailable(locale);
  const ids = idsSchema.parse((input as { userIds?: unknown })?.userIds);
  const list = await candidates(now, ids);
  const admins = new Set(await adminUserIds());
  const markable = list.filter((c) => !exemption(c, admins, admin.id));
  let shared = 0;
  for (const c of markable) if (await sharedContent(c.id)) shared++;
  return { count: markable.length, skipped: ids.length - markable.length, shared, due: now + UNCONFIRMED_NOTICE_DAYS * DAY };
}

// One link that confirms the address and keeps the account, valid until
// the day of deletion. Earlier ones stay valid (the reminder's link and the
// first one both work); using one ends all of them.
async function issueKeepLink(userId: string, due: number, now: number) {
  const token = randomBytes(32).toString("base64url");
  await run("DELETE FROM auth_tokens WHERE expires<?", now);
  await run("INSERT INTO auth_tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", hash(token), userId, KEEP_KIND, due);
  return `${appUrl().replace(/\/$/, "")}/api/auth/verify?token=${token}`;
}
// The link from the e-mail (lib/local-auth.ts verifyEmail): whose it is,
// once.
export async function takeKeepToken(token: string, now = Date.now()) {
  if (!token || token.length > 200) return null;
  const row = await one<{ user_id: string; expires: number }>("SELECT user_id,expires FROM auth_tokens WHERE id=? AND kind=?", hash(token), KEEP_KIND);
  if (!row || Number(row.expires) < now) return null;
  if (!(await run("DELETE FROM auth_tokens WHERE id=? AND kind=?", hash(token), KEEP_KIND)).changes) return null;
  return row.user_id;
}

const dateText = (due: number, locale: Locale) =>
  new Date(due).toLocaleDateString(localeTag(locale), { day: "numeric", month: "long", year: "numeric" });

async function warningMail(c: Pick<Candidate, "id" | "name" | "email">, due: number, now: number, reminder: boolean) {
  const locale = await userLocale(c.id);
  const t = translate(locale);
  const instance = (await instanceSettings()).name || "Flowplan";
  const date = dateText(due, locale);
  const url = await issueKeepLink(c.id, due, now);
  return await queueLinkMail({
    to: c.email,
    subject: reminder
      ? t(`Erinnerung: Bestätige deine Adresse, sonst wird dein Konto am ${date} gelöscht`, `Reminder: confirm your address, or your account will be deleted on ${date}`)
      : t(`Bestätige deine Adresse, sonst wird dein Konto am ${date} gelöscht`, `Confirm your address, or your account will be deleted on ${date}`),
    title: t("Bestätige deine E-Mail-Adresse", "Confirm your e-mail address"),
    lines: [
      t(`Hallo ${c.name},`, `Hi ${c.name},`),
      t(
        `die E-Mail-Adresse deines Kontos bei ${instance} ist noch nicht bestätigt. Konten mit unbestätigter Adresse werden hier gelöscht – deines am ${date}.`,
        `the e-mail address of your ${instance} account is not confirmed yet. Accounts with an unconfirmed address are deleted here – yours on ${date}.`,
      ),
      t(
        "Bestätige deine Adresse mit dem Link unten, dann bleibt dein Konto, wie es ist. Der Link gilt bis zu diesem Tag und nur einmal. Nur anmelden reicht nicht.",
        "Confirm your address with the link below and your account stays as it is. The link is valid until that day and only once. Signing in alone is not enough.",
      ),
      t(
        "Beim Löschen werden deine persönlichen Daten entfernt, ebenso Arbeitsbereiche und private Bereiche, die nur dir gehören. Was du in gemeinsamen Arbeitsbereichen geschrieben hast, bleibt dort unter „Gelöschtes Konto“ erhalten.",
        "Deleting removes your personal data and the workspaces and private spaces only you belong to. What you wrote in shared workspaces stays there under “Deleted account”.",
      ),
      t("Hast du hier kein Konto angelegt, kannst du diese E-Mail ignorieren.", "If you did not create an account here, you can ignore this e-mail."),
    ],
    label: t("Adresse bestätigen und Konto behalten", "Confirm the address and keep the account"),
    url,
  });
}

async function auditEntry(actor: string | null, action: string, resource: string, detail: string) {
  await run("INSERT INTO audit(id,actor_id,action,resource_id,detail) VALUES(?,?,?,?,?)", newId(), actor, action, resource, detail);
}
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Marks accounts (an administrator's choice, or the automatic rule with
// `admin` null): a row, the e-mail, an entry in the activity log. Accounts
// that cannot be marked are left out, not refused.
async function mark(admin: Identity | null, list: Candidate[], now: number) {
  const admins = new Set(await adminUserIds());
  const due = now + UNCONFIRMED_NOTICE_DAYS * DAY;
  const marked: string[] = [];
  for (const c of list) {
    if (exemption(c, admins, admin?.id ?? null)) continue;
    // Conditional: a second request (or round) at the same moment marks nothing.
    const changed = (await run(
      `INSERT INTO unconfirmed_deletions(user_id,due_at,marked_at,marked_by,reminder_at,cancelled_at) VALUES(?,?,?,?,NULL,NULL)
       ON CONFLICT(user_id) DO UPDATE SET due_at=excluded.due_at,marked_at=excluded.marked_at,marked_by=excluded.marked_by,reminder_at=NULL,cancelled_at=NULL
       WHERE unconfirmed_deletions.cancelled_at IS NOT NULL`,
      c.id,
      due,
      now,
      admin?.id ?? null,
    )).changes;
    if (!changed) continue;
    await warningMail(c, due, now, false);
    await auditEntry(admin?.id ?? null, admin ? "admin.markUnconfirmed" : "user.unconfirmedMarked", c.id, `${c.email} · ${isoDay(due)}`);
    marked.push(c.id);
  }
  if (marked.length)
    securityEvent("admin.deletion_marked", { actorId: admin?.id ?? null, detail: `${marked.length} unconfirmed account(s), deletion ${isoDay(due)}${admin ? "" : " (automatic rule)"}` });
  return { marked, due };
}

export async function markUnconfirmed(admin: Identity, input: unknown, locale: Locale, now = Date.now()) {
  if (!admin.isAdmin || admin.apiScope) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  requireAvailable(locale);
  const ids = idsSchema.parse((input as { userIds?: unknown })?.userIds);
  return await mark(admin, await candidates(now, ids), now);
}

// "Abbrechen" in the list: the account stays; the automatic rule leaves it alone.
export async function cancelUnconfirmed(admin: Identity, userId: string, now = Date.now()) {
  if (!admin.isAdmin || admin.apiScope) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  if (!(await run("UPDATE unconfirmed_deletions SET cancelled_at=? WHERE user_id=? AND cancelled_at IS NULL", now, userId)).changes)
    throw new HttpError(409, "Für dieses Konto ist keine Löschung vorgemerkt.");
  await run("DELETE FROM auth_tokens WHERE user_id=? AND kind=?", userId, KEEP_KIND);
  const email = (await one<{ email: string }>("SELECT email FROM users WHERE id=?", userId))?.email || "";
  await auditEntry(admin.id, "admin.cancelUnconfirmedDeletion", userId, email);
  securityEvent("admin.deletion_cancelled", { actorId: admin.id, detail: `unconfirmed account ${userId}` });
}

// The address is confirmed (lib/local-auth.ts confirmAddress and the other
// ways): a marking ends. Without one nothing happens.
export async function keepConfirmed(userId: string) {
  const row = await one<{ cancelled_at: number | null }>("SELECT cancelled_at FROM unconfirmed_deletions WHERE user_id=?", userId);
  if (!row) return false;
  if (!(await run("DELETE FROM unconfirmed_deletions WHERE user_id=?", userId)).changes) return false;
  await run("DELETE FROM auth_tokens WHERE user_id=? AND kind=?", userId, KEEP_KIND);
  if (row.cancelled_at !== null) return false;
  await auditEntry(userId, "user.unconfirmedConfirmed", userId, "");
  securityEvent("account.deletion_averted", { actorId: userId, detail: "address confirmed" });
  return true;
}

// The notice after signing in: the day, while the marking stands.
export async function pendingDeletionOf(userId: string, now = Date.now()) {
  const [c] = await candidates(now, [userId]);
  return c && active(c) ? { due: c.due! } : null;
}

// "Bestätigungslink erneut senden" in that notice: one every five minutes.
export async function resendKeepLink(user: Identity, locale: Locale, now = Date.now()) {
  const t = translate(locale);
  if (user.apiScope || user.demo) throw new HttpError(403, t("Nur in der angemeldeten App.", "Only in the signed-in app."));
  if (!mailConfig()) throw new HttpError(409, t("Diese Instanz versendet keine E-Mails.", "This instance sends no e-mail."));
  const [c] = await candidates(now, [user.id]);
  if (!c || !active(c)) throw new HttpError(409, t("Für dein Konto ist keine Löschung vorgemerkt.", "No deletion is pending for your account."));
  if (!allow(`keep-link:${user.id}`, 1, 5 * 60_000, now))
    throw new HttpError(429, t("Der Link ist gerade erst verschickt worden – schau in dein Postfach. Einen neuen gibt es in fünf Minuten.", "The link was sent just now – check your inbox. You can get a new one in five minutes."));
  await warningMail(c, c.due!, now, false);
  return { email: c.email, due: c.due! };
}

// One round of the job: the automatic rule, the reminders and the
// deletions that are due.
export async function runUnconfirmedDeletions(now = Date.now()) {
  const done = { marked: [] as string[], reminded: [] as string[], deleted: [] as string[], ended: [] as string[] };
  // Nobody is reminded or deleted without e-mail: the markings wait.
  if (!unconfirmedDeletionAvailable()) return done;
  // Markings of accounts that no longer count (confirmed, linked to SSO,
  // made an admin, deleted another way) end.
  const list = await candidates(now);
  const counting = new Set(list.map((c) => c.id));
  const admins = new Set(await adminUserIds());
  for (const row of await all<{ user_id: string }>("SELECT user_id FROM unconfirmed_deletions WHERE cancelled_at IS NULL"))
    if (!counting.has(row.user_id) || admins.has(row.user_id)) {
      if (!counting.has(row.user_id)) {
        if (await keepConfirmed(row.user_id)) done.ended.push(row.user_id);
      } else if ((await run("UPDATE unconfirmed_deletions SET cancelled_at=? WHERE user_id=? AND cancelled_at IS NULL", now, row.user_id)).changes) {
        await run("DELETE FROM auth_tokens WHERE user_id=? AND kind=?", row.user_id, KEEP_KIND);
        done.ended.push(row.user_id);
      }
    }
  const days = (await instanceSettings()).unconfirmedAutoDays;
  if (days) {
    // Never marked before (a cancelled marking stays cancelled).
    const due = list.filter((c) => c.due === null && Number.isFinite(c.created) && c.created <= now - days * DAY);
    done.marked = (await mark(null, due, now)).marked;
  }
  for (const c of list) {
    if (!active(c) || admins.has(c.id) || c.admin) continue;
    if (now >= c.due!) {
      const gone = await transaction(async () => {
        // Once: of two rounds at the same moment, only the one that removes the row.
        if (!(await run("DELETE FROM unconfirmed_deletions WHERE user_id=? AND cancelled_at IS NULL AND due_at<=?", c.id, now)).changes) return false;
        // Still unconfirmed in this transaction?
        if (!(await one("SELECT 1 FROM local_accounts WHERE user_id=? AND email_verified=0", c.id))) return false;
        await fireBeforeDeletion(c.id, now);
        const plan = await deleteInactiveAccount(c.id);
        await auditEntry(null, "user.unconfirmedDeleted", c.id, `${plan.name} · ${c.email}`);
        return true;
      });
      if (gone) {
        securityEvent("account.deleted", { actorId: null, detail: `${c.id} (unconfirmed e-mail address)` });
        done.deleted.push(c.id);
      }
      continue;
    }
    if (c.reminder === null && now >= c.due! - UNCONFIRMED_REMINDER_DAYS * DAY) {
      if (!(await run("UPDATE unconfirmed_deletions SET reminder_at=? WHERE user_id=? AND reminder_at IS NULL AND cancelled_at IS NULL", now, c.id)).changes) continue;
      await warningMail(c, c.due!, now, true);
      done.reminded.push(c.id);
    }
  }
  return done;
}

const runtime = globalThis as unknown as { flowplanUnconfirmedTimer?: ReturnType<typeof setInterval> };
// Hourly (FLOWPLAN_UNCONFIRMED_CHECK_MS for the browser specs), on the
// leader only.
export function startUnconfirmedWorker() {
  if (runtime.flowplanUnconfirmedTimer) return;
  const every = Math.max(1000, Number(process.env.FLOWPLAN_UNCONFIRMED_CHECK_MS) || 3600_000);
  runtime.flowplanUnconfirmedTimer = setInterval(
    () =>
      leaderDuty("unconfirmed-accounts", async () => {
        if (await workersPaused()) return;
        try {
          await runUnconfirmedDeletions();
        } catch (error) {
          console.error("Prüfung unbestätigter Konten fehlgeschlagen", error);
        }
      }),
    every,
  );
  runtime.flowplanUnconfirmedTimer.unref?.();
}
