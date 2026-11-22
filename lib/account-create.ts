// Administration → Benutzer → "Konto anlegen" (#433): an administrator
// creates an account with e-mail and password for someone else.
//
// - Only instance administrators, only while password sign-in is on
//   (FLOWPLAN_LOCAL_LOGIN), whether or not self sign-up is open. The same
//   checks of name and address as at sign-up; an address that already
//   belongs to an account (any way of signing in, any case) is refused.
// - The account starts without a password. The person sets one with a
//   one-time link, valid for WELCOME_DAYS: by e-mail when the instance sends
//   e-mail, otherwise shown to the administrator to hand over. Opening it
//   and setting the password signs the person in.
// - The address counts as confirmed only when the link came by e-mail (it
//   then proves the mailbox) – a link handed over proves nothing about the
//   address, so the account stays unconfirmed like any account on an
//   instance without e-mail ("Nur bestätigte Adressen", invitations).
// - Optionally a workspace of its own right away, with the starter content
//   new accounts get (lib/starter-content.ts), within the person's limits.
// - Until the first sign-in the account is listed as invited; "Link erneut
//   senden" issues a fresh link (the previous one stops working).
// - In the activity log ("admin.createAccount" with the address) and the
//   security events.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { id as newId, one, run } from "./db";
import { db } from "./db-driver";
import { HttpError, appUrl, hash } from "./auth";
import { mailConfig, queueLinkMail } from "./mail";
import { auditAsync } from "./audit";
import { securityEvent } from "./security-events";
import { addressTaken } from "./email-change";
import { confirmAddress, hashPassword, localGroups, localLoginEnabled, passwordSchema } from "./local-auth";
import { assertMayCreateWorkspace } from "./user-limits";
import { translate, type Locale } from "./i18n";
import type { Identity, User } from "./types";

export const WELCOME_DAYS = 7;
const WELCOME_MS = WELCOME_DAYS * 86_400_000;
// "welcome": the link went out by e-mail (it proves the address);
// "welcome-link": shown to the administrator to hand over.
const KINDS = ["welcome", "welcome-link"] as const;
type Kind = (typeof KINDS)[number];
// Registrations and changes of an address take turns (register(),
// lib/email-change.ts): never one address on two accounts.
const ADDRESS_LOCK = "flowplan:first-account";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(["member", "admin"]).default("member"),
  // The name of a workspace of the person's own; empty or missing: none now
  // (the first sign-in gives one as for every account without any).
  workspace: z.string().trim().max(100).optional().nullable(),
});

const base = () => appUrl().replace(/\/$/, "");
const linkOf = (token: string) => `${base()}/welcome?token=${token}`;

async function issue(userId: string, kind: Kind, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  // One link per account: a new one replaces the previous one of either kind.
  await run("DELETE FROM auth_tokens WHERE (user_id=? AND kind IN ('welcome','welcome-link')) OR expires<?", userId, now);
  await run("INSERT INTO auth_tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", hash(token), userId, kind, now + WELCOME_MS);
  return token;
}

async function sendWelcome(user: Pick<User, "id" | "name" | "email">, inviter: string, locale: Locale) {
  const t = translate(locale);
  const url = linkOf(await issue(user.id, "welcome"));
  await queueLinkMail({
    to: user.email,
    subject: t("Dein Flowplan-Konto wurde angelegt", "Your Flowplan account was created"),
    title: t("Willkommen bei Flowplan", "Welcome to Flowplan"),
    lines: [
      t(`Hallo ${user.name}, ${inviter} hat dir ein Konto bei Flowplan angelegt.`, `Hello ${user.name}, ${inviter} created a Flowplan account for you.`),
      t(
        `Mit diesem Link legst du dein Passwort fest und meldest dich an. Er gilt ${WELCOME_DAYS} Tage und nur einmal.`,
        `This link lets you set your password and sign in. It is valid for ${WELCOME_DAYS} days and only once.`,
      ),
      t("Hast du kein Konto erwartet, kannst du diese E-Mail ignorieren.", "If you did not expect an account, you can ignore this e-mail."),
    ],
    label: t("Passwort festlegen", "Set password"),
    url,
  });
}

// An account that has never signed in and has no password: created by an
// administrator and waiting for its link.
async function waiting(userId: string) {
  return !!(await one(
    "SELECT 1 FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.password_hash='' AND u.last_login_at IS NULL AND u.disabled=0 AND NOT EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=a.user_id) AND NOT EXISTS(SELECT 1 FROM passkeys p WHERE p.user_id=a.user_id)",
    userId,
  ));
}

export type CreatedAccount = { userId: string; email: string; mailed: boolean; url?: string; workspaceId?: string; expires: number };

export async function adminCreateAccount(admin: Identity, input: unknown, locale: Locale, now = Date.now()): Promise<CreatedAccount> {
  const t = translate(locale);
  if (!admin.isAdmin) throw new HttpError(403, t("Nur Admins legen Konten an.", "Only administrators create accounts."));
  if (!localLoginEnabled())
    throw new HttpError(
      409,
      t(
        "Anmeldung mit Passwort ist auf dieser Instanz ausgeschaltet (FLOWPLAN_LOCAL_LOGIN=false) – Konten kommen über SSO.",
        "Password sign-in is turned off on this instance (FLOWPLAN_LOCAL_LOGIN=false) – accounts come through SSO.",
      ),
    );
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, t("Bitte Name und eine gültige E-Mail-Adresse angeben.", "Please enter a name and a valid e-mail address."));
  const { name, email, role } = parsed.data;
  const workspace = parsed.data.workspace || "";
  const uid = await db.tx(
    async () => {
      if (await addressTaken(email, ""))
        throw new HttpError(409, t("Für diese E-Mail-Adresse gibt es schon ein Konto.", "There already is an account for this e-mail address."));
      const uid = newId();
      await db.run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, name, email);
      // No password yet, nothing to confirm before the first sign-in: the
      // link (by e-mail) confirms the address, or it stays unconfirmed.
      await db.run(
        "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,'',?,0,0,?)",
        uid,
        email,
        role === "admin" ? 1 : 0,
        now,
      );
      await auditAsync(admin.id, "admin.createAccount", uid, email);
      return uid;
    },
    { lock: ADDRESS_LOCK },
  );
  let workspaceId: string | undefined;
  if (workspace) {
    // The person's own limit of workspaces (admins have none).
    await assertMayCreateWorkspace({ id: uid, isAdmin: role === "admin" });
    const { createPersonalWorkspace } = await import("./starter-content");
    workspaceId = await createPersonalWorkspace(uid, workspace);
  }
  securityEvent("admin.account_created", { actorId: admin.id, detail: `${role === "admin" ? "admin " : ""}account ${uid}` });
  if (role === "admin") securityEvent("admin.granted", { actorId: admin.id, detail: `new local account ${uid}` });
  const mailed = !!mailConfig();
  if (mailed) {
    await sendWelcome({ id: uid, name, email }, admin.name, locale);
    return { userId: uid, email, mailed, workspaceId, expires: now + WELCOME_MS };
  }
  return { userId: uid, email, mailed, url: linkOf(await issue(uid, "welcome-link", now)), workspaceId, expires: now + WELCOME_MS };
}

// "Link erneut senden": a fresh link for an account still waiting for its
// first sign-in, by e-mail or to hand over. The previous link stops working.
export async function adminResendWelcome(admin: Identity, userId: string, locale: Locale, now = Date.now()) {
  const t = translate(locale);
  if (!admin.isAdmin) throw new HttpError(403, t("Nur Admins legen Konten an.", "Only administrators create accounts."));
  if (!localLoginEnabled()) throw new HttpError(409, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const user = await one<User>("SELECT * FROM users WHERE id=?", userId);
  if (!user || !(await waiting(userId)))
    throw new HttpError(409, t("Dieses Konto hat schon ein Passwort oder war schon angemeldet – nimm den Link zum Zurücksetzen.", "This account already has a password or has signed in – use the reset link."));
  const mailed = !!mailConfig();
  if (mailed) await sendWelcome(user, admin.name, locale);
  securityEvent("admin.user", { actorId: admin.id, detail: `account link ${userId}` });
  return { mailed, url: mailed ? undefined : linkOf(await issue(userId, "welcome-link", now)), expires: now + WELCOME_MS };
}

// The page behind the link (app/welcome): who it is for, without using it up.
export async function welcomeAccount(token: unknown, now = Date.now()) {
  if (typeof token !== "string" || !token || token.length > 200 || !localLoginEnabled()) return null;
  return (
    (await one<{ name: string; email: string }>(
      "SELECT u.name,u.email FROM auth_tokens t JOIN users u ON u.id=t.user_id JOIN local_accounts a ON a.user_id=u.id WHERE t.id=? AND t.kind IN ('welcome','welcome-link') AND t.expires>=? AND u.disabled=0 AND a.password_hash=''",
      hash(token),
      now,
    )) ?? null
  );
}

// The password from the link: set once, then the route signs the person in.
export async function acceptWelcome(input: unknown, locale: Locale, now = Date.now()) {
  const t = translate(locale);
  if (!localLoginEnabled()) throw new HttpError(403, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const parsed = z.object({ token: z.string().max(200), password: z.string() }).safeParse(input);
  const expired = new HttpError(400, t("Der Link ist abgelaufen oder wurde schon benutzt. Bitte frag nach einem neuen.", "The link has expired or was used already. Please ask for a new one."));
  if (!parsed.success) throw expired;
  // The password first: a too short one does not use the link up.
  const password = passwordSchema(t).safeParse(parsed.data.password);
  if (!password.success) throw new HttpError(400, password.error.issues[0].message);
  const id = hash(parsed.data.token);
  const row = await one<{ user_id: string; kind: Kind; expires: number }>("SELECT user_id,kind,expires FROM auth_tokens WHERE id=? AND kind IN ('welcome','welcome-link')", id);
  if (!row || Number(row.expires) < now) throw expired;
  const passwordHash = await hashPassword(password.data);
  // Once: of two requests at the same moment, only the one that deletes it.
  if (!(await run("DELETE FROM auth_tokens WHERE id=? AND kind=?", id, row.kind)).changes) throw expired;
  const account = await one<{ disabled: number; password_hash: string }>(
    "SELECT u.disabled,a.password_hash FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=?",
    row.user_id,
  );
  if (!account || account.disabled || account.password_hash) throw expired;
  await run("UPDATE local_accounts SET password_hash=? WHERE user_id=?", passwordHash, row.user_id);
  // Only a link that came by e-mail proves the address.
  if (row.kind === "welcome") await confirmAddress(row.user_id);
  securityEvent("account.password", { actorId: row.user_id, detail: "set with the account link" });
  return { userId: row.user_id, groups: await localGroups(row.user_id) };
}
