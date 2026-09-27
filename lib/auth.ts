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
export function identityFromToken(token: string): Identity | null {
  const s = one<User & { groups_json: string; expires: number }>(
    "SELECT u.*,s.groups_json,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    hash(token),
    Date.now(),
  );
  if (!s) return null;
  const groups = JSON.parse(s.groups_json) as string[];
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
) {
  const token = randomBytes(32).toString("base64url");
  if (!demo) run("UPDATE users SET last_login_at=? WHERE id=?", Date.now(), userId);
  const hours = Math.min(
    24,
    Math.max(1, Number(process.env.SESSION_HOURS) || 8),
  );
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    hash(token),
    userId,
    JSON.stringify(groups),
    demo ? demo.expires : Date.now() + hours * 3600000,
  );
  (await cookies()).set(cookieName, token, {
    httpOnly: true,
    secure: new URL(appUrl()).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: demo
      ? Math.max(60, Math.round((demo.until - Date.now()) / 1000))
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
