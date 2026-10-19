import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { all, one, run, id } from "./db";
import type { Identity, User } from "./types";
import { identityFromApiToken } from "./api-tokens";
export const cookieName = "flowplan_session";
export const appUrl = () => process.env.APP_URL || "http://localhost:3000";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function adminGroup() {
  return process.env.OIDC_ADMIN_GROUP || "flowplan-admins";
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
// "Stay signed in on this device": the session then lives on while it is
// used (SESSION_IDLE_HOURS after the last request, default 7 days), never
// beyond SESSION_MAX_DAYS after signing in (default 30) and, for SSO, never
// beyond SESSION_GROUPS_HOURS (default 7 days), so group changes at the
// provider take effect.
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
    groupsHours: Math.min(maxHours, bounded(process.env.SESSION_GROUPS_HOURS, 168, 1, 24 * 365)),
  };
}
// The latest end of a remembered session, from when it began.
function rememberedEnd(created: number, sso: boolean, policy: NonNullable<ReturnType<typeof rememberPolicy>>) {
  return created + (sso ? Math.min(policy.maxHours, policy.groupsHours) : policy.maxHours) * 3_600_000;
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
  // A remembered session lives on while used (written at most every few
  // minutes); turning the option off on the instance ends the sliding.
  const policy = rememberPolicy();
  if (s.remember && policy && s.created_at_s) {
    const next = Math.min(now + policy.idleHours * 3_600_000, rememberedEnd(s.created_at_s, !!s.sso, policy));
    if (next - s.expires > 5 * 60_000) run("UPDATE sessions SET expires=?,last_seen=? WHERE token=?", next, now, hash(token));
  } else if (!s.demo_until && now - (s.last_seen || 0) > 5 * 60_000)
    run("UPDATE sessions SET last_seen=? WHERE token=?", now, hash(token));
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
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Bitte melde dich an.");
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
  if (!demo) run("UPDATE users SET last_login_at=? WHERE id=?", now, userId);
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
  (await cookies()).set(cookieName, token, {
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
export function acceptInvites(user: User, emailVerified: boolean) {
  if (!emailVerified) return;
  for (const inv of all<{
    id: string;
    workspace_id: string;
    role: string;
    guest: number;
  }>("SELECT * FROM invites WHERE lower(email)=lower(?)", user.email)) {
    const added = run(
      "INSERT OR IGNORE INTO members VALUES(?,?,?)",
      inv.workspace_id,
      user.id,
      inv.role,
    ).changes;
    // An existing membership is never downgraded to guest by an invite.
    if (added && inv.guest)
      run(
        "INSERT OR IGNORE INTO workspace_guests(workspace_id,user_id) VALUES(?,?)",
        inv.workspace_id,
        user.id,
      );
    run("DELETE FROM invites WHERE id=?", inv.id);
  }
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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
