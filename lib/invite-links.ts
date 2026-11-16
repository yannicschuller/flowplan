// Invitation links for several people (#320): an owner creates a link with a
// role (editor or viewer, optionally as guest – never owner), an expiry
// (24 hours, 7 or 30 days) and an optional number of joins. Whoever opens it
// signs in or signs up – also while sign-ups are closed (lib/local-auth.ts
// register) – and joins the workspace with the link's role.
//
// Security:
// - the token is 32 random bytes (256 bit, base64url). The database keeps
//   its SHA-256 for the lookup, compared once more in constant time, and a
//   sealed copy (AES-256-GCM, lib/ai/secrets.ts, bound to the link's id) so
//   owners can copy the link again. A database copy alone opens no link; a
//   backup restored without the secrets key just cannot show "Copy" any more.
// - the token never goes into a log or a security event; events name the
//   link's id.
// - joining is limited per person and per address, takes the workspace's
//   membership lock and counts a join with a conditional update, so two
//   joins at once cannot pass the limit. Joining as a member already is a
//   no-op and costs no use.
// - administrators switch links off for the instance (Administration →
//   Anmeldung & SSO, instance setting inviteLinks); FLOWPLAN_INVITE_LINKS=off
//   in the environment wins. Switched off, existing links do not open.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, id, lockMembership, one, run, transaction } from "./db";
import { HttpError, appUrl, hash } from "./auth";
import { allow, limitInviter } from "./action-limits";
import { instanceSettings } from "./instance-settings";
import { openSecret, sealSecret } from "./ai/secrets";
import { securityEvent } from "./security-events";
import type { User } from "./types";

export const INVITE_LINK_EXPIRY = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 } as const;
export type InviteLinkExpiry = keyof typeof INVITE_LINK_EXPIRY;
// Links per workspace that may be open at the same time.
export const MAX_ACTIVE_LINKS = 50;
// Expired or revoked links stay visible in no list; their rows go after this.
const KEEP_ENDED_MS = 30 * 24 * 3_600_000;
export const inviteLinkTokenShape = /^[A-Za-z0-9_-]{43}$/;
const aad = (linkId: string) => `invite-link:${linkId}`;
export const inviteLinkUrl = (token: string) => `${appUrl().replace(/\/$/, "")}/?join=${token}`;

export const inviteLinksForcedOff = () => /^(off|false|0|no)$/i.test(process.env.FLOWPLAN_INVITE_LINKS?.trim() || "");
export async function inviteLinksEnabled() {
  return !inviteLinksForcedOff() && (await instanceSettings()).inviteLinks;
}

export const inviteLinkInput = z.object({
  role: z.enum(["editor", "viewer"]),
  guest: z.boolean().optional(),
  expires: z.enum(Object.keys(INVITE_LINK_EXPIRY) as [InviteLinkExpiry, ...InviteLinkExpiry[]]),
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
});

type Row = {
  id: string;
  workspace_id: string;
  token_hash: string;
  token_sealed: string | null;
  role: "editor" | "viewer";
  guest: number;
  max_uses: number | null;
  uses: number;
  expires_at: number;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
};

const off = () => new HttpError(403, "Einladungslinks sind auf dieser Instanz ausgeschaltet.");

// Owners only (checked by the caller, lib/api.ts, under the membership lock).
export async function createInviteLink(user: Pick<User, "id">, workspaceId: string, raw: unknown, now = Date.now()) {
  if (!(await inviteLinksEnabled())) throw off();
  const input = inviteLinkInput.parse(raw);
  limitInviter(user.id);
  const active = Number((await one<{ n: number }>(
    "SELECT COUNT(*) n FROM invite_links WHERE workspace_id=? AND revoked_at IS NULL AND expires_at>?",
    workspaceId,
    now,
  ))?.n || 0);
  if (active >= MAX_ACTIVE_LINKS) throw new HttpError(409, `Höchstens ${MAX_ACTIVE_LINKS} Einladungslinks können gleichzeitig offen sein. Zieh zuerst einen zurück.`);
  const linkId = id(),
    token = randomBytes(32).toString("base64url"),
    expiresAt = now + INVITE_LINK_EXPIRY[input.expires] * 3_600_000;
  let sealed: string | null = null;
  try {
    sealed = sealSecret(token, aad(linkId));
  } catch {
    // Without a usable secrets key the link is shown once, not again.
  }
  await run(
    "INSERT INTO invite_links(id,workspace_id,token_hash,token_sealed,role,guest,max_uses,uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)",
    linkId,
    workspaceId,
    hash(token),
    sealed,
    input.role,
    input.guest ? 1 : 0,
    input.maxUses ?? null,
    expiresAt,
    user.id,
    now,
  );
  securityEvent("invite_link.created", {
    actorId: user.id,
    detail: `link ${linkId} workspace ${workspaceId} ${input.role}${input.guest ? " guest" : ""} expires ${new Date(expiresAt).toISOString()} max ${input.maxUses ?? "unlimited"}`,
  });
  return { id: linkId, url: inviteLinkUrl(token), expiresAt, maxUses: input.maxUses ?? null, role: input.role, guest: !!input.guest };
}

export async function revokeInviteLink(user: Pick<User, "id">, workspaceId: string, linkId: string, now = Date.now()) {
  const changed = (await run("UPDATE invite_links SET revoked_at=?,token_sealed=NULL WHERE id=? AND workspace_id=? AND revoked_at IS NULL", now, linkId, workspaceId)).changes;
  if (!changed && !(await one("SELECT 1 FROM invite_links WHERE id=? AND workspace_id=?", linkId, workspaceId)))
    throw new HttpError(404, "Einladungslink nicht gefunden.");
  if (changed) securityEvent("invite_link.revoked", { actorId: user.id, detail: `link ${linkId} workspace ${workspaceId}` });
  return { ok: true as const };
}

// The open links of a workspace for its owners: neither revoked nor expired
// (used-up ones stay until they expire, marked as such).
export async function listInviteLinks(workspaceId: string, now = Date.now()) {
  await run("DELETE FROM invite_links WHERE workspace_id=? AND (expires_at<? OR revoked_at<?)", workspaceId, now - KEEP_ENDED_MS, now - KEEP_ENDED_MS);
  const rows = await all<Row & { creator: string | null }>(
    "SELECT l.*,u.name creator FROM invite_links l LEFT JOIN users u ON u.id=l.created_by WHERE l.workspace_id=? AND l.revoked_at IS NULL AND l.expires_at>? ORDER BY l.created_at DESC",
    workspaceId,
    now,
  );
  return rows.map((r) => {
    let url: string | null = null;
    if (r.token_sealed)
      try {
        url = inviteLinkUrl(openSecret(r.token_sealed, aad(r.id)));
      } catch {}
    return {
      id: r.id,
      role: r.role,
      guest: !!r.guest,
      uses: r.uses,
      maxUses: r.max_uses,
      usedUp: r.max_uses !== null && r.uses >= r.max_uses,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      creator: r.creator,
      url,
    };
  });
}

export type InviteLinkRefusal = "invalid" | "expired" | "revoked" | "used_up" | "disabled" | "limited";
// What a refusal says, in German (translated by lib/i18n-errors.ts).
export const inviteLinkMessages: Record<InviteLinkRefusal, string> = {
  invalid: "Dieser Einladungslink ist ungültig.",
  expired: "Dieser Einladungslink ist abgelaufen. Bitte frag nach einem neuen.",
  revoked: "Dieser Einladungslink wurde zurückgezogen.",
  used_up: "Dieser Einladungslink wurde schon so oft verwendet wie erlaubt.",
  disabled: "Einladungslinks sind auf dieser Instanz ausgeschaltet.",
  limited: "Zu viele Versuche mit Einladungslinks. Bitte versuch es später erneut.",
};

// The link behind a token, compared in constant time; null when unknown.
async function findLink(token: string) {
  if (!inviteLinkTokenShape.test(token)) return null;
  const digest = hash(token);
  const row = await one<Row>("SELECT * FROM invite_links WHERE token_hash=?", digest);
  if (!row) return null;
  const a = Buffer.from(row.token_hash, "hex"),
    b = Buffer.from(digest, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}
function refusal(row: Row | null, now: number): InviteLinkRefusal | null {
  if (!row) return "invalid";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= now) return "expired";
  if (row.max_uses !== null && row.uses >= row.max_uses) return "used_up";
  return null;
}

// For the sign-in page: whether the link opens sign-up, and which workspace
// it leads to. `address`: the visitor's address (rate limit; never stored).
export async function inviteLinkPreview(token: string | undefined, address = "", now = Date.now()): Promise<{ ok: true; workspace: string } | { ok: false; reason: InviteLinkRefusal } | null> {
  if (!token) return null;
  if (!(await inviteLinksEnabled())) return { ok: false, reason: "disabled" };
  if (address && !allow(`join-view:${address}`, 60, 10 * 60_000)) return { ok: false, reason: "limited" };
  const row = await findLink(token);
  const reason = refusal(row, now);
  if (reason || !row) return { ok: false, reason: reason || "invalid" };
  const ws = await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", row.workspace_id);
  return { ok: true, workspace: ws?.name || "" };
}
// Whether a sign-up may go ahead through this link (closed sign-ups).
export async function inviteLinkOpensSignup(token: string | undefined, now = Date.now()) {
  if (!token || !(await inviteLinksEnabled())) return false;
  return refusal(await findLink(token), now) === null;
}

export type JoinResult = { status: "joined" | "member"; workspaceId: string } | { status: "refused"; reason: InviteLinkRefusal };
// Joins `user` to the link's workspace with the link's role. A member
// already stays as they are (no use counted, never more or less rights).
export async function acceptInviteLink(user: Pick<User, "id"> & { demo_until?: number | null; disabled?: number }, token: string, address = "", now = Date.now()): Promise<JoinResult> {
  const refuse = (reason: InviteLinkRefusal, linkId?: string): JoinResult => {
    securityEvent("invite_link.refused", { actorId: user.id, detail: `${reason}${linkId ? ` link ${linkId}` : ""}` });
    return { status: "refused", reason };
  };
  if (!(await inviteLinksEnabled())) return refuse("disabled");
  if (!allow(`join:${user.id}`, 20, 3_600_000) || (address && !allow(`join-ip:${address}`, 60, 3_600_000))) return refuse("limited");
  if (user.demo_until || user.disabled) return refuse("invalid");
  const found = await findLink(token);
  if (!found) return refuse("invalid");
  return await transaction(async () => {
    await lockMembership(found.workspace_id);
    const row = await one<Row>("SELECT * FROM invite_links WHERE id=?", found.id);
    if (await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", found.workspace_id, user.id))
      return { status: "member" as const, workspaceId: found.workspace_id };
    const reason = refusal(row ?? null, now);
    if (reason || !row) return refuse(reason || "invalid", found.id);
    if (!(await one("SELECT 1 FROM workspaces WHERE id=?", row.workspace_id))) return refuse("invalid", found.id);
    // Counted only while there is room: a parallel join on another
    // instance cannot pass the limit.
    const counted = (await run(
      "UPDATE invite_links SET uses=uses+1 WHERE id=? AND revoked_at IS NULL AND expires_at>? AND (max_uses IS NULL OR uses<max_uses)",
      row.id,
      now,
    )).changes;
    if (!counted) return refuse("used_up", row.id);
    await run("INSERT INTO members VALUES(?,?,?) ON CONFLICT DO NOTHING", row.workspace_id, user.id, row.role);
    if (row.guest) await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", row.workspace_id, user.id);
    securityEvent("invite_link.used", { actorId: user.id, detail: `link ${row.id} workspace ${row.workspace_id} ${row.role}${row.guest ? " guest" : ""}` });
    return { status: "joined" as const, workspaceId: row.workspace_id };
  });
}
