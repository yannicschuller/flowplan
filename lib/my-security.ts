// Settings → Sicherheitscheck: the security of one's own account – what is
// set up and what is missing (second factor, passkeys, recovery codes,
// devices, tokens, notices), what one has shared (links, public pages,
// people with access to one's pages) and the latest sign-ins and changes
// of the account (lib/security-events.ts).
import { createHash } from "node:crypto";
import { all, one } from "./db";
import { HttpError, hash } from "./auth";
import { isLocalAccount } from "./local-auth";
import { isLdapAccount } from "./ldap-auth";
import { twoFactorStatus } from "./two-factor";
import { notificationPrefs } from "./notification-prefs";
import { deviceLabel } from "./device-name";
import { subjectHash } from "./security-events";
import type { Identity } from "./types";

const DAY = 86_400_000;
export type CheckState = "ok" | "todo" | "info";
export type SecurityCheck = {
  id: string;
  state: CheckState;
  // Where the fix is (a settings anchor) or what the page does itself.
  anchor?: string;
  count?: number;
};

const sessionId = (tokenHash: string) => createHash("sha256").update(`session:${tokenHash}`).digest("hex").slice(0, 20);

export function mySecurity(user: Identity, currentToken: string | undefined, now = Date.now()) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht möglich.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  const local = isLocalAccount(user.id);
  const ldap = isLdapAccount(user.id);
  const factor = local ? twoFactorStatus(user.id) : null;
  const passkeys = local ? Number(one<{ n: number }>("SELECT COUNT(*) n FROM passkeys WHERE user_id=?", user.id)?.n || 0) : 0;
  const unconfirmed = local && !!one("SELECT 1 FROM local_accounts WHERE user_id=? AND email_verified=0", user.id);

  // Devices: how many, and which have not been used for a month.
  const current = currentToken ? hash(currentToken) : "";
  const sessions = all<{ token: string; created_at: number | null; last_seen: number | null; agent: string }>(
    "SELECT token,created_at,last_seen,agent FROM sessions WHERE user_id=? AND expires>?",
    user.id,
    now,
  );
  const stale = sessions.filter((s) => s.token !== current && (s.last_seen ?? s.created_at ?? 0) < now - 30 * DAY);

  // API tokens: without end, or not used for three months.
  const tokens = all<{ id: string; name: string; scope: string; created_at: number; last_used_at: number | null; expires_at: number | null }>(
    "SELECT id,name,scope,created_at,last_used_at,expires_at FROM api_tokens WHERE user_id=? AND (expires_at IS NULL OR expires_at>?)",
    user.id,
    now,
  );
  const idleTokens = tokens.filter((t) => (t.last_used_at ?? t.created_at) < now - 90 * DAY);
  const endlessTokens = tokens.filter((t) => !t.expires_at);

  // What this person shared.
  const links = all<{ token: string; name: string; role: string; root_id: string; title: string; created_at: string; include_children: number; password: number; expires_at: number | null }>(
    `SELECT l.token,l.name,l.role,l.root_id,p.title,l.created_at,l.include_children,l.password_hash IS NOT NULL password,l.expires_at
     FROM share_links l JOIN pages p ON p.id=l.root_id WHERE l.created_by=? AND p.deleted_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>?)
     ORDER BY l.created_at DESC LIMIT 200`,
    user.id,
    now,
  );
  const openEditorLinks = links.filter((l) => l.role === "editor" && !l.password && !l.expires_at);
  const published = all<{ id: string; title: string; updated_at: string }>(
    "SELECT id,title,updated_at FROM pages WHERE created_by=? AND public_token IS NOT NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200",
    user.id,
  );
  // People (and pending invitations) with their own access to pages this
  // person created – not the whole workspace.
  const people = [
    ...all<{ page_id: string; title: string; user_id: string; name: string; email: string; role: string; guest: number }>(
      `SELECT p.id page_id,p.title,u.id user_id,u.name,u.email,g.role,EXISTS(SELECT 1 FROM workspace_guests wg WHERE wg.workspace_id=p.workspace_id AND wg.user_id=u.id) guest
       FROM grants g JOIN pages p ON p.id=g.resource_id JOIN users u ON u.id=g.user_id
       WHERE p.created_by=? AND g.group_id='' AND g.user_id<>? AND p.deleted_at IS NULL ORDER BY p.title LIMIT 300`,
      user.id,
      user.id,
    ).map((r) => ({ pageId: r.page_id, page: r.title, userId: r.user_id, email: r.email, name: r.name, role: r.role, guest: !!r.guest, pending: false })),
    ...all<{ page_id: string; title: string; email: string; role: string }>(
      `SELECT p.id page_id,p.title,i.email,i.role FROM invite_grants i JOIN pages p ON p.id=i.resource_id
       WHERE p.created_by=? AND p.deleted_at IS NULL ORDER BY p.title LIMIT 100`,
      user.id,
    ).map((r) => ({ pageId: r.page_id, page: r.title, userId: "", email: r.email, name: "", role: r.role, guest: true, pending: true })),
  ];

  // Sign-ins and changes of the account, and failed attempts with its address.
  const subject = subjectHash(user.email || "");
  const activity = all<{ id: number; at: number; kind: string; network: string; country: string; device: string; detail: string }>(
    `SELECT id,at,kind,network,country,device,detail FROM security_events
     WHERE at>=? AND (actor_id=? OR (subject_key<>'' AND subject_key=?))
       AND kind IN ('login.success','login.failure','login.refused','login.new_device','session.revoked','account.password','account.password_reset','account.passkey_added','account.passkey_removed','account.2fa_on','account.2fa_off','account.token_created','account.token_revoked','account.messenger_added','account.messenger_removed','admin.granted','admin.revoked','share.public','data.export')
     ORDER BY id DESC LIMIT 40`,
    now - 30 * DAY,
    user.id,
    subject,
  );
  const failures = Number(
    one<{ n: number }>(
      "SELECT COUNT(*) n FROM security_events WHERE subject_key<>'' AND subject_key=? AND kind IN ('login.failure','login.refused') AND at>=?",
      subject,
      now - 30 * DAY,
    )?.n || 0,
  );

  const prefs = notificationPrefs(user).security;
  const secondFactor = !!factor && (factor.enabled || factor.passkey);
  const checks: SecurityCheck[] = [];
  if (local) {
    checks.push({ id: "second-factor", state: secondFactor ? "ok" : "todo", anchor: "two-factor" });
    checks.push({ id: "passkey", state: passkeys ? "ok" : "todo", anchor: "passkeys", count: passkeys });
    if (factor?.enabled) checks.push({ id: "recovery", state: factor.recoveryLeft >= 3 ? "ok" : "todo", anchor: "two-factor", count: factor.recoveryLeft });
    if (unconfirmed) checks.push({ id: "email", state: "todo", anchor: "profile" });
  } else checks.push({ id: ldap ? "directory" : "provider", state: "info" });
  checks.push({ id: "devices", state: stale.length ? "todo" : "ok", anchor: "sessions", count: stale.length });
  if (tokens.length) checks.push({ id: "tokens", state: idleTokens.length || endlessTokens.length ? "todo" : "ok", count: idleTokens.length + endlessTokens.length });
  checks.push({ id: "links", state: openEditorLinks.length ? "todo" : "ok", count: openEditorLinks.length });
  checks.push({ id: "notices", state: prefs.email || prefs.push ? "ok" : "todo" });
  checks.push({ id: "failures", state: failures >= 5 ? "todo" : failures ? "info" : "ok", count: failures });

  return {
    account: { kind: local ? ("local" as const) : ldap ? ("ldap" as const) : ("sso" as const), email: user.email },
    checks,
    sessions: {
      count: sessions.length,
      stale: stale.map((s) => ({ id: sessionId(s.token), device: deviceLabel(s.agent || ""), lastSeen: s.last_seen ?? s.created_at })),
    },
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scope: t.scope,
      lastUsedAt: t.last_used_at,
      expiresAt: t.expires_at,
      idle: (t.last_used_at ?? t.created_at) < now - 90 * DAY,
    })),
    links: links.map((l) => ({
      token: l.token,
      pageId: l.root_id,
      page: l.title,
      name: l.name,
      role: l.role,
      subpages: !!l.include_children,
      password: !!l.password,
      expiresAt: l.expires_at,
      createdAt: l.created_at,
    })),
    published: published.map((p) => ({ pageId: p.id, page: p.title })),
    people,
    activity,
  };
}
export type MySecurity = ReturnType<typeof mySecurity>;
