// Emergency access for trusted contacts (#281). A person (the holder) names
// people with an account on this instance as trusted contacts, each with a
// waiting period. A contact who accepted the role may ask for access; the
// holder hears of it at once (inbox, push, chat apps, e-mail with a link to
// deny without signing in) and again halfway and a day before the end. Not
// denied in time, the contact may READ and EXPORT the holder's own content:
// the private spaces the holder owns – never what the holder sees only
// through a workspace (team spaces, others' spaces shared with them), never
// journals with a PIN. Nothing can be changed, deleted, shared or given to
// the AI: the contact gets no membership, grant or role anywhere – the
// existing permission checks refuse every command on that content as
// before – and reads only through the routes of this module. The holder
// ends the access whenever they like; it never takes over the account
// (credentials stay with the administrators).
//
// Encrypted spaces stay zero-knowledge: the holder's browser seals the
// space keys for the contact's public key (lib/e2ee.ts emergencyKeyContext);
// the server stores them and hands them to the contact only while access is
// granted. Every step is in the activity log and a security event
// (lib/security-events.ts EMERGENCY_KINDS), several requests in a short time
// open an incident (lib/security-detect.ts). The administration can switch
// the feature off (Administration → Anmeldung & SSO, or
// FLOWPLAN_EMERGENCY_ACCESS=off): granted access is suspended meanwhile.
//
// Timers: the end of the waiting period is stored (grant_at) and applied
// when anything reads the link (settle) as well as by the worker every few
// minutes, so a restart never loses or delays a grant.
import { z } from "zod";
import { all, audit, id, lockFor, nowText, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { instanceSettings } from "./instance-settings";
import { pageRole } from "./permissions";
import { inPinJournal, pinJournalPageIds } from "./journal-extras";
import { encryptedLog, sealedKey, type SpaceFlags } from "./e2ee-server";
import { signValue, validSignature } from "./secret-box";
import { mailAppUrl, mailConfig, mailEscape, mailLayout, queueMail } from "./mail";
import { userLocale } from "./user-locale";
import { translate } from "./i18n";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import {
  EMERGENCY_ACCESS_DAYS,
  EMERGENCY_DEFAULT_WAIT,
  EMERGENCY_MAX_CONTACTS,
  EMERGENCY_WAIT_DAYS,
  type EmergencyContent,
  type EmergencyOverview,
  type EmergencyRewrap,
  type EmergencyStatus,
} from "./emergency-kinds";
import type { Identity, Page } from "./types";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
// After a denial the same contact asks again a day later at the earliest.
export const EMERGENCY_DENY_COOLDOWN = DAY;
export const EMERGENCY_LINK = "#settings/account/emergency";
const DENY_PURPOSE = "emergency-deny";

export type EmergencyLink = {
  id: string;
  holder_id: string;
  contact_id: string;
  wait_days: number;
  access_days: number | null;
  status: EmergencyStatus;
  created_at: number;
  accepted_at: number | null;
  requested_at: number | null;
  grant_at: number | null;
  granted_at: number | null;
  expires_at: number | null;
  denied_at: number | null;
  reminded: number;
  keys_released: number;
};
type Person = { id: string; name: string; email: string; disabled: number; created_at: string };

const uuid = z.string().uuid();
const person = async (userId: string) => await one<Person>("SELECT id,name,email,disabled,created_at FROM users WHERE id=?", userId);
const linkRow = async (linkId: string) => await one<EmergencyLink>("SELECT * FROM emergency_contacts WHERE id=?", linkId);
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// ---- The switch ----

export const emergencyForcedOff = () => /^(off|false|0|no)$/i.test(process.env.FLOWPLAN_EMERGENCY_ACCESS?.trim() || "");
export async function emergencyEnabled() {
  if (emergencyForcedOff()) return false;
  return (await instanceSettings()).emergencyAccess !== false;
}
async function requireEnabled() {
  if (!(await emergencyEnabled())) throw new HttpError(403, "Der Notfallzugriff ist auf dieser Instanz ausgeschaltet.");
}
// Signed in in the browser – never an API token (MCP included), never a demo.
function requireSession(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
}

// ---- State ----

// The state as of `now`: a waiting period that ended is access, an access
// past its end is none – whether or not the worker ran meanwhile.
export function effectiveStatus(link: Pick<EmergencyLink, "status" | "grant_at" | "expires_at">, now = Date.now()): EmergencyStatus {
  if (link.status === "requested" && link.grant_at !== null && link.grant_at <= now) return "granted";
  if (link.status === "granted" && link.expires_at !== null && link.expires_at <= now) return "accepted";
  return link.status;
}

// Writes what the time decided (once: the UPDATE checks the old state) and
// tells both sides. Returns the link as it is now.
export async function settle(link: EmergencyLink, now = Date.now()): Promise<EmergencyLink> {
  if (link.status === "requested" && link.grant_at !== null && link.grant_at <= now) {
    const grantedAt = link.grant_at;
    const expiresAt = link.access_days ? grantedAt + link.access_days * DAY : null;
    const changed = await run(
      "UPDATE emergency_contacts SET status='granted',granted_at=?,expires_at=? WHERE id=? AND status='requested' AND grant_at<=?",
      grantedAt,
      expiresAt,
      link.id,
      now,
    );
    if (changed.changes) {
      const [holder, contact] = [await person(link.holder_id), await person(link.contact_id)];
      await record(link.contact_id, "grant", link, `waited ${link.wait_days}d`);
      if (holder && contact) {
        await notify(
          holder.id,
          `${contact.name} hat jetzt Lesezugriff auf deine Inhalte (Notfallzugriff). Beenden unter Einstellungen → Konto & Sicherheit → Notfallzugriff.`,
        );
        await notify(contact.id, `Dein Notfallzugriff auf die Inhalte von ${holder.name} ist freigegeben.`);
      }
    }
    link = (await linkRow(link.id)) || link;
  }
  if (link.status === "granted" && link.expires_at !== null && link.expires_at <= now) {
    const changed = await run(
      "UPDATE emergency_contacts SET status='accepted',requested_at=NULL,grant_at=NULL,granted_at=NULL,expires_at=NULL,reminded=0 WHERE id=? AND status='granted' AND expires_at<=?",
      link.id,
      now,
    );
    if (changed.changes) {
      await endedAccess(link);
      await record(link.holder_id, "expire", link);
      const [holder, contact] = [await person(link.holder_id), await person(link.contact_id)];
      if (holder && contact) {
        await notify(holder.id, `Der Notfallzugriff von ${contact.name} ist abgelaufen.`);
        await notify(contact.id, `Dein Notfallzugriff auf die Inhalte von ${holder.name} ist abgelaufen.`);
      }
    }
    link = (await linkRow(link.id)) || link;
  }
  return link;
}

// The activity log entry (and through it the security event): who acted,
// on which link, with both people named in the detail.
async function record(actor: string, verb: string, link: Pick<EmergencyLink, "id" | "holder_id" | "contact_id">, extra = "") {
  await audit(actor, `emergency.${verb}`, link.id, `holder:${link.holder_id} contact:${link.contact_id}${extra ? ` ${extra}` : ""}`.slice(0, 500));
}
async function notify(userId: string, body: string) {
  const nid = id();
  await run("INSERT INTO notifications(id,user_id,body,kind,link) VALUES(?,?,?,'security',?)", nid, userId, body, EMERGENCY_LINK);
  return nid;
}

// Access that ended (revoked, removed, expired): space keys the contact
// may have opened are replaced at the holder's next visit (the same
// rotation as after removing a member, lib/e2ee-server.ts); what they read
// before stays read – as for a removed member.
async function endedAccess(link: EmergencyLink) {
  if (!link.keys_released) return;
  await run(
    "UPDATE spaces SET rotate_pending=1 WHERE encrypted=1 AND id IN (SELECT DISTINCT space_id FROM emergency_keys WHERE link_id=?)",
    link.id,
  );
  await run("UPDATE emergency_contacts SET keys_released=0 WHERE id=?", link.id);
}

// ---- What a contact may read: the holder's own private spaces ----

// Private spaces the holder owns, in workspaces they are still a full
// member of. Team spaces and spaces of others shared with the holder are
// not theirs to hand on.
export async function emergencySpaces(holderId: string) {
  return await all<SpaceFlags & { workspace_name: string }>(
    `SELECT s.*,w.name workspace_name FROM spaces s JOIN workspaces w ON w.id=s.workspace_id
     JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=?
     WHERE s.owner_id=? AND s.visibility='private' AND s.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=s.workspace_id AND g.user_id=?)
     ORDER BY w.name,s.name,s.id`,
    holderId,
    holderId,
    holderId,
  );
}
const holderIdentity = (holder: Person): Identity => ({ ...holder, groups: [], isAdmin: false });

// Pages of those spaces the holder may read, without journals behind a PIN
// (whether or not the holder entered it lately) and what is below them.
async function emergencyPages(holder: Person, spaces: Awaited<ReturnType<typeof emergencySpaces>>) {
  const reader = holderIdentity(holder);
  const pages: (Page & { title_cipher?: string | null })[] = [];
  const pinned = new Map<string, Set<string>>();
  for (const space of spaces) {
    if (!pinned.has(space.workspace_id)) pinned.set(space.workspace_id, await pinJournalPageIds(space.workspace_id));
    const locked = pinned.get(space.workspace_id)!;
    for (const page of await all<Page & { title_cipher?: string | null }>(
      "SELECT * FROM pages WHERE space_id=? AND deleted_at IS NULL ORDER BY position,id",
      space.id,
    ))
      if (!locked.has(page.id) && (await pageRole(reader, page))) pages.push(page);
  }
  return pages;
}

// The link of a contact whose access is granted now, with its holder.
async function requireGranted(user: Identity, linkId: string) {
  requireSession(user);
  await requireEnabled();
  let link = await linkRow(uuid.parse(linkId));
  if (!link || link.contact_id !== user.id) throw new HttpError(404, "Nicht gefunden.");
  link = await transaction(async () => await settle(link!));
  if (link.status !== "granted") throw new HttpError(403, "Der Notfallzugriff ist nicht freigegeben.");
  const holder = await person(link.holder_id);
  if (!holder) throw new HttpError(404, "Nicht gefunden.");
  return { link, holder };
}
async function requireScopedPage(holder: Person, pageId: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", uuid.parse(pageId));
  const spaces = await emergencySpaces(holder.id);
  const space = page && spaces.find((s) => s.id === page.space_id);
  if (!page || !space || !(await pageRole(holderIdentity(holder), page)) || (await inPinJournal(page))) throw new HttpError(404, "Seite nicht gefunden.");
  return { page, space, spaces };
}

// ---- Reading (GET /api/emergency/…, session only) ----

export async function emergencyContent(user: Identity, linkId: string): Promise<EmergencyContent> {
  const { link, holder } = await requireGranted(user, linkId);
  const spaces = await emergencySpaces(holder.id);
  const pages = await emergencyPages(holder, spaces);
  await record(user.id, "view", link, "overview");
  return {
    holder: { id: holder.id, name: holder.name, email: holder.email },
    grantedAt: link.granted_at,
    expiresAt: link.expires_at,
    spaces: spaces.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      workspace: s.workspace_name,
      encrypted: !!s.encrypted,
      encryptTitles: !!s.encrypt_titles,
      keyVersion: s.key_version || 0,
    })),
    pages: pages.map((p) => ({
      id: p.id,
      spaceId: p.space_id as string,
      parentId: p.parent_id,
      title: p.title,
      titleCipher: p.title_cipher ?? null,
      icon: p.icon,
      kind: p.kind,
    })),
  };
}

// One page as Markdown (documents, databases …), exported as the holder
// would, limited to the emergency spaces (lib/markdown-export.ts).
export async function emergencyPage(user: Identity, linkId: string, pageId: string) {
  const { link, holder } = await requireGranted(user, linkId);
  const { page, space, spaces } = await requireScopedPage(holder, pageId);
  if (space.encrypted) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const { exportMarkdown } = await import("./markdown-export");
  const result = await exportMarkdown(holderIdentity(holder), {
    pageId: page.id,
    format: "markdown",
    includeSubpages: false,
    emergency: { spaceIds: spaces.filter((s) => !s.encrypted).map((s) => s.id) },
  });
  await record(user.id, "view", link, `page:${page.id}`);
  return { id: page.id, title: page.title, kind: page.kind, markdown: result.bytes.toString("utf8") };
}

// A whole (plaintext) space as ZIP, as the holder's own space export.
export async function emergencyExport(user: Identity, linkId: string, spaceId: string) {
  const { link, holder } = await requireGranted(user, linkId);
  if (!allow(`emergency-export:${user.id}`, 20, HOUR)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const spaces = await emergencySpaces(holder.id);
  const space = spaces.find((s) => s.id === uuid.parse(spaceId));
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  if (space.encrypted) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const { exportMarkdown } = await import("./markdown-export");
  const result = await exportMarkdown(holderIdentity(holder), {
    spaceId: space.id,
    format: "zip",
    includeSubpages: true,
    emergency: { spaceIds: spaces.filter((s) => !s.encrypted).map((s) => s.id) },
  });
  await transaction(async () => {
    await record(user.id, "export", link, `space:${space.id}`);
    await notify(holder.id, `${user.name} hat deine Inhalte über den Notfallzugriff exportiert („${space.name}“).`);
  });
  return result;
}

// The ciphertext of an encrypted page; the contact's browser decrypts it
// with the keys from emergencyKeys().
export async function emergencyLog(user: Identity, linkId: string, pageId: string, after: number) {
  const { link, holder } = await requireGranted(user, linkId);
  const { page, space } = await requireScopedPage(holder, pageId);
  if (!space.encrypted || page.kind !== "document") throw new HttpError(400, "Keine verschlüsselte Seite.");
  if (after === 0) await record(user.id, "view", link, `page:${page.id} encrypted`);
  return await encryptedLog(page, space, after);
}

// The space keys sealed for the contact – only now that access is granted,
// and only those sealed for the contact's current public key.
export async function emergencyKeys(user: Identity, linkId: string) {
  const { link } = await requireGranted(user, linkId);
  const identity = await one<{ public_key: string }>("SELECT public_key FROM e2ee_identities WHERE user_id=?", user.id);
  const spaces = new Set((await emergencySpaces(link.holder_id)).filter((s) => s.encrypted).map((s) => s.id));
  const keys = identity
    ? (await all<{ space_id: string; key_version: number; sealed: string }>(
        "SELECT space_id,key_version,sealed FROM emergency_keys WHERE link_id=? AND public_key=? ORDER BY space_id,key_version",
        link.id,
        identity.public_key,
      )).filter((k) => spaces.has(k.space_id))
    : [];
  if (keys.length)
    await transaction(async () => {
      await run("UPDATE emergency_contacts SET keys_released=1 WHERE id=?", link.id);
      await record(user.id, "view", link, `keys:${keys.length}`);
    });
  return {
    holderId: link.holder_id,
    contactId: link.contact_id,
    keys: keys.map((k) => ({ spaceId: k.space_id, version: k.key_version, sealed: JSON.parse(k.sealed) })),
  };
}

// ---- Overview for the settings ----

export async function emergencyOverview(user: Identity, now = Date.now()): Promise<EmergencyOverview> {
  requireSession(user);
  const enabled = await emergencyEnabled();
  if (enabled)
    await transaction(async () => {
      for (const link of await all<EmergencyLink>("SELECT * FROM emergency_contacts WHERE holder_id=? OR contact_id=?", user.id, user.id)) await settle(link, now);
    });
  const links = await all<EmergencyLink>("SELECT * FROM emergency_contacts WHERE holder_id=? OR contact_id=? ORDER BY created_at,id", user.id, user.id);
  const spaces = (await emergencySpaces(user.id)).filter((s) => s.encrypted);
  const rewrap = await rewrapNeeded(user.id, spaces);
  const people = new Map<string, Person & { public_key: string | null }>();
  for (const l of links)
    for (const uid of [l.holder_id, l.contact_id])
      if (!people.has(uid)) {
        const p = await one<Person & { public_key: string | null }>(
          "SELECT u.id,u.name,u.email,u.disabled,u.created_at,i.public_key FROM users u LEFT JOIN e2ee_identities i ON i.user_id=u.id WHERE u.id=?",
          uid,
        );
        if (p) people.set(uid, p);
      }
  const common = (l: EmergencyLink) => {
    const status = enabled ? l.status : effectiveStatus(l, now);
    return {
      id: l.id,
      status,
      waitDays: l.wait_days,
      accessDays: l.access_days,
      requestedAt: status === "requested" || status === "granted" ? l.requested_at : null,
      grantAt: status === "requested" ? l.grant_at : null,
      grantedAt: status === "granted" ? l.granted_at ?? l.grant_at : null,
      expiresAt: status === "granted" ? l.expires_at : null,
    };
  };
  const brief = (p: Person | undefined) => ({ id: p?.id || "", name: p?.name || "", email: p?.email || "" });
  return {
    enabled,
    forcedOff: emergencyForcedOff(),
    encryptedSpaces: spaces.length,
    mine: links
      .filter((l) => l.holder_id === user.id)
      .map((l) => ({
        ...common(l),
        contact: { ...brief(people.get(l.contact_id)), hasKeys: !!people.get(l.contact_id)?.public_key },
        keysMissing: rewrap.filter((r) => r.linkId === l.id).reduce((n, r) => n + r.versions.length, 0),
      })),
    forMe: links
      .filter((l) => l.contact_id === user.id)
      .map((l) => ({
        ...common(l),
        holder: brief(people.get(l.holder_id)),
        requestAfter: l.denied_at && l.denied_at + EMERGENCY_DENY_COOLDOWN > now ? l.denied_at + EMERGENCY_DENY_COOLDOWN : null,
      })),
    rewrap,
  };
}

// Key versions of the holder's encrypted spaces that the holder holds but
// has not sealed yet for a contact's current public key (contacts without
// a key pair wait until they set one up; a new key version after a
// rotation is sealed too).
async function rewrapNeeded(holderId: string, spaces: SpaceFlags[]): Promise<EmergencyRewrap[]> {
  if (!spaces.length) return [];
  const contacts = await all<{ id: string; contact_id: string; public_key: string }>(
    "SELECT e.id,e.contact_id,i.public_key FROM emergency_contacts e JOIN e2ee_identities i ON i.user_id=e.contact_id WHERE e.holder_id=?",
    holderId,
  );
  const out: EmergencyRewrap[] = [];
  for (const c of contacts)
    for (const space of spaces) {
      const held = (await all<{ key_version: number }>("SELECT key_version FROM e2ee_space_keys WHERE space_id=? AND user_id=? ORDER BY key_version", space.id, holderId)).map(
        (r) => r.key_version,
      );
      const sealed = new Set(
        (await all<{ key_version: number }>("SELECT key_version FROM emergency_keys WHERE link_id=? AND space_id=? AND public_key=?", c.id, space.id, c.public_key)).map(
          (r) => r.key_version,
        ),
      );
      const versions = held.filter((v) => !sealed.has(v));
      if (versions.length) out.push({ linkId: c.id, contactId: c.contact_id, publicKey: c.public_key, spaceId: space.id, versions });
    }
  return out;
}

// ---- Commands (POST /api/command, action "emergency.*") ----

export const EMERGENCY_ACTIONS = [
  "emergency.designate",
  "emergency.accept",
  "emergency.leave",
  "emergency.remove",
  "emergency.request",
  "emergency.cancel",
  "emergency.deny",
  "emergency.revoke",
  "emergency.keys",
] as const;

const designateInput = z.object({
  email: z.string().trim().min(3).max(320),
  waitDays: z
    .number()
    .int()
    .refine((d) => (EMERGENCY_WAIT_DAYS as readonly number[]).includes(d), "Ungültige Eingabe.")
    .default(EMERGENCY_DEFAULT_WAIT),
  accessDays: z
    .number()
    .int()
    .refine((d) => (EMERGENCY_ACCESS_DAYS as readonly number[]).includes(d), "Ungültige Eingabe.")
    .nullable()
    .default(null),
});

export async function emergencyCommand(user: Identity, action: string, b: Record<string, unknown>): Promise<unknown> {
  requireSession(user);
  const now = Date.now();
  // Ending something never needs the feature: the holder can always remove,
  // deny and end, the contact always step down.
  if (!["emergency.remove", "emergency.deny", "emergency.revoke", "emergency.leave", "emergency.cancel"].includes(action)) await requireEnabled();
  if (action === "emergency.designate") return await designate(user, b, now);
  const linkId = uuid.parse(b.linkId);
  // One change of a link at a time (a request and a denial racing).
  await lockFor(`emergency:${linkId}`);
  const stored = await linkRow(linkId);
  if (!stored || (stored.holder_id !== user.id && stored.contact_id !== user.id)) throw new HttpError(404, "Nicht gefunden.");
  const link = (await emergencyEnabled()) ? await settle(stored, now) : stored;
  const asHolder = link.holder_id === user.id;
  const holder = (await person(link.holder_id))!,
    contact = (await person(link.contact_id))!;
  switch (action) {
    case "emergency.accept": {
      if (asHolder || link.status !== "invited") throw new HttpError(409, "Diese Einladung gibt es so nicht mehr.");
      await run("UPDATE emergency_contacts SET status='accepted',accepted_at=? WHERE id=? AND status='invited'", now, link.id);
      await record(user.id, "accept", link);
      await notify(holder.id, `${contact.name} ist jetzt deine Vertrauensperson für den Notfallzugriff.`);
      return { ok: true };
    }
    // The contact declines the invitation or gives up the role.
    case "emergency.leave": {
      if (asHolder) throw new HttpError(403, "Nicht erlaubt.");
      await endedAccess(link);
      await run("DELETE FROM emergency_contacts WHERE id=?", link.id);
      await record(user.id, "leave", link, link.status);
      await notify(
        holder.id,
        link.status === "invited"
          ? `${contact.name} hat die Rolle als Vertrauensperson abgelehnt.`
          : `${contact.name} ist nicht mehr deine Vertrauensperson für den Notfallzugriff.`,
      );
      return { ok: true };
    }
    case "emergency.remove": {
      if (!asHolder) throw new HttpError(403, "Nicht erlaubt.");
      await endedAccess(link);
      await run("DELETE FROM emergency_contacts WHERE id=?", link.id);
      await record(user.id, "remove", link, link.status);
      await notify(contact.id, `${holder.name} hat dich als Vertrauensperson entfernt.`);
      return { ok: true };
    }
    case "emergency.request": {
      if (asHolder) throw new HttpError(403, "Nicht erlaubt.");
      if (link.status === "invited") throw new HttpError(409, "Bitte nimm die Rolle als Vertrauensperson zuerst an.");
      if (link.status !== "accepted") throw new HttpError(409, "Es läuft bereits eine Anfrage.");
      if (link.denied_at && link.denied_at + EMERGENCY_DENY_COOLDOWN > now)
        throw new HttpError(429, "Die letzte Anfrage wurde abgelehnt. Eine neue ist frühestens nach 24 Stunden möglich.");
      if (!allow(`emergency-request:${user.id}`, 5, DAY)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
      const grantAt = now + link.wait_days * DAY;
      await run(
        "UPDATE emergency_contacts SET status='requested',requested_at=?,grant_at=?,granted_at=NULL,expires_at=NULL,reminded=0 WHERE id=? AND status='accepted'",
        now,
        grantAt,
        link.id,
      );
      await record(user.id, "request", link, `until ${new Date(grantAt).toISOString()}`);
      const requested = { ...link, status: "requested" as const, requested_at: now, grant_at: grantAt };
      const nid = await notify(
        holder.id,
        `${contact.name} hat Notfallzugriff auf deine Inhalte angefragt. Ohne Ablehnung bekommt ${contact.name} am ${when(grantAt)} Lesezugriff. Ablehnen unter Einstellungen → Konto & Sicherheit → Notfallzugriff.`,
      );
      if (await mailHolder(requested, holder, contact, "request")) await run("UPDATE notifications SET emailed_at=? WHERE id=?", nowText(), nid);
      return { ok: true, grantAt };
    }
    case "emergency.cancel": {
      if (asHolder) throw new HttpError(403, "Nicht erlaubt.");
      if (link.status !== "requested") throw new HttpError(409, "Es läuft keine Anfrage.");
      await run("UPDATE emergency_contacts SET status='accepted',requested_at=NULL,grant_at=NULL,reminded=0 WHERE id=? AND status='requested'", link.id);
      await record(user.id, "cancel", link);
      await notify(holder.id, `${contact.name} hat die Anfrage auf Notfallzugriff zurückgezogen.`);
      return { ok: true };
    }
    // The holder says no – to a request still waiting, or (too late for
    // that) to the access it became.
    case "emergency.deny":
    case "emergency.revoke": {
      if (!asHolder) throw new HttpError(403, "Nicht erlaubt.");
      if (link.status !== "requested" && link.status !== "granted") throw new HttpError(409, "Es läuft keine Anfrage und kein Zugriff.");
      return await endRequest(link, holder, contact, now);
    }
    case "emergency.keys":
      if (!asHolder) throw new HttpError(403, "Nicht erlaubt.");
      return await storeKeys(user, link, b, now);
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

async function designate(user: Identity, b: Record<string, unknown>, now: number) {
  const data = designateInput.parse(b);
  if (!allow(`emergency-designate:${user.id}`, 10, HOUR)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  await lockFor(`emergency-holder:${user.id}`);
  const matches = await all<Person>(
    "SELECT id,name,email,disabled,created_at FROM users WHERE lower(email)=lower(?) AND disabled=0 AND demo_until IS NULL AND subject NOT LIKE 'deleted:%' LIMIT 2",
    data.email,
  );
  // Several accounts with one address: none of them is meant for sure.
  if (matches.length !== 1) throw new HttpError(404, "Auf dieser Instanz gibt es kein Konto mit dieser E-Mail-Adresse.");
  const contact = matches[0];
  if (contact.id === user.id) throw new HttpError(400, "Du kannst dich nicht selbst als Vertrauensperson eintragen.");
  if (await one("SELECT 1 FROM emergency_contacts WHERE holder_id=? AND contact_id=?", user.id, contact.id))
    throw new HttpError(409, "Diese Person ist bereits deine Vertrauensperson.");
  const count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM emergency_contacts WHERE holder_id=?", user.id))?.n || 0);
  if (count >= EMERGENCY_MAX_CONTACTS) throw new HttpError(409, `Höchstens ${EMERGENCY_MAX_CONTACTS} Vertrauenspersonen.`);
  const linkId = id();
  await run(
    "INSERT INTO emergency_contacts(id,holder_id,contact_id,wait_days,access_days,status,created_at) VALUES(?,?,?,?,?,'invited',?)",
    linkId,
    user.id,
    contact.id,
    data.waitDays,
    data.accessDays,
    now,
  );
  const link = { id: linkId, holder_id: user.id, contact_id: contact.id };
  await record(user.id, "designate", link, `wait ${data.waitDays}d${data.accessDays ? ` access ${data.accessDays}d` : ""}`);
  await notify(
    contact.id,
    `${user.name} hat dich als Vertrauensperson für den Notfallzugriff eingetragen. Bitte bestätige das unter Einstellungen → Konto & Sicherheit → Notfallzugriff.`,
  );
  return { id: linkId };
}

async function endRequest(link: EmergencyLink, holder: Person, contact: Person, now: number, viaLink = false) {
  const granted = link.status === "granted";
  await endedAccess(link);
  await run(
    "UPDATE emergency_contacts SET status='accepted',requested_at=NULL,grant_at=NULL,granted_at=NULL,expires_at=NULL,reminded=0,denied_at=? WHERE id=?",
    granted ? link.denied_at : now,
    link.id,
  );
  await record(holder.id, granted ? "revoke" : "deny", link, viaLink ? "e-mail link" : "");
  await notify(contact.id, granted ? `${holder.name} hat deinen Notfallzugriff beendet.` : `${holder.name} hat deine Anfrage auf Notfallzugriff abgelehnt.`);
  return { ok: true, ended: granted ? "access" : "request" };
}

// Space keys of the holder's encrypted spaces, sealed in the holder's
// browser for the contact's public key. The server checks what it can:
// the space is one of the holder's emergency spaces, the holder holds that
// key version, the contact's key is the one named, the format is right. It
// never sees a key it could open.
const keysInput = z.object({
  publicKey: z.string().max(100),
  keys: z.array(z.object({ spaceId: uuid, version: z.number().int().min(1), sealed: sealedKey })).min(1).max(1000),
});
async function storeKeys(user: Identity, link: EmergencyLink, b: Record<string, unknown>, now: number) {
  const data = keysInput.parse(b);
  const identity = await one<{ public_key: string }>("SELECT public_key FROM e2ee_identities WHERE user_id=?", link.contact_id);
  if (!identity) throw new HttpError(409, "Diese Person hat die Verschlüsselung noch nicht eingerichtet.");
  if (identity.public_key !== data.publicKey) throw new HttpError(409, "Die Schlüssel der Vertrauensperson haben sich geändert. Bitte neu laden.");
  const spaces = new Set((await emergencySpaces(user.id)).filter((s) => s.encrypted).map((s) => s.id));
  for (const key of data.keys) {
    if (!spaces.has(key.spaceId)) throw new HttpError(403, "Kein Zugriff auf Bereich.");
    if (!(await one("SELECT 1 FROM e2ee_space_keys WHERE space_id=? AND user_id=? AND key_version=?", key.spaceId, user.id, key.version)))
      throw new HttpError(409, "Die Schlüssel des Bereichs wurden inzwischen geändert. Bitte neu laden.");
  }
  for (const key of data.keys)
    await run(
      "INSERT INTO emergency_keys(link_id,space_id,key_version,sealed,public_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(link_id,space_id,key_version) DO UPDATE SET sealed=excluded.sealed,public_key=excluded.public_key,created_at=excluded.created_at",
      link.id,
      key.spaceId,
      key.version,
      JSON.stringify(key.sealed),
      data.publicKey,
      now,
    );
  // In the activity log only: the keys stay closed until access is granted.
  await audit(user.id, "emergency.keys", link.id, `holder:${link.holder_id} contact:${link.contact_id} ${data.keys.length}`);
  return { ok: true, stored: data.keys.length };
}

// ---- Granted by the holder's inactivity message (#282) ----

// The holder's inactivity message went out and its owner chose "Notfallzugriff
// für meine Vertrauenspersonen sofort freigeben" (lib/dead-man-switch.ts):
// every trusted contact who accepted the role gets access now, without their
// waiting period – a request still waiting included. Only contacts who
// accepted at least their own waiting period before: one named and accepted
// shortly before (say, after an account takeover) is not let in faster than
// a request of theirs would be. The reason is in the activity log
// ("deadman:<switch>"); the holder can end each access as usual.
export async function grantForInactivity(holderId: string, switchId: string, now = Date.now()) {
  if (!(await emergencyEnabled())) return [] as string[];
  const holder = await person(holderId);
  if (!holder) return [];
  const names: string[] = [];
  for (const link of await all<EmergencyLink>(
    "SELECT * FROM emergency_contacts WHERE holder_id=? AND status IN ('accepted','requested') ORDER BY created_at,id",
    holderId,
  )) {
    if (link.accepted_at === null || link.accepted_at > now - link.wait_days * DAY) continue;
    await lockFor(`emergency:${link.id}`);
    const changed = await run(
      "UPDATE emergency_contacts SET status='granted',requested_at=COALESCE(requested_at,?),grant_at=?,granted_at=?,expires_at=?,reminded=0 WHERE id=? AND status IN ('accepted','requested')",
      now,
      now,
      now,
      link.access_days ? now + link.access_days * DAY : null,
      link.id,
    );
    if (!changed.changes) continue;
    const contact = await person(link.contact_id);
    await record(holderId, "grant", link, `deadman:${switchId}`);
    if (!contact) continue;
    await notify(
      holder.id,
      `${contact.name} hat jetzt Lesezugriff auf deine Inhalte (Notfallzugriff). Beenden unter Einstellungen → Konto & Sicherheit → Notfallzugriff.`,
    );
    await notify(contact.id, `Dein Notfallzugriff auf die Inhalte von ${holder.name} ist freigegeben.`);
    names.push(contact.name);
  }
  return names;
}
// Trusted contacts who accepted the role (for the settings of #282).
export async function acceptedContacts(holderId: string) {
  return Number((await one<{ n: number }>("SELECT COUNT(*) n FROM emergency_contacts WHERE holder_id=? AND status<>'invited'", holderId))?.n || 0);
}

// ---- Denying from the e-mail (no sign-in needed) ----

// The link of one request: signed with the instance's key over the link and
// the moment it was asked for – a new request needs a new link, and once
// the request ended the link does nothing.
export function denyToken(link: Pick<EmergencyLink, "id" | "requested_at">) {
  const data = `${link.id}.${link.requested_at}`;
  return `${data}.${signValue(DENY_PURPOSE, data)}`;
}
async function linkOfToken(token: string) {
  const m = /^([0-9a-f-]{36})\.(\d{1,16})\.([\w-]{20,100})$/.exec(token.trim());
  if (!m || !validSignature(DENY_PURPOSE, `${m[1]}.${m[2]}`, m[3])) return null;
  const link = await linkRow(m[1]);
  if (!link || link.requested_at !== Number(m[2]) || (link.status !== "requested" && link.status !== "granted")) return null;
  return link;
}
// The confirmation page asks first (scanners of mail links only open it).
export async function denyPreview(token: string) {
  const link = await linkOfToken(token);
  if (!link) return null;
  const contact = await person(link.contact_id);
  return { contact: contact?.name || "", locale: await userLocale(link.holder_id), status: effectiveStatus(link) };
}
export async function denyWithToken(token: string) {
  return await transaction(async () => {
    const found = await linkOfToken(token);
    if (!found) return null;
    await lockFor(`emergency:${found.id}`);
    const link = await settle((await linkRow(found.id))!);
    if (link.status !== "requested" && link.status !== "granted") return null;
    const holder = (await person(link.holder_id))!,
      contact = (await person(link.contact_id))!;
    return { ...(await endRequest(link, holder, contact, Date.now(), true)), locale: await userLocale(holder.id) };
  });
}

// The e-mail to the holder with the link to deny: at once, not in the
// digest 10 minutes later, and whatever the e-mail setting says – the
// account is at stake.
async function mailHolder(link: EmergencyLink, holder: Person, contact: Person, kind: "request" | "reminder") {
  if (!mailConfig() || !/^[^\s@]+@[^\s@]+$/.test(holder.email)) return false;
  const locale = await userLocale(holder.id);
  const t = translate(locale);
  const url = `${mailAppUrl()}/api/emergency/deny?token=${encodeURIComponent(denyToken(link))}`;
  const date = when(link.grant_at!);
  const subject =
    kind === "request"
      ? t(`${contact.name} hat Notfallzugriff auf deine Inhalte angefragt`, `${contact.name} asked for emergency access to your content`)
      : t(`Erinnerung: Notfallzugriff für ${contact.name} ab ${date}`, `Reminder: emergency access for ${contact.name} from ${date}`);
  const lines = [
    t(`Hallo ${holder.name},`, `Hello ${holder.name},`),
    t(
      `${contact.name} hat als deine Vertrauensperson Notfallzugriff angefragt. Lehnst du nicht ab, kann ${contact.name} ab ${date} deine privaten Bereiche lesen und exportieren (nichts ändern oder löschen).`,
      `${contact.name}, your trusted contact, asked for emergency access. Unless you deny it, ${contact.name} can read and export your private spaces from ${date} (not change or delete anything).`,
    ),
    t(
      "Warst du das nicht oder brauchst du keine Hilfe? Lehne mit dem Knopf ab – ohne Anmeldung. In Flowplan geht es unter Einstellungen → Konto & Sicherheit → Notfallzugriff.",
      "Didn't expect this or don't need help? Deny with the button – no sign-in needed. In Flowplan: Settings → Account & security → Emergency access.",
    ),
  ];
  const label = t("Anfrage ablehnen", "Deny the request");
  const text = `${lines.join("\n\n")}\n\n${label}: ${url}\n`;
  return await queueMail(holder.email, subject, text, await mailLayout(subject, lines.map(mailEscape), { label, url }, locale));
}

// ---- The worker: grants, ends, reminders ----

export async function processEmergency(now = Date.now()) {
  if (!(await emergencyEnabled())) return 0;
  let changed = 0;
  for (const link of await all<EmergencyLink>(
    "SELECT * FROM emergency_contacts WHERE (status='requested' AND grant_at<=?) OR (status='granted' AND expires_at IS NOT NULL AND expires_at<=?)",
    now,
    now,
  ))
    await transaction(async () => {
      await lockFor(`emergency:${link.id}`);
      const current = await linkRow(link.id);
      if (current && effectiveStatus(current, now) !== current.status) {
        await settle(current, now);
        changed++;
      }
    });
  // Reminders: halfway through the waiting period and a day before its end
  // (bit 1 and bit 2 of `reminded`); one that would come within an hour of
  // the request or of the other is left out.
  for (const link of await all<EmergencyLink>("SELECT * FROM emergency_contacts WHERE status='requested' AND grant_at>?", now)) {
    const start = link.requested_at!,
      end = link.grant_at!;
    const half = start + (end - start) / 2,
      dayBefore = end - DAY;
    let due = 0;
    if (now >= half && !(link.reminded & 1)) due |= 1;
    if (now >= dayBefore && dayBefore - start >= HOUR && Math.abs(dayBefore - half) >= HOUR && !(link.reminded & 2)) due |= 2;
    if (!due) continue;
    await transaction(async () => {
      const marked = await run("UPDATE emergency_contacts SET reminded=? WHERE id=? AND status='requested' AND reminded=?", link.reminded | due, link.id, link.reminded);
      if (!marked.changes) return;
      const holder = await person(link.holder_id),
        contact = await person(link.contact_id);
      if (!holder || !contact) return;
      await record(link.contact_id, "remind", link, due & 2 ? "day before" : "halfway");
      const nid = await notify(
        holder.id,
        `Erinnerung: ${contact.name} bekommt am ${when(end)} Lesezugriff auf deine Inhalte (Notfallzugriff), wenn du nicht ablehnst.`,
      );
      if (await mailHolder(link, holder, contact, "reminder")) await run("UPDATE notifications SET emailed_at=? WHERE id=?", nowText(), nid);
      changed++;
    });
  }
  return changed;
}

const runtime = globalThis as unknown as { flowplanEmergencyTimer?: ReturnType<typeof setInterval> };
export function startEmergencyWorker(onChanged: () => void = () => {}) {
  if (runtime.flowplanEmergencyTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      if (await processEmergency()) onChanged();
    } catch (error) {
      console.error("Notfallzugriff: Prüfung fehlgeschlagen", error);
    }
  };
  runtime.flowplanEmergencyTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanEmergencyTimer.unref();
  setTimeout(tick, 20_000).unref();
}
