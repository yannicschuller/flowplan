// Sign-in through a trusted reverse proxy (YunoHost's SSOwat, Authelia,
// Authentik forward auth) – the account and the session. The settings, the
// peer address and the header checks are in lib/proxy-auth-config.ts.
//
// proxy.ts asks proxySignInStep() for every page and every API request
// without a body. A request without a Flowplan session whose trusted proxy
// names a person signs that person in: a normal session (cookie) with
// sessions.proxy_user set, and the request goes on signed in – the first
// page load and /api/bootstrap alike. A proxy session whose proxy names
// someone else or nobody ends (signed out or switched at the portal; also
// checked for requests with a body, lib/auth.ts). Sessions from passwords,
// passkeys, OIDC or the apps are left alone.
//
// The account is a directory account like an LDAP one:
// 1. its proxy identity (user_identities, issuer "proxy-auth", the user
//    name in lowercase);
// 2. else the LDAP account or the SCIM-provisioned account with that user
//    name;
// 3. else an account the proxy's e-mail address matches – only when that
//    account is itself a directory or SSO account with a confirmed address;
//    an account with e-mail and password is never taken over (the sign-in
//    is refused, as for LDAP);
// 4. else a new account (AUTH_PROXY_AUTO_CREATE, default on).
// Disabled accounts are refused. The proxy vouches for the person and the
// address (second factor included, as with SSO).
import { audit, id, one, run, transaction } from "./db";
import { db } from "./db-driver";
import { HttpError, acceptInvites, adminGroup, cookieName, createSession, hash, sessionCookie } from "./auth";
import { identityOwner, touchIdentity } from "./identities";
import { ldapGroups } from "./ldap-auth";
import { syncSsoMemberships } from "./sso-mappings";
import type { User } from "./types";
import {
  proxyAuthConfig,
  proxyDebug,
  readProxyIdentity,
  requestPeer,
  trustedPeer,
  wideTrustedProxies,
  type ProxyAuthConfig,
  type ProxyIdentity,
} from "./proxy-auth-config";

export const PROXY_ISSUER = "proxy-auth";

// Directory and SSO accounts (no e-mail and password of their own) with
// this confirmed address – the only ones an address may link to.
async function directoryAccountByEmail(email: string) {
  const rows = await db.all<{ id: string }>(
    `SELECT u.id FROM users u WHERE lower(u.email)=lower(?) AND u.email<>'' AND u.email_verified=1 AND u.demo_until IS NULL
       AND u.subject NOT LIKE 'deleted:%' AND u.subject<>'local-development'
       AND NOT EXISTS(SELECT 1 FROM local_accounts a WHERE a.user_id=u.id)
       AND (EXISTS(SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id) OR EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=u.id) OR EXISTS(SELECT 1 FROM scim_users s WHERE s.user_id=u.id))`,
    email,
  );
  return rows.length === 1 ? rows[0].id : null;
}

// The account for the person the proxy names; throws HttpError when the
// sign-in is refused (disabled, a password account with that address, no
// new accounts).
export async function proxyAccount(person: ProxyIdentity, config: ProxyAuthConfig): Promise<string> {
  const userId = await transaction(async () => {
    let userId = await identityOwner(PROXY_ISSUER, person.username);
    if (!userId) {
      userId =
        (await one<{ user_id: string }>("SELECT user_id FROM ldap_accounts WHERE lower(username)=lower(?) AND username<>''", person.username))?.user_id ||
        (await one<{ user_id: string }>("SELECT user_id FROM scim_users WHERE lower(user_name)=lower(?)", person.username))?.user_id ||
        null;
      if (!userId && person.email) {
        if (await one("SELECT 1 FROM local_accounts WHERE lower(email)=lower(?)", person.email))
          throw new HttpError(409, "There is an account with a password for this e-mail address; sign-in through the proxy does not take it over.");
        userId = await directoryAccountByEmail(person.email);
      }
      if (!userId) {
        if (!config.autoCreate) throw new HttpError(403, "There is no Flowplan account for this user yet (AUTH_PROXY_AUTO_CREATE=false).");
        userId = id();
        const subject = (await one("SELECT 1 FROM users WHERE subject=?", `proxy:${person.username}`)) ? `user:${userId}` : `proxy:${person.username}`;
        await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", userId, subject, person.name, person.email);
        await audit("", "proxy.account.create", userId, person.username);
      }
      const now = Date.now();
      await run(
        "INSERT INTO user_identities(id,user_id,provider,issuer,subject,email,created_at,last_used_at) VALUES(?,?,'proxy',?,?,?,?,?) ON CONFLICT DO NOTHING",
        id(),
        userId,
        PROXY_ISSUER,
        person.username,
        person.email,
        now,
        now,
      );
    }
    return userId;
  });
  const user = await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId);
  if (!user) throw new HttpError(403, "This account no longer exists.");
  if (user.disabled) throw new HttpError(403, "This account is disabled.");
  // Name and address come from the proxy (accounts with e-mail and password
  // are never linked here, see above); the proxy vouches for the address.
  if (person.email)
    await run("UPDATE users SET name=?,email=?,email_verified=1 WHERE id=?", person.name, person.email, userId);
  else await run("UPDATE users SET name=? WHERE id=?", person.name, userId);
  await touchIdentity(PROXY_ISSUER, person.username, person.email);
  return userId;
}

// The groups of the session: from AUTH_PROXY_GROUPS_HEADER, an LDAP
// account's own groups, and the admin group for AUTH_PROXY_ADMIN_USERS.
export async function proxyGroups(userId: string, person: ProxyIdentity, config: ProxyAuthConfig) {
  const groups = new Set([...(person.groups || []), ...(await ldapGroups(userId))]);
  if (config.adminUsers.includes(person.username)) groups.add(adminGroup());
  return [...groups];
}

export type ProxyStep =
  // Nothing to do: the request goes on as it came.
  | { kind: "none" }
  // Signed in: the new session's cookie, for the response and the request.
  | { kind: "signin"; token: string; maxAge: number }
  // The proxy session of the cookie ended, nobody is signed in now.
  | { kind: "end" };

const NONE: ProxyStep = { kind: "none" };

// The session cookie in a Cookie header.
export function sessionCookieValue(cookieHeader: string | null) {
  for (const part of (cookieHeader || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== cookieName) continue;
    try {
      return decodeURIComponent(value.join("=")) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// A Cookie header with the session cookie replaced (token) or removed (null).
export function withSessionCookie(cookieHeader: string | null, token: string | null) {
  const others = (cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=")[0] !== cookieName);
  return [...others, ...(token ? [`${cookieName}=${token}`] : [])].join("; ");
}

// How proxy.ts applies a step: to the request that goes on (its Cookie
// header, so the page and the route handlers see the new session) and to
// the answer (Set-Cookie). null: nothing to change.
type CookieJar = { set: (name: string, value: string, options: ReturnType<typeof sessionCookie>) => unknown; delete: (name: string) => unknown };
export function proxyStepCookies(step: ProxyStep) {
  if (step.kind === "none") return null;
  return {
    request(headers: Headers) {
      const cookie = withSessionCookie(headers.get("cookie"), step.kind === "signin" ? step.token : null);
      if (cookie) headers.set("cookie", cookie);
      else headers.delete("cookie");
    },
    response(response: { cookies: CookieJar }) {
      if (step.kind === "signin") response.cookies.set(cookieName, step.token, sessionCookie(step.maxAge));
      else response.cookies.delete(cookieName);
    },
  };
}

// What proxy.ts does with a request: sign in, end the proxy session, or
// nothing.
export async function proxySignInStep(headers: Headers, now = Date.now()): Promise<ProxyStep> {
  const config = proxyAuthConfig();
  if (!config) return NONE;
  const cookieToken = sessionCookieValue(headers.get("cookie"));
  // Scripts and apps with a token never get a cookie.
  if (headers.get("authorization")) return NONE;
  const session = cookieToken
    ? await db.one<{ token: string; user_id: string; groups_json: string; proxy_user: string | null }>(
        "SELECT s.token,s.user_id,s.groups_json,s.proxy_user FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
        hash(cookieToken),
        now,
      )
    : null;
  // Signed in another way: the headers do not matter.
  if (session && !session.proxy_user) return NONE;
  const peer = requestPeer(headers);
  if (peer === null) return NONE;
  const person = trustedPeer(peer, config) ? readProxyIdentity(headers, config) : null;
  if (session) {
    if (person && person.username === session.proxy_user) {
      // Groups from the proxy that changed since: the session follows.
      if (person.groups) {
        const groups = await proxyGroups(session.user_id, person, config);
        if (JSON.stringify(groups) !== session.groups_json) {
          await run("UPDATE sessions SET groups_json=? WHERE token=?", JSON.stringify(groups), session.token);
          await syncSsoMemberships(session.user_id, groups);
        }
      }
      return NONE;
    }
    await run("DELETE FROM sessions WHERE token=?", session.token);
    proxyDebug(config, person ? `session of ${session.proxy_user} ended, the proxy names ${person.username}` : `session of ${session.proxy_user} ended, the proxy names nobody`);
  }
  if (!person) {
    if (!session && headers.get(config.userHeader) && !trustedPeer(peer, config))
      proxyDebug(config, "a user header came from a peer that is not in AUTH_PROXY_TRUSTED_PROXIES and was ignored");
    return session ? { kind: "end" } : NONE;
  }
  let userId: string;
  try {
    userId = await proxyAccount(person, config);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    proxyDebug(config, `${person.username} not signed in: ${e.message}`);
    return session ? { kind: "end" } : NONE;
  }
  const groups = await proxyGroups(userId, person, config);
  // Workspaces and groups mapped to the proxy's groups (only when it sends
  // groups: otherwise memberships from the mappings stay as they are).
  if (person.groups) await syncSsoMemberships(userId, groups);
  const user = await one<User & { email_verified: number }>("SELECT * FROM users WHERE id=?", userId);
  if (user) await acceptInvites(user, !!user.email_verified);
  const { token, maxAge } = await createSession(userId, groups, undefined, { sso: true, proxyUser: person.username }, headers, cookieToken);
  proxyDebug(config, `${person.username} signed in`);
  return { kind: "signin", token, maxAge };
}

// Administration → Anmeldung & SSO: the settings, read-only.
export async function proxyAuthStatus() {
  const config = proxyAuthConfig();
  return {
    enabled: !!config && config.trustedProxies.length > 0,
    userHeader: config?.userHeader || "",
    emailHeader: config?.emailHeader || "",
    nameHeader: config?.nameHeader || "",
    groupsHeader: config?.groupsHeader || "",
    trustedProxies: config?.trustedProxies || [],
    // Trusted proxies beyond this machine (warned about).
    wideProxies: config ? wideTrustedProxies(config) : [],
    loginUrl: config?.loginUrl || "",
    logoutUrl: config?.logoutUrl || "",
    autoCreate: config?.autoCreate ?? true,
    only: !!config?.only,
    name: config?.name || "SSO",
    adminUsers: config?.adminUsers.length || 0,
    accounts: Number((await one<{ n: number }>("SELECT COUNT(*) n FROM user_identities WHERE issuer=?", PROXY_ISSUER))?.n || 0),
  };
}
export type ProxyAuthStatus = Awaited<ReturnType<typeof proxyAuthStatus>>;
