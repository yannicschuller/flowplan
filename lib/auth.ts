import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { all, one, run, id } from "./db";
import type { Identity, User } from "./types";
import { identityFromApiToken } from "./api-tokens";
import { needsTwoFactorSetup } from "./two-factor-policy";
import { recordOpsEvent } from "./ops-events";
import { blockedRequest, securityEvent } from "./security-events";
import { noteActive } from "./metrics";
import { readOnlyRefusal } from "./instance-read-only";
import { rememberPolicy, rememberedEnd, sessionTerms } from "./session-policy";
export const cookieName = "flowplan_session";
export const appUrl = () => process.env.APP_URL || "http://localhost:3000";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function adminGroup() {
  return process.env.OIDC_ADMIN_GROUP || "flowplan-admins";
}
// Who is an administrator, for the lists of the administration: the group
// of their latest sign-in (SSO, local accounts and LDAP all write it into
// the session), else the flag of a local or directory account. Accounts
// without a session since then keep the last state they signed in with.
export function adminUserIds(): string[] {
  // The group as a JSON string inside the list; % and _ in its name are
  // literal characters, not LIKE wildcards.
  const needle = `%${JSON.stringify(adminGroup()).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return all<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.disabled=0 AND (
       (SELECT s.groups_json FROM sessions s WHERE s.user_id=u.id ORDER BY COALESCE(s.created_at,0) DESC, s.expires DESC LIMIT 1) LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM local_accounts a WHERE a.user_id=u.id AND a.is_admin=1)
       OR EXISTS (SELECT 1 FROM ldap_accounts l WHERE l.user_id=u.id AND l.is_admin=1))`,
    needle,
  ).map((r) => r.id);
}
export function extractGroups(claims: Record<string, unknown>): string[] {
  const val = (process.env.OIDC_GROUPS_CLAIM || "groups")
    .split(".")
    .reduce<unknown>(
      (a, k) =>
        a && typeof a === "object"
          ? (a as Record<string, unknown>)[k]
          : undefined,
      claims,
    );
  return Array.isArray(val)
    ? val.filter((g): g is string => typeof g === "string")
    : [];
}
// How long sessions last: lib/session-policy.ts (Administration → Anmeldung
// & SSO → Sitzungen, else SESSION_* in the environment).
export { rememberPolicy, sessionHours, isAppAgent } from "./session-policy";
type SessionUse = { token: string; expires: number; created_at: number | null; remember: number; sso: number; app?: number; last_seen: number | null; demo_until?: number | null };
// A session in use: a remembered one lives on (written at most every few
// minutes; turning the option off on the instance ends the sliding), every
// other one notes when it was last used. Called for the cookie and for the
// apps' device tokens (lib/mobile-devices.ts), so widgets that refresh in the
// background keep the session of their app alive like the app itself.
export function touchSession(s: SessionUse, now = Date.now()) {
  if (s.demo_until) return;
  const policy = s.remember ? rememberPolicy(s.app ? "app" : "browser") : null;
  const stale = now - (s.last_seen || 0) > 5 * 60_000;
  if (policy && s.created_at) {
    const next = Math.min(now + policy.idleHours * 3_600_000, rememberedEnd(s.created_at, !!s.sso, policy));
    if (next - s.expires > 5 * 60_000) return run("UPDATE sessions SET expires=?,last_seen=? WHERE token=?", next, now, s.token);
  }
  if (stale) run("UPDATE sessions SET last_seen=? WHERE token=?", now, s.token);
}
export function identityFromToken(token: string): Identity | null {
  const now = Date.now();
  const s = one<User & { groups_json: string; expires: number; created_at_s: number | null; remember: number; sso: number; app: number; last_seen: number | null }>(
    "SELECT u.*,s.groups_json,s.expires,s.created_at created_at_s,s.remember,s.sso,s.app,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    hash(token),
    now,
  );
  if (!s) return null;
  const groups = JSON.parse(s.groups_json) as string[];
  touchSession({ token: hash(token), expires: s.expires, created_at: s.created_at_s, remember: s.remember, sso: s.sso, app: s.app, last_seen: s.last_seen, demo_until: s.demo_until }, now);
  // Active people per hour (lib/metrics.ts): counted in memory, never stored.
  if (!s.demo_until) noteActive(s.id, now);
  // Demo sessions live on while used: 45 minutes after the last request,
  // never beyond the end of the demo.
  if (s.demo_until) {
    const next = Math.min(Date.now() + 45 * 60_000, s.demo_until);
    if (next - s.expires > 60_000)
      run("UPDATE sessions SET expires=? WHERE token=?", next, hash(token));
  }
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    disabled: s.disabled,
    created_at: s.created_at,
    avatar: s.avatar,
    demo_until: s.demo_until ?? null,
    demo: !!s.demo_until,
    groups,
    isAdmin: !s.demo_until && groups.includes(adminGroup()),
    ...(!s.demo_until && needsTwoFactorSetup(s.id) ? { twoFactorSetup: true } : {}),
  };
}
export async function currentUser() {
  const requestHeaders = await headers();
  // Blocked addresses (Administration → Sicherheit) are signed out.
  if (blockedRequest(requestHeaders)) return null;
  // Scripts and integrations sign in with a personal API token.
  const authorization = requestHeaders.get("authorization");
  if (authorization?.startsWith("Bearer ")) return identityFromApiToken(authorization);
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  return token ? identityFromToken(token) : null;
}
// The same from a request's own headers (route handlers that also run in
// tests without a Next.js request around them): a personal API token, or
// the session cookie.
export function identityFromRequest(req: Request): Identity | null {
  if (blockedRequest(req.headers)) return null;
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return identityFromApiToken(authorization);
  return sessionIdentityFromRequest(req);
}
// Only the session cookie of a request (never an API token).
export function sessionIdentityFromRequest(req: Request): Identity | null {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== cookieName) continue;
    try {
      return identityFromToken(decodeURIComponent(value.join("=")));
    } catch {
      return null;
    }
  }
  return null;
}
// The signed-in person, unless they still have to set up the second factor
// the instance requires (then they count as not signed in).
export async function activeUser() {
  const u = await currentUser();
  return u?.twoFactorSetup ? null : u;
}
// Ends the person's other sessions (after a password change), keeping this one.
export async function endOtherSessions(userId: string) {
  const token = (await cookies()).get(cookieName)?.value;
  run("DELETE FROM sessions WHERE user_id=? AND token<>?", userId, token ? hash(token) : "");
}
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Bitte melde dich an.");
  if (u.twoFactorSetup) throw new HttpError(403, "Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.");
  return u;
}
export async function issueSession(
  userId: string,
  groups: string[],
  // Demo sessions: their own end (the cookie lasts until the demo's end).
  demo?: { expires: number; until: number },
  // "Stay signed in on this device" (only when the instance allows it),
  // whether the groups came from an SSO provider, and whether the app proved
  // this sign-in its own (lib/app-devices.ts: the hand-off or its device key).
  options: { remember?: boolean; sso?: boolean; app?: boolean; authenticatedAt?: number | null } = {},
) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  if (!demo) {
    run("UPDATE users SET last_login_at=? WHERE id=?", now, userId);
    // Counted for the sign-in chart of the monitoring (lib/admin-ops.ts).
    recordOpsEvent("login_success", now);
  }
  const requestHeaders = await headers();
  const agent = (requestHeaders.get("user-agent") || "").slice(0, 300);
  // How long it lasts (lib/session-policy.ts): the desktop and mobile apps
  // stay signed in unless the instance says otherwise – when they proved the
  // sign-in theirs; the user agent alone does not.
  const terms = demo ? null : sessionTerms({ app: !!options.app, remember: options.remember, sso: options.sso }, now);
  const expires = terms ? terms.expires : demo!.expires;
  // A security event (lib/security-events.ts): the detection compares it
  // with earlier sign-ins and failures of the same account.
  if (!demo) {
    const email = one<{ email: string }>("SELECT email FROM users WHERE id=?", userId)?.email || "";
    securityEvent("login.success", { actorId: userId, subject: email, headers: requestHeaders, detail: options.sso ? "sso" : "" });
    // Admin rights that came with this sign-in (SSO or directory group) and
    // were not there at the previous one.
    const previous = one<{ groups_json: string }>("SELECT groups_json FROM sessions WHERE user_id=? ORDER BY COALESCE(created_at,0) DESC LIMIT 1", userId);
    const admin = groups.includes(adminGroup());
    if (previous && admin !== (JSON.parse(previous.groups_json) as string[]).includes(adminGroup()))
      securityEvent(admin ? "admin.granted" : "admin.revoked", { actorId: userId, headers: requestHeaders, detail: `${options.sso ? "SSO" : "directory"} group at sign-in` });
  }
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,sso,app,last_seen,agent,authenticated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    hash(token),
    userId,
    JSON.stringify(groups),
    expires,
    now,
    terms?.remember ? 1 : 0,
    options.sso ? 1 : 0,
    terms?.app ? 1 : 0,
    now,
    agent,
    // A sign-in proves the person now; a hand-off from an older browser
    // session does not (#audit F3).
    options.authenticatedAt === undefined ? now : options.authenticatedAt,
  );
  const jar = await cookies();
  // Signing in again on the same device (the session ran out, or the app
  // signs in anew): its app installations move over to the new session.
  const previous = jar.get(cookieName)?.value;
  if (previous && !demo) carryOverSession(hash(previous), hash(token), userId);
  jar.set(cookieName, token, {
    httpOnly: true,
    secure: new URL(appUrl()).protocol === "https:",
    sameSite: "lax",
    path: "/",
    // A remembered session keeps its cookie until its latest possible end;
    // the server decides earlier whether it is still alive.
    maxAge: terms ? terms.maxAge : Math.max(60, Math.round((demo!.until - now) / 1000)),
  });
}
// The session a device signed in with before is replaced by a new one of the
// same person: the mobile app installations (device tokens for widgets,
// Live Activities and Shortcuts) and their push subscriptions are bound to
// the new session instead of dying with the old one, and the old session
// ends. A session of someone else on that device keeps its own (signing out
// or ending a session still removes them: ON DELETE CASCADE).
export function carryOverSession(previousHash: string, nextHash: string, userId: string) {
  if (previousHash === nextHash) return 0;
  if (!one("SELECT 1 FROM sessions WHERE token=? AND user_id=?", previousHash, userId)) return 0;
  const moved = run("UPDATE mobile_devices SET session_token=? WHERE session_token=? AND user_id=?", nextHash, previousHash, userId).changes;
  run("UPDATE push_subscriptions SET session_token=? WHERE session_token=? AND user_id=?", nextHash, previousHash, userId);
  run("DELETE FROM sessions WHERE token=? AND user_id=?", previousHash, userId);
  return Number(moved);
}
export function upsertUser(subject: string, name: string, email: string) {
  let user = one<User>("SELECT * FROM users WHERE subject=?", subject);
  if (user?.disabled) throw new HttpError(403, "Dieses Konto ist deaktiviert.");
  if (!user) {
    const uid = id();
    run(
      "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
      uid,
      subject,
      name,
      email,
    );
    user = one<User>("SELECT * FROM users WHERE id=?", uid)!;
  } else
    run("UPDATE users SET name=?,email=? WHERE id=?", name, email, user.id);
  return user;
}
// Invitations waiting for an account whose address is confirmed: taken
// over at sign-in and when the app loads, so an account that already exists
// gets a later invitation too. SSO accounts take them over at sign-in, when
// the provider confirms the address.
export function acceptPendingInvites(userId: string) {
  const user = one<User>("SELECT * FROM users WHERE id=?", userId);
  if (!user || !one("SELECT 1 FROM invites WHERE lower(email)=lower(?)", user.email)) return;
  // Only a confirmed address (by e-mail link, an administrator or the SSO
  // provider) proves it is this person's.
  if (one("SELECT 1 FROM users WHERE id=? AND email_verified=1", userId)) acceptInvites(user, true);
}
export function acceptInvites(user: User, emailVerified: boolean) {
  if (!emailVerified) return;
  for (const inv of all<Invite>("SELECT * FROM invites WHERE lower(email)=lower(?)", user.email)) acceptInvite(user, inv);
}
type Invite = { id: string; workspace_id: string; email: string; role: string; guest: number };
// One invitation for this person: membership (as guest when invited so),
// the pages that waited for it, and a note in the inbox.
function acceptInvite(user: User, inv: Invite) {
    const added = run(
      "INSERT OR IGNORE INTO members VALUES(?,?,?)",
      inv.workspace_id,
      user.id,
      inv.role,
    ).changes;
    // The person finds the workspace (or the shared page) in the inbox.
    if (added) {
      const ws = one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", inv.workspace_id);
      const by = one<{ name: string }>("SELECT u.name FROM invites i JOIN users u ON u.id=i.created_by WHERE i.id=?", inv.id);
      const page = one<{ id: string; title: string }>(
        "SELECT p.id,p.title FROM invite_grants g JOIN pages p ON p.id=g.resource_id WHERE lower(g.email)=lower(?) AND g.workspace_id=? AND p.deleted_at IS NULL",
        inv.email,
        inv.workspace_id,
      );
      run(
        "INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'share')",
        id(),
        user.id,
        inv.guest && page
          ? `${by?.name || "Jemand"} hat „${page.title}“ mit dir geteilt`
          : `${by?.name || "Jemand"} hat dich zum Arbeitsbereich „${ws?.name || ""}“ hinzugefügt`,
        page?.id ?? null,
      );
    }
    // An existing membership is never downgraded to guest by an invite.
    if (added && inv.guest)
      run(
        "INSERT OR IGNORE INTO workspace_guests(workspace_id,user_id) VALUES(?,?)",
        inv.workspace_id,
        user.id,
      );
    // Pages shared before the account existed (lib/page-share.ts).
    for (const g of all<{ resource_id: string; role: string }>(
      "SELECT resource_id,role FROM invite_grants WHERE lower(email)=lower(?) AND workspace_id=?",
      inv.email,
      inv.workspace_id,
    )) {
      if (!one("SELECT 1 FROM pages WHERE id=? AND workspace_id=? AND deleted_at IS NULL", g.resource_id, inv.workspace_id)) continue;
      run("DELETE FROM grants WHERE resource_id=? AND user_id=? AND group_id=''", g.resource_id, user.id);
      run("INSERT INTO grants VALUES(?,?,?,?)", g.resource_id, user.id, "", g.role);
    }
    run("DELETE FROM invite_grants WHERE lower(email)=lower(?) AND workspace_id=?", inv.email, inv.workspace_id);
    run("DELETE FROM invites WHERE id=?", inv.id);
}
// The link from an invitation (?invite=…): whoever opens it signed in takes
// the invitation over, whatever their address – the link is the proof. This
// is the way in on instances without e-mail, where an address cannot be
// confirmed. Returns the workspace, or null for an unknown or used link.
export const inviteTokenShape = /^[A-Za-z0-9_-]{20,64}$/;
export function acceptInviteToken(user: User, token: string) {
  if (!inviteTokenShape.test(token)) return null;
  const inv = one<Invite>("SELECT * FROM invites WHERE token=?", token);
  if (!inv) return null;
  acceptInvite(user, inv);
  return inv.workspace_id;
}
export const inviteToken = () => randomBytes(24).toString("base64url");
// Changes that do not pass checkOrigin (tokens in the address: webhooks,
// inbound mail, Git, CalDAV) call this themselves.
export function refuseWhileReadOnly(req: Request) {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {}
  const refusal = readOnlyRefusal(path);
  if (refusal) throw new HttpError(423, refusal);
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    // Every limit that refuses with 429 counts for the operations dashboard.
    if (status === 429) recordOpsEvent("rate_limited");
  }
}
export function checkOrigin(req: Request) {
  // Every change passes here: while the instance moves (lib/instance-move.ts)
  // it is read-only, for API tokens as well. 423, not 503: a final answer
  // the offline queue does not retry.
  refuseWhileReadOnly(req);
  // Browsers never add a bearer token on their own, so such requests cannot
  // be forged by another site (the cookie is ignored for them).
  if (req.headers.get("authorization")?.startsWith("Bearer fp_")) return;
  const origin = req.headers.get("origin");
  if (origin !== new URL(appUrl()).origin) {
    securityEvent("request.origin", { headers: req.headers, detail: `${origin || "no origin"} → ${new URL(req.url).pathname}` });
    throw new HttpError(403, "Ungültiger Anfrageursprung.");
  }
}
