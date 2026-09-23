import { cookies } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { all, one, run, id } from "./db";
import type { Identity, User } from "./types";
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
  const s = one<User & { groups_json: string }>(
    "SELECT u.*,s.groups_json FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.disabled=0",
    hash(token),
    Date.now(),
  );
  if (!s) return null;
  const groups = JSON.parse(s.groups_json) as string[];
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    disabled: s.disabled,
    created_at: s.created_at,
    groups,
    isAdmin: groups.includes(adminGroup()),
  };
}
export async function currentUser() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  return token ? identityFromToken(token) : null;
}
export async function requireUser() {
  const u = await currentUser();
  if (!u) throw new HttpError(401, "Bitte melde dich an.");
  return u;
}
export async function issueSession(userId: string, groups: string[]) {
  const token = randomBytes(32).toString("base64url");
  const hours = Math.min(
    24,
    Math.max(1, Number(process.env.SESSION_HOURS) || 8),
  );
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    hash(token),
    userId,
    JSON.stringify(groups),
    Date.now() + hours * 3600000,
  );
  (await cookies()).set(cookieName, token, {
    httpOnly: true,
    secure: new URL(appUrl()).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: hours * 3600,
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
  for (const inv of all<{ id: string; workspace_id: string; role: string }>(
    "SELECT * FROM invites WHERE lower(email)=lower(?)",
    user.email,
  )) {
    run(
      "INSERT OR IGNORE INTO members VALUES(?,?,?)",
      inv.workspace_id,
      user.id,
      inv.role,
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
  const origin = req.headers.get("origin");
  if (origin !== new URL(appUrl()).origin)
    throw new HttpError(403, "Ungültiger Anfrageursprung.");
}
