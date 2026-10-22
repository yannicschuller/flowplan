// Two-factor sign-in with an authenticator app (TOTP) for accounts with
// e-mail and password, and for LDAP accounts (lib/ldap-auth.ts), whose
// directory password counts like a password here.
//
// - Setting up: a new secret (sealed with lib/secret-box.ts, bound to the
//   account) is shown as QR code and as text; a code from the app confirms
//   it. Then ten recovery codes, shown once and stored as hashes.
// - Signing in: after the right password, an account with the app on gets a
//   short-lived signed token (not a session) and enters a code from the app
//   or a recovery code. Codes count once (the last accepted time step is
//   kept), wrong ones are limited per account and per address.
// - Passkeys count as strong on their own: no code after a passkey, unless
//   the person turns that on. SSO accounts and API tokens are not affected. The policy lives in lib/two-factor-policy.ts.
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { one, run } from "./db";
import { HttpError, appUrl } from "./auth";
import { addressKey } from "./client-address";
import { failed, limited, localGroups, verifyPassword } from "./local-auth";
import { ldapGroups, verifyLdapPassword } from "./ldap-auth";
import { openSecret, sealSecret, signValue, validSignature } from "./secret-box";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp";
import { qrModules, qrPath } from "./qr";
import { codeAfterPasskey, hasPasskey, totpEnabled, twoFactorRequired } from "./two-factor-policy";
import { instanceSettings } from "./instance-settings";
import { queueLinkMail } from "./mail";
import { translate, type Locale } from "./i18n";
import type { User } from "./types";

const aad = (userId: string) => `totp:${userId}`;
const RECOVERY_CODES = 10;
const PENDING_SECONDS = 300;
type Tr = (de: string, en: string) => string;
const tr = (locale: Locale): Tr => translate(locale);

// Accounts with a password: e-mail and password, or an LDAP account (its
// DN stands in for the password hash in the pending sign-in token).
function account(userId: string) {
  return (
    one<{ email: string; password_hash: string; ldap?: number }>("SELECT email,password_hash FROM local_accounts WHERE user_id=?", userId) ||
    one<{ email: string; password_hash: string; ldap?: number }>(
      "SELECT u.email,'ldap:'||l.dn password_hash,1 ldap FROM ldap_accounts l JOIN users u ON u.id=l.user_id WHERE l.user_id=?",
      userId,
    )
  );
}
// The groups a sign-in after the second step carries.
const signInGroups = (userId: string) => (account(userId)?.ldap ? ldapGroups(userId) : localGroups(userId));
async function passwordMatches(userId: string, password: string, local: { password_hash: string; ldap?: number }) {
  return local.ldap ? verifyLdapPassword(userId, password) : verifyPassword(password, local.password_hash);
}
function requireLocal(userId: string, t: Tr) {
  const local = account(userId);
  if (!local)
    throw new HttpError(400, t("Zwei-Faktor-Anmeldung gibt es für Konten mit E-Mail und Passwort; SSO-Konten regelt der Anbieter.", "Two-factor sign-in is for accounts with e-mail and password; for SSO accounts the provider handles it."));
  return local;
}
// The secret of the app. Without the key it was sealed with (e.g. a backup
// restored without secrets.key), recovery codes still work and the
// administration can reset the app.
function openTotp(userId: string, sealed: string) {
  try {
    return openSecret(sealed, aad(userId));
  } catch (error) {
    console.error("TOTP secret cannot be opened", (error as Error).message);
    throw new HttpError(500, "Der Schlüssel für die Zwei-Faktor-Anmeldung fehlt auf dem Server. Ein Wiederherstellungscode funktioniert weiter; sonst kann die Administration sie zurücksetzen.");
  }
}
function storedTotp(userId: string) {
  return one<{ secret: string; enabled: number; last_step: number }>("SELECT secret,enabled,last_step FROM user_totp WHERE user_id=?", userId);
}

// ---- Status and setup ----

export function twoFactorStatus(userId: string) {
  return {
    enabled: totpEnabled(userId),
    recoveryLeft: Number(one<{ n: number }>("SELECT COUNT(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL", userId)?.n || 0),
    passkey: hasPasskey(userId),
    afterPasskey: codeAfterPasskey(userId),
    required: twoFactorRequired(userId),
  };
}
export type TwoFactorStatus = ReturnType<typeof twoFactorStatus>;

// A new secret waiting for its first code; an earlier unconfirmed one is replaced.
export function startTotpSetup(user: Pick<User, "id">, locale: Locale) {
  const t = tr(locale);
  const local = requireLocal(user.id, t);
  if (totpEnabled(user.id)) throw new HttpError(409, t("Die Zwei-Faktor-Anmeldung ist schon eingerichtet.", "Two-factor sign-in is already set up."));
  const secret = newTotpSecret();
  run(
    "INSERT INTO user_totp(user_id,secret,enabled,last_step,created_at) VALUES(?,?,0,0,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,enabled=0,last_step=0,created_at=excluded.created_at,enabled_at=NULL",
    user.id,
    sealSecret(secret, aad(user.id)),
    Date.now(),
  );
  return { secret, ...setupQr(secret, local.email, instanceSettings().name || "Flowplan") };
}

// The link for the app as a QR code. A long instance name is shortened until
// the link fits; if even then it doesn't (a very long address), the app is
// set up with the key shown as text.
function setupQr(secret: string, email: string, issuer: string) {
  for (const name of [issuer, issuer.slice(0, 24).trim(), "Flowplan"]) {
    const uri = otpauthUri(secret, email, name);
    try {
      const modules = qrModules(uri);
      return { uri, qr: { size: modules.length, path: qrPath(modules) } as { size: number; path: string } | null };
    } catch {}
  }
  return { uri: otpauthUri(secret, email, "Flowplan"), qr: null };
}

// The first code from the app turns it on and hands out the recovery codes.
export function confirmTotpSetup(userId: string, input: unknown, locale: Locale, now = Date.now()) {
  const t = tr(locale);
  requireLocal(userId, t);
  const { code } = z.object({ code: z.string().max(20) }).parse(input);
  const stored = storedTotp(userId);
  if (!stored || stored.enabled) throw new HttpError(400, t("Bitte die Einrichtung neu beginnen.", "Please start the setup again."));
  const step = matchTotp(openTotp(userId, stored.secret), code, now);
  if (step === null) throw new HttpError(400, t("Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.", "The code is wrong. Please enter the current code from the app."));
  run("UPDATE user_totp SET enabled=1,last_step=?,enabled_at=? WHERE user_id=?", step, now, userId);
  return { recoveryCodes: newRecoveryCodes(userId) };
}

// ---- Recovery codes ----

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
const recoveryHash = (userId: string, code: string) => createHash("sha256").update(`flowplan-recovery\0${userId}\0${normalizeRecovery(code)}`).digest("hex");
function newRecoveryCodes(userId: string) {
  run("DELETE FROM recovery_codes WHERE user_id=?", userId);
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODES) {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    if (codes.includes(code)) continue;
    codes.push(code);
    run("INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)", userId, recoveryHash(userId, code));
  }
  return codes;
}

// ---- Checking a second factor ----

// A code from the app (six digits) or a recovery code. Each counts once.
export function useSecondFactor(userId: string, code: string, now = Date.now()) {
  const stored = storedTotp(userId);
  if (!stored?.enabled) return false;
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const step = matchTotp(openTotp(userId, stored.secret), digits, now, stored.last_step);
    // Taken only if no one else took this step in the meantime.
    return step !== null && run("UPDATE user_totp SET last_step=? WHERE user_id=? AND last_step<?", step, userId, step).changes === 1;
  }
  if (normalizeRecovery(code).length !== 10) return false;
  return run("UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL", now, userId, recoveryHash(userId, code)).changes === 1;
}
// With the limits for failed attempts (per account and per address).
function checkSecondFactor(userId: string, code: string, address: string, t: Tr, now = Date.now()) {
  const keys = [...addressKey("ip", address), `totp:${userId}`];
  if (limited(keys)) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  if (!useSecondFactor(userId, code, now)) {
    failed(keys);
    throw new HttpError(401, t("Der Code stimmt nicht oder wurde schon benutzt.", "The code is wrong or was used already."));
  }
}
// Confirms a change with the current password or a code from the app.
async function confirmWithPasswordOrCode(userId: string, input: unknown, address: string, t: Tr) {
  const { password, code } = z.object({ password: z.string().max(200).optional(), code: z.string().max(20).optional() }).parse(input);
  const local = requireLocal(userId, t);
  if (code) return checkSecondFactor(userId, code, address, t);
  const keys = [...addressKey("ip", address), `totp:${userId}`];
  if (limited(keys)) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  if (!password || !(await passwordMatches(userId, password, local))) {
    failed(keys);
    throw new HttpError(401, t("Bitte das aktuelle Passwort oder einen Code aus der App eingeben.", "Please enter the current password or a code from the app."));
  }
}

export async function disableTotp(userId: string, input: unknown, address: string, locale: Locale) {
  const t = tr(locale);
  if (!totpEnabled(userId)) return twoFactorStatus(userId);
  if (twoFactorRequired(userId) && !hasPasskey(userId))
    throw new HttpError(409, t("Auf dieser Instanz ist die Zwei-Faktor-Anmeldung vorgeschrieben. Lege zuerst einen Passkey an.", "Two-factor sign-in is required on this instance. Add a passkey first."));
  await confirmWithPasswordOrCode(userId, input, address, t);
  removeTotp(userId);
  return twoFactorStatus(userId);
}
export async function regenerateRecoveryCodes(userId: string, input: unknown, address: string, locale: Locale) {
  const t = tr(locale);
  if (!totpEnabled(userId)) throw new HttpError(400, t("Die Zwei-Faktor-Anmeldung ist nicht eingeschaltet.", "Two-factor sign-in is not turned on."));
  await confirmWithPasswordOrCode(userId, input, address, t);
  return { recoveryCodes: newRecoveryCodes(userId) };
}
// Whether signing in with a passkey also asks for a code from the app.
export async function setCodeAfterPasskey(userId: string, input: unknown, address: string, locale: Locale) {
  const t = tr(locale);
  if (!totpEnabled(userId)) throw new HttpError(400, t("Die Zwei-Faktor-Anmeldung ist nicht eingeschaltet.", "Two-factor sign-in is not turned on."));
  const { enabled } = z.object({ enabled: z.boolean() }).passthrough().parse(input);
  // Turning the extra check off weakens the account: confirm it.
  if (!enabled) await confirmWithPasswordOrCode(userId, input, address, t);
  run("UPDATE user_totp SET after_passkey=? WHERE user_id=?", enabled ? 1 : 0, userId);
  return twoFactorStatus(userId);
}
function removeTotp(userId: string) {
  run("DELETE FROM user_totp WHERE user_id=?", userId);
  run("DELETE FROM recovery_codes WHERE user_id=?", userId);
}

// ---- Signing in ----

// After the right password: who signs in right away, and who first needs a
// code. An account that must use two factors and has only a passkey signs in
// with the passkey; one without any factor signs in and sets one up first.
export function afterPassword(userId: string, remember: boolean, locale: Locale): { pending: string } | { userId: string } {
  if (totpEnabled(userId)) return { pending: pendingToken(userId, remember) };
  if (twoFactorRequired(userId) && hasPasskey(userId))
    throw new HttpError(403, tr(locale)("Für dein Konto ist eine Zwei-Faktor-Anmeldung vorgeschrieben – bitte melde dich mit deinem Passkey an.", "Your account requires two-factor sign-in – please sign in with your passkey."));
  return { userId };
}
// After a passkey: signed in, or a code first if the person asked for one.
export function afterPasskey(userId: string, remember: boolean): { pending: string } | { userId: string } {
  if (codeAfterPasskey(userId) && account(userId)) return { pending: pendingToken(userId, remember) };
  return { userId };
}
// "<user>.<expires>.<remember>.<password fingerprint>.<signature>": signed by
// the server, valid five minutes, void once the password changes.
const fingerprint = (hash: string) => createHash("sha256").update(hash).digest("base64url").slice(0, 16);
export function pendingToken(userId: string, remember: boolean, now = Date.now()) {
  const local = account(userId);
  if (!local) throw new HttpError(400, "Dieses Konto meldet sich über SSO an.");
  const data = [userId, now + PENDING_SECONDS * 1000, remember ? 1 : 0, fingerprint(local.password_hash)].join(".");
  return `${data}.${signValue("pending-login", data)}`;
}
export const PENDING_MAX_AGE = PENDING_SECONDS;
function readPending(token: string | undefined, now = Date.now()) {
  const parts = (token || "").split(".");
  if (parts.length !== 5) return null;
  const [userId, expires, remember, print, signature] = parts;
  const data = parts.slice(0, 4).join(".");
  if (!validSignature("pending-login", data, signature) || Number(expires) < now) return null;
  const local = account(userId);
  if (!local || fingerprint(local.password_hash) !== print) return null;
  return { userId, remember: remember === "1" };
}
// The second step: the pending token and a code.
export function completeSignIn(token: string | undefined, input: unknown, address: string, locale: Locale, now = Date.now()) {
  const t = tr(locale);
  const pending = readPending(token, now);
  if (!pending) throw new HttpError(400, t("Die Anmeldung ist abgelaufen. Bitte erneut mit Passwort anmelden.", "The sign-in has expired. Please sign in with your password again."));
  const { code } = z.object({ code: z.string().max(40) }).parse(input);
  const user = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", pending.userId);
  if (!user || user.disabled) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
  checkSecondFactor(pending.userId, code, address, t, now);
  run("DELETE FROM login_failures WHERE key=?", `totp:${pending.userId}`);
  return { userId: pending.userId, groups: signInGroups(pending.userId), remember: pending.remember };
}

// ---- Administration ----

// Lost phone: an administrator turns the app off for the account. Noted in
// the activity log (by the command) and told to the person by e-mail.
export function adminResetTwoFactor(userId: string) {
  const user = one<User>("SELECT * FROM users WHERE id=?", userId);
  if (!user || !account(userId)) throw new HttpError(400, "Dieses Konto meldet sich über SSO an.");
  removeTotp(userId);
  const locale = (one<{ locale: string | null }>("SELECT locale FROM users WHERE id=?", userId)?.locale || "de") as Locale;
  const t = tr(locale);
  queueLinkMail({
    to: account(userId)!.email,
    subject: t("Zwei-Faktor-Anmeldung zurückgesetzt", "Two-factor sign-in was reset"),
    title: t("Deine Zwei-Faktor-Anmeldung wurde zurückgesetzt", "Your two-factor sign-in was reset"),
    lines: [
      t(
        `Hallo ${user.name}, eine Person aus der Administration hat die Anmeldung mit Authenticator-App für dein Konto ausgeschaltet.`,
        `Hello ${user.name}, an administrator turned off sign-in with an authenticator app for your account.`,
      ),
      t(
        "Richte sie nach der nächsten Anmeldung unter Einstellungen → Konto & Sicherheit wieder ein. Warst du das nicht, wende dich bitte an die Administration.",
        "Set it up again after your next sign-in under Settings → Account & security. If you did not ask for this, please contact the administrators.",
      ),
    ],
    label: t("Anmelden", "Sign in"),
    url: `${appUrl().replace(/\/$/, "")}/login`,
  });
}
