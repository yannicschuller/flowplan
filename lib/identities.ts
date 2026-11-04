// Sign-in identities of an account (#101): the OpenID Connect identities
// (issuer + subject) it signs in with, in user_identities (schema 88).
//
// - An SSO sign-in finds its account by identity. users.subject is the
//   account's own stable key; for accounts created by an SSO sign-in it is
//   "<issuer>|<subject>" of that first identity and is kept as a fallback
//   (and backfilled into user_identities) for rows written before schema 88.
// - Settings → Account → Sign-in methods: "Connect SSO" attaches another
//   identity to the signed-in account (refused when it already belongs to
//   another account – an administrator merges those), "Disconnect" removes
//   one while another way to sign in remains (a password, LDAP or another
//   identity), and the password can be removed once SSO is connected.
// - The first SSO sign-in of an unknown identity whose verified address
//   matches exactly one account with a password, LDAP or a passkey offers
//   to connect it (app/link-account): the person proves that account first.
//   Nothing is ever linked without that proof.
// - OIDC_LINKED_SSO_ONLY=true: accounts with a connected identity sign in
//   only through SSO; their password and passkeys stay for confirming
//   sensitive steps.
// LDAP accounts keep their own link (ldap_accounts, by DN): they count as a
// sign-in method here and can connect SSO like accounts with a password.
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { securityEvent } from "./security-events";
import { translate, type Locale } from "./i18n";

export type IdentityRow = { id: string; user_id: string; provider: string; issuer: string; subject: string; email: string; created_at: number; last_used_at: number | null };
export const subjectKey = (issuer: string, subject: string) => `${issuer}|${subject}`;

// OIDC_LINKED_SSO_ONLY=true: linked accounts sign in only through SSO.
export const linkedSsoOnly = () => process.env.OIDC_LINKED_SSO_ONLY === "true";
// OIDC_NEW_ACCOUNTS=false: SSO sign-ins only reach existing (linked or
// provisioned) accounts; unknown identities get no new account.
export const ssoNewAccounts = () => process.env.OIDC_NEW_ACCOUNTS !== "false";

// The account of an identity: by user_identities, else (rows from before
// schema 88, or a subject set by SCIM) by users.subject – then the identity
// is recorded so the next lookup finds it directly.
export function identityOwner(issuer: string, subject: string): string | null {
  const row = one<{ user_id: string }>("SELECT user_id FROM user_identities WHERE issuer=? AND subject=?", issuer, subject);
  if (row) return row.user_id;
  const legacy = one<{ id: string; email: string }>("SELECT id,email FROM users WHERE subject=?", subjectKey(issuer, subject));
  if (!legacy) return null;
  run(
    "INSERT OR IGNORE INTO user_identities(id,user_id,provider,issuer,subject,email,created_at) VALUES(?,?,'oidc',?,?,?,?)",
    id(),
    legacy.id,
    issuer,
    subject,
    legacy.email,
    Date.now(),
  );
  return legacy.id;
}

export function listIdentities(userId: string) {
  return all<IdentityRow>("SELECT * FROM user_identities WHERE user_id=? ORDER BY created_at", userId);
}
export const identityCount = (userId: string) => Number(one<{ n: number }>("SELECT COUNT(*) n FROM user_identities WHERE user_id=?", userId)?.n || 0);
export const hasIdentity = (userId: string) => identityCount(userId) > 0;

// Noted at every SSO sign-in with the address the provider sent.
export function touchIdentity(issuer: string, subject: string, email: string, now = Date.now()) {
  run("UPDATE user_identities SET last_used_at=?,email=? WHERE issuer=? AND subject=?", now, email, issuer, subject);
}

export class IdentityTaken extends HttpError {
  constructor(locale: Locale) {
    super(
      409,
      translate(locale)(
        "Dieses SSO-Konto gehört schon zu einem anderen Flowplan-Konto. Bitte die Administration, die beiden Konten zusammenzuführen.",
        "This SSO identity already belongs to another Flowplan account. Please ask an administrator to merge the two accounts.",
      ),
    );
  }
}

// Attaches an identity to an account; refused when another account has it.
// Returns false when the account already had it.
export function attachIdentity(userId: string, issuer: string, subject: string, email: string, locale: Locale, now = Date.now()) {
  const owner = identityOwner(issuer, subject);
  if (owner && owner !== userId) throw new IdentityTaken(locale);
  if (owner === userId) return false;
  run(
    "INSERT INTO user_identities(id,user_id,provider,issuer,subject,email,created_at,last_used_at) VALUES(?,?,'oidc',?,?,?,?,?)",
    id(),
    userId,
    issuer,
    subject,
    email,
    now,
    now,
  );
  return true;
}

// The ways an account can sign in (for the settings and the unlink rules).
export function signInMethods(userId: string) {
  const local = one<{ password_hash: string; email: string }>("SELECT password_hash,email FROM local_accounts WHERE user_id=?", userId);
  return {
    // An account with e-mail and password (also one whose password was removed).
    local: !!local,
    password: !!local?.password_hash,
    ldap: !!one("SELECT 1 FROM ldap_accounts WHERE user_id=?", userId),
    identities: identityCount(userId),
    passkeys: Number(one<{ n: number }>("SELECT COUNT(*) n FROM passkeys WHERE user_id=?", userId)?.n || 0),
    totp: !!one("SELECT 1 FROM user_totp WHERE user_id=? AND enabled=1", userId),
  };
}

// What the account settings show: the methods and the connected identities.
export function signInOverview(userId: string) {
  const methods = signInMethods(userId);
  return {
    ...methods,
    ssoConfigured: !!process.env.OIDC_ISSUER,
    ssoOnly: linkedSsoOnly() && methods.identities > 0,
    linkedSsoOnly: linkedSsoOnly(),
    list: listIdentities(userId).map((i) => ({
      id: i.id,
      issuer: i.issuer,
      // The provider's host, for a short label.
      provider: hostOf(i.issuer),
      email: i.email,
      createdAt: i.created_at,
      lastUsedAt: i.last_used_at,
    })),
  };
}
export type SignInOverview = ReturnType<typeof signInOverview>;
function hostOf(issuer: string) {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

// Whether this account may sign in with its password or a passkey now.
export function ssoOnlyAccount(userId: string) {
  return linkedSsoOnly() && hasIdentity(userId);
}
export function refuseSsoOnly(userId: string, locale: Locale) {
  if (ssoOnlyAccount(userId))
    throw new HttpError(
      403,
      translate(locale)(
        "Dieses Konto ist mit SSO verbunden und meldet sich nur über SSO an. Bitte „Mit SSO anmelden“ wählen.",
        "This account is connected to SSO and signs in through SSO only. Please choose “Sign in with SSO”.",
      ),
    );
}

// Disconnecting one identity: only while another way in remains.
export function removeIdentity(userId: string, identityId: string, locale: Locale) {
  const t = translate(locale);
  const row = one<IdentityRow>("SELECT * FROM user_identities WHERE id=? AND user_id=?", identityId, userId);
  if (!row) throw new HttpError(404, t("Diese Verbindung gibt es nicht mehr.", "This connection no longer exists."));
  const methods = signInMethods(userId);
  if (!methods.password && !methods.ldap && methods.identities <= 1)
    throw new HttpError(
      409,
      t(
        "Das ist deine einzige Art, dich anzumelden. Lege zuerst ein Passwort fest oder verbinde ein anderes SSO-Konto.",
        "This is your only way to sign in. Set a password or connect another SSO identity first.",
      ),
    );
  run("DELETE FROM user_identities WHERE id=?", row.id);
  // The account's key no longer names this identity: a later sign-in with
  // it starts fresh instead of finding this account again.
  run("UPDATE users SET subject=? WHERE id=? AND subject=?", `user:${userId}`, userId, subjectKey(row.issuer, row.subject));
  audit(userId, "account.sso.unlink", userId, row.issuer);
  securityEvent("account.sso_unlinked", { actorId: userId, detail: hostOf(row.issuer) });
  return row;
}

// "Remove password": the account then signs in through SSO only.
export function removePassword(userId: string, locale: Locale) {
  const t = translate(locale);
  const methods = signInMethods(userId);
  if (!methods.password) throw new HttpError(400, t("Dieses Konto hat kein Passwort.", "This account has no password."));
  if (!methods.identities)
    throw new HttpError(409, t("Verbinde zuerst ein SSO-Konto – sonst kannst du dich nicht mehr anmelden.", "Connect an SSO identity first – otherwise you could no longer sign in."));
  run("UPDATE local_accounts SET password_hash='' WHERE user_id=?", userId);
  run("DELETE FROM auth_tokens WHERE user_id=? AND kind='reset'", userId);
  audit(userId, "account.password.remove", userId);
  securityEvent("account.password_removed", { actorId: userId });
}

// The one account a first SSO sign-in may be connected to: its address is
// the verified one, and it can prove itself (password, LDAP or passkey).
// Several matches, a disabled account or none: no offer.
export function linkCandidate(email: string) {
  const address = email.trim();
  if (!address) return null;
  const rows = all<{ id: string; disabled: number }>(
    `SELECT DISTINCT u.id,u.disabled FROM users u
       LEFT JOIN local_accounts a ON a.user_id=u.id
       WHERE u.demo_until IS NULL AND u.subject NOT LIKE 'deleted:%' AND u.subject<>'local-development'
         AND ((a.user_id IS NOT NULL AND lower(a.email)=lower(?) AND (a.password_hash<>'' OR EXISTS(SELECT 1 FROM passkeys p WHERE p.user_id=u.id)))
           OR (EXISTS(SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id) AND u.email<>'' AND lower(u.email)=lower(?)))`,
    address,
    address,
  );
  return rows.length === 1 && !rows[0].disabled ? rows[0].id : null;
}
