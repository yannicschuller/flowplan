// Changing the e-mail address of an account with e-mail and password (#405).
//
// - Self-service (Settings → Konto & Sicherheit → Profil), confirmed once
//   more like the other sensitive steps (lib/step-up.ts) before it gets
//   here. Flowplan sends a one-time link to the NEW address, valid for 24
//   hours; the address changes only when it is opened. The OLD address gets
//   a notice with a link that cancels the pending change.
// - Without e-mail (no SMTP) the address cannot be confirmed: then only an
//   administrator changes it (Administration → Benutzer), recorded in the
//   activity log.
// - The new address must not belong to another account, nor be what
//   another account waits to change to. The answer to the person does not
//   tell whether an address has an account: as at sign-up, the address's
//   owner gets a note instead of a link (the profile shows the change as
//   pending all the same; it can never be confirmed). Requests are limited like "Passwort
//   vergessen" (per client address, and one link every few minutes).
// - Sessions stay. The change shows in the security events (Sicherheitscheck)
//   and in the activity log.
// - What follows the address: invitations to the new one are taken over
//   (it is confirmed by the link), allowed senders of e-mail inboxes in the
//   person's workspaces move from the old address to the new one, links to
//   the old address (password reset, confirmation) stop working.
//   Notification e-mails always go to the account's current address.
// - Accounts from SSO, LDAP or SCIM keep the address their provider sends;
//   a connected SSO identity of a local account keeps its own address.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { all, one, run } from "./db";
import { db } from "./db-driver";
import { HttpError, acceptInvites, appUrl, hash } from "./auth";
import { mailConfig, queueLinkMail } from "./mail";
import { allow } from "./action-limits";
import { securityEvent } from "./security-events";
import { auditAsync } from "./audit";
import { translate, type Locale } from "./i18n";
import { userLocale } from "./user-locale";
import type { User } from "./types";

export const EMAIL_CHANGE_HOURS = 24;
const LINK_MS = EMAIL_CHANGE_HOURS * 3600_000;
// One link per account every five minutes; per client address as for a
// password reset (lib/local-auth.ts requestPasswordReset).
export const EMAIL_CHANGE_LIMITS = { account: { max: 1, windowMs: 5 * 60_000 }, address: { max: 20, windowMs: 3_600_000 } } as const;
// Registration's own check of an address (lib/local-auth.ts register).
const emailSchema = z.string().trim().toLowerCase().email().max(200);
// Registrations and changes of an address take turns, so two of them never
// end with one address on two accounts (the same lock as register()).
const ADDRESS_LOCK = "flowplan:first-account";

export type PendingEmailChange = { email: string; expires: number };
const base = () => appUrl().replace(/\/$/, "");
const tooMany = (locale: Locale) => translate(locale)("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes.");

// The change this account waits for (null without one).
export async function pendingEmailChange(userId: string, now = Date.now()): Promise<PendingEmailChange | null> {
  const row = await one<{ email: string; expires: number }>("SELECT email,expires FROM auth_tokens WHERE user_id=? AND kind='email-change' AND expires>=?", userId, now);
  return row ? { email: row.email, expires: Number(row.expires) } : null;
}
// What the profile shows: whether the address can be changed here, and how.
export async function emailChangeStatus(userId: string) {
  const account = await localAddress(userId);
  return {
    // An account with e-mail and password, not from SCIM.
    available: !!account && !(await scimManaged(userId)),
    // Only with e-mail: else the administration changes it.
    mail: !!mailConfig(),
    pending: account ? await pendingEmailChange(userId) : null,
  };
}

async function localAddress(userId: string) {
  return (await one<{ email: string }>("SELECT a.email FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.demo_until IS NULL", userId))?.email ?? null;
}
const scimManaged = async (userId: string) => !!(await one("SELECT 1 FROM scim_users WHERE user_id=?", userId));
async function changeable(userId: string, locale: Locale) {
  const t = translate(locale);
  const email = await localAddress(userId);
  if (!email) throw new HttpError(400, t("Die E-Mail-Adresse dieses Kontos kommt vom Anmeldeanbieter und lässt sich nur dort ändern.", "This account's e-mail address comes from its sign-in provider and can only be changed there."));
  if (await scimManaged(userId))
    throw new HttpError(400, t("Die E-Mail-Adresse dieses Kontos kommt aus der Benutzerverwaltung (SCIM) und lässt sich nur dort ändern.", "This account's e-mail address comes from the user directory (SCIM) and can only be changed there."));
  return email;
}
function parseAddress(input: unknown, current: string, locale: Locale) {
  const t = translate(locale);
  const parsed = emailSchema.safeParse(input && typeof input === "object" ? (input as { email?: unknown }).email : undefined);
  if (!parsed.success) throw new HttpError(400, t("Bitte eine gültige E-Mail-Adresse angeben.", "Please enter a valid e-mail address."));
  if (parsed.data === current.toLowerCase()) throw new HttpError(400, t("Das ist schon die Adresse dieses Kontos.", "That already is this account's address."));
  return parsed.data;
}
// Another account has the address (any way of signing in), or waits for a
// change to it.
export async function addressTaken(email: string, userId: string, now = Date.now()) {
  return (
    !!(await one("SELECT 1 FROM local_accounts WHERE lower(email)=lower(?) AND user_id<>?", email, userId)) ||
    !!(await one("SELECT 1 FROM users WHERE lower(email)=lower(?) AND id<>? AND email<>'' AND subject NOT LIKE 'deleted:%'", email, userId)) ||
    !!(await one("SELECT 1 FROM auth_tokens WHERE kind='email-change' AND lower(email)=lower(?) AND user_id<>? AND expires>=?", email, userId, now))
  );
}

// "E-Mail ändern …": the links go out; returns the pending change. The
// route has confirmed the step (password, passkey or code) before.
export async function requestEmailChange(userId: string, input: unknown, locale: Locale, address = "", now = Date.now()): Promise<PendingEmailChange> {
  const t = translate(locale);
  if (!mailConfig())
    throw new HttpError(400, t("Diese Instanz versendet keine E-Mails. Deine Adresse ändert die Administration für dich.", "This instance does not send e-mails. The administrators change your address for you."));
  if (address && !allow(`email-change-ip:${address}`, EMAIL_CHANGE_LIMITS.address.max, EMAIL_CHANGE_LIMITS.address.windowMs, now)) throw new HttpError(429, tooMany(locale));
  const current = await changeable(userId, locale);
  const email = parseAddress(input, current, locale);
  if (!allow(`email-change:${userId}`, EMAIL_CHANGE_LIMITS.account.max, EMAIL_CHANGE_LIMITS.account.windowMs, now))
    throw new HttpError(429, t("Gerade ist schon ein Link unterwegs. Bitte warte ein paar Minuten.", "A link is on its way already. Please wait a few minutes."));
  const user = (await one<User>("SELECT * FROM users WHERE id=?", userId))!;
  const pending = { email, expires: now + LINK_MS };
  const taken = await addressTaken(email, userId, now);
  const confirm = randomBytes(32).toString("base64url"),
    cancel = randomBytes(32).toString("base64url");
  // Stored also for an address that is taken, so that the profile shows the
  // same either way; its link never goes out (and could change nothing).
  await db.tx(async () => {
    // A new request replaces the one before (its links stop working).
    await run("DELETE FROM auth_tokens WHERE (user_id=? AND kind IN ('email-change','email-cancel')) OR expires<?", userId, now);
    await run("INSERT INTO auth_tokens(id,user_id,kind,expires,email) VALUES(?,?,'email-change',?,?)", hash(confirm), userId, pending.expires, email);
    await run("INSERT INTO auth_tokens(id,user_id,kind,expires,email) VALUES(?,?,'email-cancel',?,?)", hash(cancel), userId, pending.expires, email);
  });
  if (taken)
    // The address's owner learns why nothing changes.
    await queueLinkMail({
      to: email,
      subject: t("Diese Adresse hat schon ein Konto", "This address already has an account"),
      title: t("Diese Adresse hat schon ein Konto", "This address already has an account"),
      lines: [
        t(
          `${user.name} wollte die E-Mail-Adresse eines Flowplan-Kontos auf diese Adresse ändern. Sie gehört schon zu einem anderen Konto – deshalb ändert sich nichts.`,
          `${user.name} tried to change the e-mail address of a Flowplan account to this address. It already belongs to another account – so nothing changes.`,
        ),
        t("Sollen die beiden Konten eins werden, kann die Administration sie zusammenführen. Warst du das nicht, kannst du diese E-Mail ignorieren.", "If the two accounts should become one, the administrators can merge them. If this wasn't you, you can ignore this e-mail."),
      ],
      label: t("Anmelden", "Sign in"),
      url: `${base()}/login`,
    });
  else
    await queueLinkMail({
      to: email,
      subject: t("Neue E-Mail-Adresse bestätigen", "Confirm your new e-mail address"),
      title: t("Bitte bestätige deine neue E-Mail-Adresse", "Please confirm your new e-mail address"),
      lines: [
        t(
          `Hallo ${user.name}, mit diesem Link wird ${email} die neue Adresse deines Flowplan-Kontos. Du meldest dich danach mit ihr an. Der Link gilt 24 Stunden und nur einmal.`,
          `Hello ${user.name}, this link makes ${email} the new address of your Flowplan account. You then sign in with it. The link is valid for 24 hours and works once.`,
        ),
        t("Hast du das nicht angefordert, kannst du diese E-Mail ignorieren – dann ändert sich nichts.", "If you did not ask for this, you can ignore this e-mail – then nothing changes."),
      ],
      label: t("Adresse bestätigen", "Confirm address"),
      url: `${base()}/email-change?token=${confirm}`,
    });
  // The notice in the old address's own language.
  const tr = translate(await userLocale(userId));
  await queueLinkMail({
    to: current,
    subject: tr("Deine E-Mail-Adresse wird geändert", "Your e-mail address is being changed"),
    title: tr("Deine E-Mail-Adresse wird geändert", "Your e-mail address is being changed"),
    lines: [
      tr(
        `Für dein Flowplan-Konto wurde eine neue E-Mail-Adresse angegeben: ${email}. Sobald sie bestätigt ist, meldest du dich mit ihr an; an diese Adresse kommen dann keine E-Mails von Flowplan mehr.`,
        `A new e-mail address was entered for your Flowplan account: ${email}. Once it is confirmed, you sign in with it; this address then gets no more e-mails from Flowplan.`,
      ),
      tr(
        "Warst du das nicht? Dann brich die Änderung mit diesem Link ab und ändere dein Passwort.",
        "Wasn't you? Then cancel the change with this link and change your password.",
      ),
    ],
    label: tr("Änderung abbrechen", "Cancel the change"),
    url: `${base()}/email-change?token=${cancel}&cancel=1`,
  });
  securityEvent("account.email_change_requested", { actorId: userId });
  return pending;
}

// The link to the new address: the change is made. Returns the new address.
export async function confirmEmailChange(token: unknown, locale: Locale, now = Date.now()) {
  const t = translate(locale);
  const expired = new HttpError(400, t("Der Link ist abgelaufen oder wurde schon benutzt.", "The link has expired or was used already."));
  if (typeof token !== "string" || !token || token.length > 200) throw expired;
  const row = await one<{ user_id: string; email: string; expires: number }>("SELECT user_id,email,expires FROM auth_tokens WHERE id=? AND kind='email-change'", hash(token));
  if (!row || Number(row.expires) < now) throw expired;
  // Once: of two requests at the same moment, only the one that deletes it.
  if (!(await run("DELETE FROM auth_tokens WHERE id=? AND kind='email-change'", hash(token))).changes) throw expired;
  await applyEmailChange(row.user_id, row.email, row.user_id, locale);
  return { userId: row.user_id, email: row.email };
}

// The link to the old address: the pending change is cancelled.
export async function cancelEmailChangeByLink(token: unknown, now = Date.now()) {
  if (typeof token !== "string" || !token || token.length > 200) return false;
  const row = await one<{ user_id: string; expires: number }>("SELECT user_id,expires FROM auth_tokens WHERE id=? AND kind='email-cancel'", hash(token));
  if (!row || Number(row.expires) < now) return false;
  await cancelEmailChange(row.user_id);
  return true;
}
// "Abbrechen" in the profile, or the link above.
export async function cancelEmailChange(userId: string) {
  const removed = (await run("DELETE FROM auth_tokens WHERE user_id=? AND kind IN ('email-change','email-cancel')", userId)).changes;
  if (removed) securityEvent("account.email_change_cancelled", { actorId: userId });
  return removed > 0;
}

// Administration → Benutzer → "E-Mail ändern …": on instances without
// e-mail, where nobody could confirm a link. The administrator vouches for
// the address (as with "Als bestätigt markieren").
export async function adminChangeEmail(admin: { id: string }, userId: string, input: unknown, locale: Locale) {
  const t = translate(locale);
  if (mailConfig())
    throw new HttpError(409, t("Diese Instanz versendet E-Mails: Die Person ändert ihre Adresse selbst und bestätigt sie per Link.", "This instance sends e-mails: the person changes their address themselves and confirms it by link."));
  const current = await changeable(userId, locale);
  const email = parseAddress(input, current, locale);
  if (await addressTaken(email, userId)) throw new HttpError(409, t("Diese E-Mail-Adresse gehört schon zu einem anderen Konto.", "This e-mail address already belongs to another account."));
  await applyEmailChange(userId, email, admin.id, locale);
  securityEvent("admin.user", { actorId: admin.id, detail: `e-mail changed ${userId}` });
  return { email };
}

// The change itself, for both ways.
async function applyEmailChange(userId: string, email: string, actorId: string, locale: Locale) {
  const t = translate(locale);
  const previous = await db.tx(
    async () => {
      const old = await localAddress(userId);
      if (!old) throw new HttpError(400, t("Dieses Konto meldet sich über SSO an.", "This account signs in with SSO."));
      if (await addressTaken(email, userId))
        throw new HttpError(409, t("Diese E-Mail-Adresse gehört inzwischen zu einem anderen Konto.", "This e-mail address belongs to another account by now."));
      // Opened from the new address (or set by an administrator): confirmed.
      await run("UPDATE local_accounts SET email=?,email_verified=1 WHERE user_id=?", email, userId);
      await run("UPDATE users SET email=?,email_verified=1 WHERE id=?", email, userId);
      // Links sent to the old address stop working: whoever reads that
      // mailbox no longer resets the password.
      await run("DELETE FROM auth_tokens WHERE user_id=? AND kind IN ('email-change','email-cancel','reset','verify','welcome')", userId);
      // E-mail inboxes of the person's workspaces that let the old address
      // in let the new one in instead.
      const oldLower = old.toLowerCase();
      for (const inbox of await all<{ id: string; senders: string }>(
        "SELECT i.id,i.senders FROM inbound_addresses i JOIN members m ON m.workspace_id=i.workspace_id WHERE m.user_id=?",
        userId,
      )) {
        const senders = JSON.parse(inbox.senders) as string[];
        if (!senders.includes(oldLower)) continue;
        await run("UPDATE inbound_addresses SET senders=? WHERE id=?", JSON.stringify([...new Set(senders.map((s) => (s === oldLower ? email : s)))]), inbox.id);
      }
      await auditAsync(actorId, actorId === userId ? "account.email" : "admin.changeEmail", userId, `${old} → ${email}`);
      return old;
    },
    { lock: ADDRESS_LOCK },
  );
  securityEvent("account.email_changed", { actorId: userId, detail: actorId === userId ? "" : "by an administrator" });
  // Invitations waiting for the new address, as at sign-in.
  const user = await one<User>("SELECT * FROM users WHERE id=?", userId);
  if (user) await acceptInvites(user, true);
  return previous;
}
