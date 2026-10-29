import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { all, one, run, id } from "./db";
import type { Identity, User } from "./types";
import { identityFromApiToken } from "./api-tokens";
import { needsTwoFactorSetup } from "./two-factor-policy";
import { recordOpsEvent } from "./ops-events";
import { noteActive } from "./metrics";
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
  const needle = `%${JSON.stringify(adminGroup())}%`;
  return all<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.disabled=0 AND (
       (SELECT s.groups_json FROM sessions s WHERE s.user_id=u.id ORDER BY COALESCE(s.created_at,0) DESC, s.expires DESC LIMIT 1) LIKE ?
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
// How long sessions last. A normal session ends SESSION_HOURS after signing
// in (default 8, at most 24). With SESSION_REMEMBER=true people can choose
// "Stay signed in on this device" (the apps always ask for it): the session
// then lives on while it is used (SESSION_IDLE_HOURS after the last request,
// default 7 days), never beyond SESSION_MAX_DAYS after signing in (default
// 30) – for SSO the same as for passwords and passkeys. Only an instance
// that sets SESSION_GROUPS_HOURS ends SSO sessions earlier, so group changes
// at the provider take effect at the next sign-in; without it they follow
// through SCIM, the LDAP sync or the next sign-in.
const bounded = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = Number(raw);
  return Math.min(max, Math.max(min, Number.isFinite(value) && value > 0 ? value : fallback));
};
export const sessionHours = () => bounded(process.env.SESSION_HOURS, 8, 1, 24);
export function rememberPolicy() {
  if (process.env.SESSION_REMEMBER !== "true") return null;
  const maxHours = bounded(process.env.SESSION_MAX_DAYS, 30, 1, 365) * 24;
  return {
    idleHours: Math.min(maxHours, bounded(process.env.SESSION_IDLE_HOURS, 168, 1, 24 * 90)),
    maxHours,
    groupsHours: process.env.SESSION_GROUPS_HOURS ? Math.min(maxHours, bounded(process.env.SESSION_GROUPS_HOURS, 168, 1, 24 * 365)) : null,
  };
}
// The latest end of a remembered session, from when it began.
function rememberedEnd(created: number, sso: boolean, policy: NonNullable<ReturnType<typeof rememberPolicy>>) {
  return created + (sso && policy.groupsHours ? policy.groupsHours : policy.maxHours) * 3_600_000;
}
type SessionUse = { token: string; expires: number; created_at: number | null; remember: number; sso: number; last_seen: number | null; demo_until?: number | null };
// A session in use: a remembered one lives on (written at most every few
// minutes; turning the option off on the instance ends the sliding), every
// other one notes when it was last used. Called for the cookie and for the
// apps' device tokens (lib/mobile-devices.ts), so widgets that refresh in the
// background keep the session of their app alive like the app itself.
export function touchSession(s: SessionUse, now = Date.now()) {
  if (s.demo_until) return;
  const policy = rememberPolicy();
  const stale = now - (s.last_seen || 0) > 5 * 60_000;
  if (s.remember && policy && s.created_at) {
    const next = Math.min(now + policy.idleHours * 3_600_000, rememberedEnd(s.created_at, !!s.sso, policy));
    if (next - s.expires > 5 * 60_000) return run("UPDATE sessions SET expires=?,last_seen=? WHERE token=?", next, now, s.token);
  }
  if (stale) run("UPDATE sessions SET last_seen=? WHERE token=?", now, s.token);
}
export function identityFromToken(token: string): Identity | null {
  const now = Date.now();
  const s = one<User & { groups_json: string; expires: number; created_at_s: number | null; remember: number; sso: number; last_seen: number | null }>(
    "SELECT u.*,s.groups_json,s.expires,s.created_at created_at_s,s.remember,s.sso,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    hash(token),
    now,
  );
  if (!s) return null;
  const groups = JSON.parse(s.groups_json) as string[];
  touchSession({ token: hash(token), expires: s.expires, created_at: s.created_at_s, remember: s.remember, sso: s.sso, last_seen: s.last_seen, demo_until: s.demo_until }, now);
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
  // Scripts and integrations sign in with a personal API token.
  const authorization = (await headers()).get("authorization");
  if (authorization?.startsWith("Bearer ")) return identityFromApiToken(authorization);
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  return token ? identityFromToken(token) : null;
}
// The same from a request's own headers (route handlers that also run in
// tests without a Next.js request around them): a personal API token, or
// the session cookie.
export function identityFromRequest(req: Request): Identity | null {
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
  // "Stay signed in on this device" (only when the instance allows it), and
  // whether the groups came from an SSO provider.
  options: { remember?: boolean; sso?: boolean } = {},
) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  if (!demo) {
    run("UPDATE users SET last_login_at=? WHERE id=?", now, userId);
    // Counted for the sign-in chart of the monitoring (lib/admin-ops.ts).
    recordOpsEvent("login_success", now);
  }
  const hours = sessionHours();
  const policy = !demo && options.remember ? rememberPolicy() : null;
  const expires = demo
    ? demo.expires
    : policy
      ? Math.min(now + policy.idleHours * 3_600_000, rememberedEnd(now, !!options.sso, policy))
      : now + hours * 3_600_000;
  const agent = ((await headers()).get("user-agent") || "").slice(0, 300);
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,remember,sso,last_seen,agent) VALUES(?,?,?,?,?,?,?,?,?)",
    hash(token),
    userId,
    JSON.stringify(groups),
    expires,
    now,
    policy ? 1 : 0,
    options.sso ? 1 : 0,
    now,
    agent,
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
    maxAge: demo
      ? Math.max(60, Math.round((demo.until - now) / 1000))
      : policy
        ? Math.round((rememberedEnd(now, !!options.sso, policy) - now) / 1000)
        : hours * 3600,
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
export function acceptInviteToken(user: User, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const inv = one<Invite>("SELECT * FROM invites WHERE token=?", token);
  if (!inv) return null;
  acceptInvite(user, inv);
  return inv.workspace_id;
}
export const inviteToken = () => randomBytes(24).toString("base64url");
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
  // Browsers never add a bearer token on their own, so such requests cannot
  // be forged by another site (the cookie is ignored for them).
  if (req.headers.get("authorization")?.startsWith("Bearer fp_")) return;
  const origin = req.headers.get("origin");
  if (origin !== new URL(appUrl()).origin)
    throw new HttpError(403, "Ungültiger Anfrageursprung.");
}
