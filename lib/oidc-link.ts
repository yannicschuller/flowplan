// Which account an OpenID Connect sign-in belongs to, and the first SSO
// sign-in that waits to be connected to an existing account (#101). The
// route (app/api/auth/[action]/route.ts) speaks OIDC and sets cookies; the
// decisions are here.
//
// 1. An account provisioned over SCIM is claimed (lib/scim.ts).
// 2. A known identity: its account (disabled ones are refused).
// 3. An unknown identity whose address the provider verified
//    (email_verified === true) and which matches exactly one account that
//    can prove itself (lib/identities.ts linkCandidate): nothing is created
//    yet – the sign-in waits up to ten minutes (oidc_pending_links, a cookie
//    holds its token) for the person to confirm that account with its
//    password (plus code if the app is on) or its passkey.
// 4. Otherwise a new SSO account – unless OIDC_NEW_ACCOUNTS=false.
import { randomBytes } from "node:crypto";
import { audit, id, one, run, transaction } from "./db";
import { HttpError, hash, identityFromToken } from "./auth";
import { securityEvent } from "./security-events";
import { claimProvisionedAccount } from "./scim";
import { attachIdentity, identityOwner, linkCandidate, ssoNewAccounts, subjectKey, touchIdentity } from "./identities";
import { z } from "zod";
import { isLocalAccount, passkeyLogin, passwordLogin } from "./local-auth";
import { ldapPasswordLogin } from "./ldap-auth";
import { afterPasskey, afterPassword, completeSignIn } from "./two-factor";
import { translate, type Locale } from "./i18n";

export type OidcProfile = {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: unknown;
  groups: string[];
};
export const PENDING_LINK_SECONDS = 600;

const disabledError = (locale: Locale) => new HttpError(403, translate(locale)("Dieses Konto ist deaktiviert.", "This account is disabled."));

// The account of a known identity (SCIM claim included), or null.
export async function knownAccount(p: OidcProfile, locale: Locale) {
  await claimProvisionedAccount(subjectKey(p.issuer, p.subject), p.subject, p.email, p.emailVerified);
  const userId = await identityOwner(p.issuer, p.subject);
  if (!userId) return null;
  const user = await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId);
  if (!user) return null;
  if (user.disabled) throw disabledError(locale);
  // SSO accounts take name and address from the provider; an account with
  // e-mail and password keeps its own (it was linked, #101).
  if (!(await isLocalAccount(userId))) await run("UPDATE users SET name=?,email=? WHERE id=?", p.name, p.email, userId);
  await touchIdentity(p.issuer, p.subject, p.email);
  return userId;
}

export type OidcResolution = { kind: "account"; userId: string; created: boolean } | { kind: "link"; candidateId: string };
export async function resolveOidcSignIn(p: OidcProfile, locale: Locale): Promise<OidcResolution> {
  const known = await knownAccount(p, locale);
  if (known) return { kind: "account", userId: known, created: false };
  const candidate = p.emailVerified === true ? (await linkCandidate(p.email)) : null;
  if (candidate) return { kind: "link", candidateId: candidate };
  return { kind: "account", userId: await createSsoAccount(p, locale), created: true };
}

export async function createSsoAccount(p: OidcProfile, locale: Locale) {
  if (!ssoNewAccounts())
    throw new HttpError(
      403,
      translate(locale)(
        "Für dieses SSO-Konto gibt es hier noch kein Flowplan-Konto. Bitte wende dich an die Administration.",
        "There is no Flowplan account for this SSO identity yet. Please contact the administrators.",
      ),
    );
  return await transaction(async () => {
    const uid = id();
    const subject = (await one("SELECT 1 FROM users WHERE subject=?", subjectKey(p.issuer, p.subject))) ? `user:${uid}` : subjectKey(p.issuer, p.subject);
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, subject, p.name, p.email);
    await attachIdentity(uid, p.issuer, p.subject, p.email, locale);
    return uid;
  });
}

// ---- A first SSO sign-in waiting to be connected ----

type PendingRow = {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  picture: string | null;
  groups_json: string;
  remember: number;
  return_to: string | null;
  second_factor: string | null;
  expires: number;
};
export async function startPendingLink(candidateId: string, p: OidcProfile, options: { remember: boolean; returnTo: string }, now = Date.now()) {
  const token = randomBytes(32).toString("base64url");
  await run("DELETE FROM oidc_pending_links WHERE expires<?", now);
  await run(
    "INSERT INTO oidc_pending_links(id,user_id,issuer,subject,email,name,picture,groups_json,remember,return_to,expires,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    hash(token),
    candidateId,
    p.issuer,
    p.subject,
    p.email,
    p.name,
    typeof p.picture === "string" ? p.picture.slice(0, 2000) : null,
    JSON.stringify(p.groups),
    options.remember ? 1 : 0,
    options.returnTo,
    now + PENDING_LINK_SECONDS * 1000,
    now,
  );
  return token;
}
async function pendingRow(token: string | undefined, now = Date.now()) {
  if (!token) return null;
  const row = await one<PendingRow>("SELECT * FROM oidc_pending_links WHERE id=?", hash(token));
  return row && row.expires >= now ? row : null;
}
export async function requirePending(token: string | undefined, locale: Locale) {
  const row = await pendingRow(token);
  if (!row)
    throw new HttpError(400, translate(locale)("Die Anmeldung ist abgelaufen. Bitte noch einmal mit SSO anmelden.", "The sign-in has expired. Please sign in with SSO again."));
  return row;
}
const profileOf = (row: PendingRow): OidcProfile => ({
  issuer: row.issuer,
  subject: row.subject,
  email: row.email,
  emailVerified: true,
  name: row.name,
  picture: row.picture ?? undefined,
  groups: (() => {
    try {
      const parsed = JSON.parse(row.groups_json);
      return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
    } catch {
      return [];
    }
  })(),
});

// What the page shows: the address (partly hidden) and the ways to prove it.
export async function pendingLinkInfo(token: string | undefined) {
  const row = await pendingRow(token);
  if (!row) return null;
  const local = await one<{ password_hash: string; email: string }>("SELECT password_hash,email FROM local_accounts WHERE user_id=?", row.user_id);
  const ldap = await one<{ username: string }>("SELECT username FROM ldap_accounts WHERE user_id=?", row.user_id);
  return {
    email: row.email,
    password: !!local?.password_hash || !!ldap,
    ldap: !local && !!ldap,
    passkey: !!(await one("SELECT 1 FROM passkeys WHERE user_id=?", row.user_id)),
    secondFactor: !!row.second_factor,
    separate: ssoNewAccounts(),
  };
}
export type PendingLinkInfo = NonNullable<Awaited<ReturnType<typeof pendingLinkInfo>>>;

// The sign-in name the candidate's password is checked with: the address of
// an account with e-mail and password, else the LDAP name.
async function pendingIdentifier(row: PendingRow) {
  const local = await one<{ email: string; password_hash: string }>("SELECT email,password_hash FROM local_accounts WHERE user_id=?", row.user_id);
  if (local?.password_hash) return { kind: "local" as const, name: local.email };
  const ldap = await one<{ username: string; dn: string }>("SELECT username,dn FROM ldap_accounts WHERE user_id=?", row.user_id);
  if (ldap) return { kind: "ldap" as const, name: ldap.username || row.email };
  return null;
}
// The password was right, a code follows: kept with the waiting sign-in.
async function notePendingSecondFactor(row: PendingRow, pending: string) {
  await run("UPDATE oidc_pending_links SET second_factor=? WHERE id=?", pending, row.id);
}
type Proof = { userId: string } | { twoFactor: true };
// The proofs, with the limits and lockouts of the sign-in form (failures
// per address and per account, the security event log). Each returns who
// was proven, or that a code from the app follows.
export async function provePendingPassword(row: PendingRow, input: unknown, address: string, locale: Locale): Promise<Proof> {
  const t = translate(locale);
  const { password } = z.object({ password: z.string().max(200) }).parse(input);
  const who = await pendingIdentifier(row);
  if (!who) throw new HttpError(400, t("Dieses Konto hat kein Passwort – bitte mit dem Passkey bestätigen.", "This account has no password – please confirm with its passkey."));
  const { userId } = who.kind === "local" ? await passwordLogin({ email: who.name, password }, address, locale) : await ldapPasswordLogin(who.name, password, address, locale);
  if (userId !== row.user_id) return { userId };
  const next = await afterPassword(userId, false, locale);
  if ("pending" in next) {
    await notePendingSecondFactor(row, next.pending);
    return { twoFactor: true };
  }
  return { userId };
}
export async function provePendingCode(row: PendingRow, input: unknown, address: string, locale: Locale): Promise<Proof> {
  if (!row.second_factor) throw new HttpError(400, translate(locale)("Bitte zuerst das Passwort eingeben.", "Please enter the password first."));
  return { userId: (await completeSignIn(row.second_factor, input, address, locale)).userId };
}
export async function provePendingPasskey(row: PendingRow, challengeToken: string | undefined, input: unknown, address: string, locale: Locale): Promise<Proof> {
  const { userId } = await passkeyLogin(challengeToken, input, address, locale);
  if (userId !== row.user_id) return { userId };
  const next = await afterPasskey(userId, false);
  if ("pending" in next) {
    await notePendingSecondFactor(row, next.pending);
    return { twoFactor: true };
  }
  return { userId };
}

// Proven: the identity joins the account. Returns who signs in now.
export async function completePendingLink(row: PendingRow, provenUserId: string, locale: Locale) {
  if (provenUserId !== row.user_id) {
    securityEvent("account.sso_link_refused", { actorId: provenUserId, detail: "proof for another account" });
    throw new HttpError(403, translate(locale)("Das gehört zu einem anderen Konto.", "That belongs to another account."));
  }
  const user = await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", row.user_id);
  if (!user || user.disabled) throw disabledError(locale);
  await transaction(async () => {
    await attachIdentity(row.user_id, row.issuer, row.subject, row.email, locale);
    await run("DELETE FROM oidc_pending_links WHERE id=? OR (issuer=? AND subject=?)", row.id, row.issuer, row.subject);
    await audit(row.user_id, "account.sso.link", row.user_id, row.issuer);
  });
  securityEvent("account.sso_linked", { actorId: row.user_id, detail: `first sign-in ${hostOf(row.issuer)}` });
  return { userId: row.user_id, profile: profileOf(row), remember: !!row.remember, returnTo: row.return_to };
}
// "Create a separate account instead".
export async function separateFromPending(row: PendingRow, locale: Locale) {
  const profile = profileOf(row);
  const userId = await knownAccount(profile, locale) || await createSsoAccount(profile, locale);
  await run("DELETE FROM oidc_pending_links WHERE id=?", row.id);
  return { userId, profile, remember: !!row.remember, returnTo: row.return_to };
}
export async function cancelPending(token: string | undefined) {
  if (token) await run("DELETE FROM oidc_pending_links WHERE id=?", hash(token));
}

// "Connect SSO" from the account settings: the callback belongs to the flow
// only in the session that started it, and only while that session is
// still the same (enabled) account. The account, or null.
export async function linkFlowOwner(flow: { link_user_id: string | null; link_session: string | null }, sessionToken: string | undefined) {
  if (!flow.link_user_id || !flow.link_session || !sessionToken || hash(sessionToken) !== flow.link_session) return null;
  const me = await identityFromToken(sessionToken);
  return me && !me.demo && me.id === flow.link_user_id ? me.id : null;
}

// "Connect SSO" from the account settings, after its callback: the flow
// was started by this account in this session.
export async function linkFromSettings(userId: string, p: OidcProfile, locale: Locale) {
  try {
    const added = await transaction(async () => {
      const fresh = await attachIdentity(userId, p.issuer, p.subject, p.email, locale);
      if (fresh) await audit(userId, "account.sso.link", userId, p.issuer);
      return fresh;
    });
    await touchIdentity(p.issuer, p.subject, p.email);
    if (added) securityEvent("account.sso_linked", { actorId: userId, detail: hostOf(p.issuer) });
    return added;
  } catch (e) {
    securityEvent("account.sso_link_refused", { actorId: userId, detail: `identity of another account ${hostOf(p.issuer)}` });
    throw e;
  }
}

function hostOf(issuer: string) {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}
