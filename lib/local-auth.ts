// Sign-in without an identity provider: accounts with e-mail and password,
// and passkeys (WebAuthn) for those accounts. OpenID Connect stays
// available next to it; FLOWPLAN_LOCAL_LOGIN=false leaves only OIDC.
//
// - The first account of an instance becomes its administrator.
// - Further accounts: when the administrators allow sign-ups, or for an
//   address with a pending invitation (the invitation is accepted once the
//   address is confirmed by e-mail).
// - Passwords are hashed with scrypt; failed attempts are limited per
//   address and per e-mail.
import { promisify } from "node:util";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { all, id, one, run } from "./db";
import { HttpError, acceptInvites, adminGroup, appUrl, hash } from "./auth";
import { instanceSettings } from "./instance-settings";
import { mailConfig, queueLinkMail } from "./mail";
import type { User } from "./types";
import type { Locale } from "./i18n";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, length: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD = 10;

export function localLoginEnabled() {
  return process.env.FLOWPLAN_LOCAL_LOGIN !== "false";
}

// ---- Passwords ----

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [kind, n, r, p, salt, key] = stored.split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const passwordSchema = (t: Tr) =>
  z
    .string()
    .min(MIN_PASSWORD, t(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`, `The password needs at least ${MIN_PASSWORD} characters.`))
    .max(200, t("Das Passwort ist zu lang.", "The password is too long."));
type Tr = (de: string, en: string) => string;
const tr = (locale: Locale): Tr => (de, en) => (locale === "de" ? de : en);

// ---- Accounts ----

type Account = { user_id: string; email: string; password_hash: string; is_admin: number; email_verified: number };
const accountOf = (userId: string) => one<Account>("SELECT * FROM local_accounts WHERE user_id=?", userId);
const accountByEmail = (email: string) =>
  one<Account & { disabled: number }>(
    "SELECT a.*,u.disabled FROM local_accounts a JOIN users u ON u.id=a.user_id WHERE a.email=? COLLATE NOCASE",
    email.trim(),
  );

// No real account yet: the next one sets the instance up.
export function firstAccount() {
  return !one("SELECT 1 FROM users WHERE demo_until IS NULL AND subject<>'local-development' LIMIT 1");
}
function invited(email: string) {
  return !!one("SELECT 1 FROM invites WHERE lower(email)=lower(?)", email);
}
export function signupOpen() {
  return localLoginEnabled() && (firstAccount() || instanceSettings().allowSignup);
}
// The groups a local account signs in with (administrators).
export function localGroups(userId: string) {
  return accountOf(userId)?.is_admin ? [adminGroup()] : [];
}
export function isLocalAccount(userId: string) {
  return !!accountOf(userId);
}

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string(),
});
export async function register(input: unknown, locale: Locale) {
  const t = tr(locale);
  if (!localLoginEnabled()) throw new HttpError(403, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, t("Bitte Name und eine gültige E-Mail-Adresse angeben.", "Please enter a name and a valid e-mail address."));
  const { name, email } = parsed.data;
  const password = passwordSchema(t).safeParse(parsed.data.password);
  if (!password.success) throw new HttpError(400, password.error.issues[0].message);
  const first = firstAccount();
  if (!first && !instanceSettings().allowSignup && !invited(email))
    throw new HttpError(403, t("Neue Konten legen hier nur Admins an – oder du wirst eingeladen.", "Only administrators create new accounts here – or you get invited."));
  if (accountByEmail(email) || one("SELECT 1 FROM users WHERE lower(email)=lower(?) AND subject LIKE 'local:%'", email))
    throw new HttpError(409, t("Für diese E-Mail-Adresse gibt es schon ein Konto.", "There already is an account for this e-mail address."));
  const passwordHash = await hashPassword(password.data);
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `local:${uid}`, name, email);
  run(
    "INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,created_at) VALUES(?,?,?,?,?,?)",
    uid,
    email,
    passwordHash,
    first ? 1 : 0,
    0,
    Date.now(),
  );
  const user = one<User>("SELECT * FROM users WHERE id=?", uid)!;
  sendVerification(user, locale);
  return { user, groups: first ? [adminGroup()] : [] };
}

// ---- Failed attempts ----

const WINDOW = 15 * 60_000;
function limited(keys: string[]) {
  const since = Date.now() - WINDOW;
  run("DELETE FROM login_failures WHERE at<?", since);
  return keys.some((key) => {
    const limit = key.startsWith("ip:") ? 30 : 8;
    return Number(one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=? AND at>=?", key, since)?.n || 0) >= limit;
  });
}
function failed(keys: string[]) {
  for (const key of keys) run("INSERT INTO login_failures(key,at) VALUES(?,?)", key, Date.now());
}

export async function passwordLogin(input: unknown, address: string, locale: Locale) {
  const t = tr(locale);
  if (!localLoginEnabled()) throw new HttpError(403, t("Anmeldung mit Passwort ist ausgeschaltet.", "Password sign-in is turned off."));
  const { email, password } = z
    .object({ email: z.string().trim().max(200), password: z.string().max(200) })
    .parse(input);
  const keys = [`ip:${address}`, `email:${email.toLowerCase()}`];
  if (limited(keys)) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  const account = accountByEmail(email);
  // The same work and the same answer whether the account exists or not.
  const ok = await verifyPassword(password, account?.password_hash || "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA");
  if (!account || !ok) {
    failed(keys);
    throw new HttpError(401, t("E-Mail-Adresse oder Passwort stimmt nicht.", "E-mail address or password is wrong."));
  }
  if (account.disabled) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
  run("DELETE FROM login_failures WHERE key=?", keys[1]);
  return { userId: account.user_id, groups: account.is_admin ? [adminGroup()] : [] };
}

export async function changePassword(userId: string, input: unknown, locale: Locale) {
  const t = tr(locale);
  const account = accountOf(userId);
  if (!account) throw new HttpError(400, t("Dieses Konto meldet sich über SSO an.", "This account signs in with SSO."));
  const { current, next } = z.object({ current: z.string().max(200), next: z.string() }).parse(input);
  if (!(await verifyPassword(current, account.password_hash)))
    throw new HttpError(401, t("Das bisherige Passwort stimmt nicht.", "The current password is wrong."));
  const password = passwordSchema(t).safeParse(next);
  if (!password.success) throw new HttpError(400, password.error.issues[0].message);
  run("UPDATE local_accounts SET password_hash=? WHERE user_id=?", await hashPassword(password.data), userId);
}

// Name of a local account (SSO accounts take it from the provider).
export function updateLocalProfile(userId: string, input: unknown, locale: Locale) {
  const t = tr(locale);
  if (!accountOf(userId)) throw new HttpError(400, t("Dein Name kommt von deinem Anmeldeanbieter.", "Your name comes from your sign-in provider."));
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, t("Bitte einen Namen angeben.", "Please enter a name."));
  run("UPDATE users SET name=? WHERE id=?", parsed.data.name, userId);
}

// ---- Links by e-mail: confirm the address, reset the password ----

const TOKEN_HOURS = { verify: 72, reset: 2 } as const;
function issueToken(userId: string, kind: keyof typeof TOKEN_HOURS) {
  const token = randomBytes(32).toString("base64url");
  run("DELETE FROM auth_tokens WHERE (user_id=? AND kind=?) OR expires<?", userId, kind, Date.now());
  run("INSERT INTO auth_tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", hash(token), userId, kind, Date.now() + TOKEN_HOURS[kind] * 3600_000);
  return token;
}
function takeToken(token: string, kind: keyof typeof TOKEN_HOURS) {
  const row = one<{ user_id: string; expires: number }>("SELECT user_id,expires FROM auth_tokens WHERE id=? AND kind=?", hash(token), kind);
  if (!row || row.expires < Date.now()) return null;
  run("DELETE FROM auth_tokens WHERE id=?", hash(token));
  return row.user_id;
}
function sendVerification(user: User, locale: Locale) {
  if (!mailConfig()) return false;
  const t = tr(locale);
  const url = `${appUrl().replace(/\/$/, "")}/api/auth/verify?token=${issueToken(user.id, "verify")}`;
  return queueLinkMail({
    to: user.email,
    subject: t("E-Mail-Adresse bestätigen", "Confirm your e-mail address"),
    title: t("Bitte bestätige deine E-Mail-Adresse", "Please confirm your e-mail address"),
    lines: [
      t(`Hallo ${user.name}, mit diesem Link bestätigst du deine Adresse für Flowplan.`, `Hello ${user.name}, this link confirms your address for Flowplan.`),
      t("Danach erscheinen auch Arbeitsbereiche, zu denen du eingeladen wurdest.", "Afterwards, workspaces you were invited to appear as well."),
    ],
    label: t("Adresse bestätigen", "Confirm address"),
    url,
  });
}
export function verifyEmail(token: string) {
  const userId = takeToken(token, "verify");
  if (!userId) return false;
  run("UPDATE local_accounts SET email_verified=1 WHERE user_id=?", userId);
  const user = one<User>("SELECT * FROM users WHERE id=?", userId);
  if (user) acceptInvites(user, true);
  return true;
}
// Always the same answer, so it does not tell which addresses have accounts.
export function requestPasswordReset(input: unknown, locale: Locale) {
  const t = tr(locale);
  const { email } = z.object({ email: z.string().trim().max(200) }).parse(input);
  if (!mailConfig()) throw new HttpError(400, t("Diese Instanz versendet keine E-Mails. Bitte wende dich an die Administration.", "This instance does not send e-mails. Please contact the administrators."));
  const account = accountByEmail(email);
  if (account && !account.disabled) {
    const url = `${appUrl().replace(/\/$/, "")}/reset?token=${issueToken(account.user_id, "reset")}`;
    queueLinkMail({
      to: account.email,
      subject: t("Passwort zurücksetzen", "Reset your password"),
      title: t("Neues Passwort festlegen", "Set a new password"),
      lines: [
        t("Mit diesem Link legst du ein neues Passwort für Flowplan fest. Er gilt zwei Stunden.", "This link lets you set a new password for Flowplan. It is valid for two hours."),
        t("Hast du das nicht angefordert, kannst du diese E-Mail ignorieren.", "If you did not ask for this, you can ignore this e-mail."),
      ],
      label: t("Passwort festlegen", "Set password"),
      url,
    });
  }
}
// A reset link an administrator hands over (instances without e-mail).
export function adminResetLink(userId: string) {
  if (!accountOf(userId)) throw new HttpError(400, "Dieses Konto meldet sich über SSO an.");
  return `${appUrl().replace(/\/$/, "")}/reset?token=${issueToken(userId, "reset")}`;
}
export async function resetPassword(input: unknown, locale: Locale) {
  const t = tr(locale);
  const { token, password } = z.object({ token: z.string().max(200), password: z.string() }).parse(input);
  const valid = passwordSchema(t).safeParse(password);
  if (!valid.success) throw new HttpError(400, valid.error.issues[0].message);
  const userId = takeToken(token, "reset");
  if (!userId) throw new HttpError(400, t("Der Link ist abgelaufen. Bitte fordere einen neuen an.", "The link has expired. Please ask for a new one."));
  run("UPDATE local_accounts SET password_hash=? WHERE user_id=?", await hashPassword(valid.data), userId);
  // Whoever knew the old password is signed out everywhere.
  run("DELETE FROM sessions WHERE user_id=?", userId);
  return userId;
}

// ---- Administration ----

export function setLocalAdmin(userId: string, admin: boolean) {
  if (!accountOf(userId)) throw new HttpError(400, "Dieses Konto meldet sich über SSO an; Admin ist, wer in der Admin-Gruppe ist.");
  if (!admin && Number(one<{ n: number }>("SELECT COUNT(*) n FROM local_accounts WHERE is_admin=1 AND user_id<>?", userId)?.n || 0) === 0 && !process.env.OIDC_ISSUER)
    throw new HttpError(409, "Es muss mindestens eine Person die Instanz verwalten.");
  run("UPDATE local_accounts SET is_admin=? WHERE user_id=?", admin ? 1 : 0, userId);
  // The admin right lives in the session: sign in again.
  run("DELETE FROM sessions WHERE user_id=?", userId);
}
export function localAccountInfo() {
  return Object.fromEntries(
    all<{ user_id: string; is_admin: number; email_verified: number; passkeys: number }>(
      "SELECT a.user_id,a.is_admin,a.email_verified,(SELECT COUNT(*) FROM passkeys p WHERE p.user_id=a.user_id) passkeys FROM local_accounts a",
    ).map((a) => [a.user_id, { admin: !!a.is_admin, verified: !!a.email_verified, passkeys: Number(a.passkeys) }]),
  );
}

// ---- Passkeys ----

const rp = () => {
  const url = new URL(appUrl());
  return { id: url.hostname, origin: url.origin };
};
function storeChallenge(challenge: string, kind: "register" | "login", userId: string | null) {
  const token = randomBytes(32).toString("base64url");
  run("DELETE FROM auth_challenges WHERE expires<?", Date.now());
  run("INSERT INTO auth_challenges(id,challenge,user_id,kind,expires) VALUES(?,?,?,?,?)", hash(token), challenge, userId, kind, Date.now() + 5 * 60_000);
  return token;
}
function takeChallenge(token: string | undefined, kind: "register" | "login") {
  if (!token) return null;
  const row = one<{ challenge: string; user_id: string | null; expires: number }>(
    "SELECT challenge,user_id,expires FROM auth_challenges WHERE id=? AND kind=?",
    hash(token),
    kind,
  );
  run("DELETE FROM auth_challenges WHERE id=?", hash(token));
  return row && row.expires >= Date.now() ? row : null;
}
export function listPasskeys(userId: string) {
  return all<{ id: string; name: string; created_at: number; last_used_at: number | null }>(
    "SELECT id,name,created_at,last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at",
    userId,
  );
}
export async function passkeyRegistrationOptions(user: User, locale: Locale) {
  const t = tr(locale);
  if (!accountOf(user.id)) throw new HttpError(400, t("Passkeys gibt es für Konten mit E-Mail und Passwort; SSO-Konten melden sich beim Anbieter an.", "Passkeys are for accounts with e-mail and password; SSO accounts sign in with their provider."));
  const options = await generateRegistrationOptions({
    rpName: instanceSettings().name || "Flowplan",
    rpID: rp().id,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: listPasskeys(user.id).map((p) => ({ id: p.id })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return { options, token: storeChallenge(options.challenge, "register", user.id) };
}
export async function finishPasskeyRegistration(user: User, token: string | undefined, input: unknown, locale: Locale) {
  const t = tr(locale);
  const { response, name } = z.object({ response: z.unknown(), name: z.string().trim().max(60).optional() }).parse(input);
  const challenge = takeChallenge(token, "register");
  if (!challenge || challenge.user_id !== user.id) throw new HttpError(400, t("Die Anfrage ist abgelaufen. Bitte erneut versuchen.", "The request has expired. Please try again."));
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().id,
    requireUserVerification: false,
  }).catch(() => ({ verified: false, registrationInfo: undefined }));
  if (!verified || !registrationInfo) throw new HttpError(400, t("Der Passkey konnte nicht geprüft werden.", "The passkey could not be verified."));
  const credential = registrationInfo.credential;
  run(
    "INSERT OR REPLACE INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)",
    credential.id,
    user.id,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports || []),
    name || t("Passkey", "Passkey"),
    Date.now(),
  );
  return credential.id;
}
export function deletePasskey(userId: string, passkeyId: string) {
  run("DELETE FROM passkeys WHERE id=? AND user_id=?", passkeyId, userId);
}
export async function passkeyLoginOptions() {
  if (!localLoginEnabled()) throw new HttpError(403, "Passkeys sind ausgeschaltet.");
  const options = await generateAuthenticationOptions({ rpID: rp().id, userVerification: "preferred" });
  return { options, token: storeChallenge(options.challenge, "login", null) };
}
export async function passkeyLogin(token: string | undefined, input: unknown, address: string, locale: Locale) {
  const t = tr(locale);
  const keys = [`ip:${address}`];
  if (limited(keys)) throw new HttpError(429, t("Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.", "Too many attempts. Please try again in 15 minutes."));
  const response = z.object({ id: z.string().max(1000) }).passthrough().parse(input) as unknown as AuthenticationResponseJSON;
  const challenge = takeChallenge(token, "login");
  const passkey = one<{ id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string }>(
    "SELECT * FROM passkeys WHERE id=?",
    response.id,
  );
  const fail = () => {
    failed(keys);
    return new HttpError(401, t("Dieser Passkey ist hier nicht bekannt.", "This passkey is not known here."));
  };
  if (!challenge) throw new HttpError(400, t("Die Anfrage ist abgelaufen. Bitte erneut versuchen.", "The request has expired. Please try again."));
  if (!passkey) throw fail();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().id,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: passkey.counter,
      transports: JSON.parse(passkey.transports),
    },
    requireUserVerification: false,
  }).catch(() => null);
  if (!result?.verified) throw fail();
  const account = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", passkey.user_id);
  if (!account || account.disabled) throw new HttpError(403, t("Dieses Konto ist deaktiviert.", "This account is disabled."));
  run("UPDATE passkeys SET counter=?,last_used_at=? WHERE id=?", result.authenticationInfo.newCounter, Date.now(), passkey.id);
  return { userId: passkey.user_id, groups: localGroups(passkey.user_id) };
}

// What the sign-in page offers on this instance.
export function loginOptions() {
  return {
    configured: !!process.env.OIDC_ISSUER,
    localLogin: localLoginEnabled(),
    signupOpen: signupOpen(),
    firstAccount: localLoginEnabled() && firstAccount(),
    mail: !!mailConfig(),
    demo: process.env.NODE_ENV !== "production",
  };
}
export type LoginOptions = ReturnType<typeof loginOptions>;
