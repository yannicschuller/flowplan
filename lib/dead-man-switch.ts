// Inactivity message per workspace ("dead man's switch", #282). A full
// member of a workspace (no guest) writes a note and names up to ten e-mail
// addresses (no account needed). When the account – or, if chosen, this
// workspace – has not been used for the chosen period (30 to 365 days),
// Flowplan sends the note once to each address: a plain e-mail from the
// instance, sender "<Name> via Flowplan (<instance>)", a footer that says
// what this is, nothing from the workspace but the note, no tracking.
//
// Safeguards:
// - Warnings to the holder 7, 3 and 1 day before (in-app, push, chat apps
//   and an e-mail sent right away) with an "Ich bin da" link: signed, works
//   without sign-in, single-use (bound to the last explicit check-in) and
//   expiring. The link's page asks first – mail scanners only open it.
// - Never sent without the last warning a day before: after a pause of the
//   worker (or the feature, or mail delivery) the message waits for a
//   warning and one more day.
// - Sent once per arming (the state changes to 'fired' in the same
//   transaction as the queued mails); the next sign of life re-arms it and
//   tells the holder when and to whom it went.
// - Recipients and note are changed only in the signed-in browser (no API
//   token, no demo); every change of them is mailed to the holder at once.
// - Limits: 3 switches per person, 10 recipients, 5000 characters, at most
//   20 changes an hour, at most DEADMAN_FIRES_PER_ROUND sendings per worker
//   round for the whole instance.
// - Available only with e-mail delivery (SMTP_HOST) and while the
//   administration allows it (instance setting deadManSwitch,
//   FLOWPLAN_DEAD_MAN_SWITCH=off wins).
//
// A sign of life: by default any use of the account – a sign-in or use of
// the open app (users.last_login_at, last_active_at; lib/user-activity.ts)
// – or, if chosen, only use of this workspace (workspace_activity). An
// explicit check-in ("Ich bin da", saving the switch) counts for both.
// Passive signals do not count: a tab left open in the background, apps
// refreshing widgets, API tokens and scripts – they would keep the switch
// from ever going off.
//
// A disabled account (by the administration, or for inactivity): its
// switches keep running and go off – inactivity is the point, and emergency
// access (#281) also keeps running for disabled accounts. An administration
// that suspects a takeover switches the feature off for the instance or
// deletes the switch's account. An account deleted for inactivity
// (lib/inactive-accounts.ts) sends its armed messages right before the
// deletion – they would never go out otherwise.
//
// #281 coupling: "Notfallzugriff für meine Vertrauenspersonen sofort
// freigeben" grants the holder's accepted trusted contacts access when the
// message goes out (lib/emergency-access.ts grantForInactivity), only while
// emergency access is on for the instance.
//
// Every step is in the activity log and a security event (deadman.*; going
// off and a change of recipients are warnings). Times are UTC milliseconds.
import { z } from "zod";
import { all, audit, id, lockFor, nowText, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { instanceSettings } from "./instance-settings";
import { signValue, validSignature } from "./secret-box";
import { mailAppUrl, mailConfig, mailEscape, mailLayout, queueMail } from "./mail";
import { userLocale } from "./user-locale";
import { translate, type Locale } from "./i18n";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import {
  DEADMAN_DEFAULT_PERIOD,
  DEADMAN_MAX_NOTE,
  DEADMAN_MAX_RECIPIENTS,
  DEADMAN_MAX_SWITCHES,
  DEADMAN_PERIOD_DAYS,
  DEADMAN_WARNING_DAYS,
  type DeadmanOverview,
  type DeadmanPreview,
  type DeadmanSource,
  type DeadmanView,
} from "./dead-man-kinds";
import type { Identity } from "./types";

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
export const DEADMAN_LINK = "#settings/account/deadman";
// Sendings per worker round (every five minutes) for the whole instance.
export const DEADMAN_FIRES_PER_ROUND = 10;
// How long an "Ich bin da" link works.
export const DEADMAN_LINK_DAYS = 10;
const HERE_PURPOSE = "deadman-here";
// The bit of each warning in `warned` (7 → 1, 3 → 2, 1 → 4).
const LAST_WARNING = 1 << (DEADMAN_WARNING_DAYS.length - 1);

export type SwitchRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  enabled: number;
  period_days: number;
  note: string;
  recipients: string;
  source: DeadmanSource;
  grant_emergency: number;
  state: "armed" | "fired";
  checkin_at: number;
  warned: number;
  warned_at: number | null;
  fired_at: number | null;
  fired_to: string | null;
  created_at: number;
  updated_at: number;
};
type Person = { id: string; name: string; email: string; disabled: number };

const uuid = z.string().uuid();
const person = async (userId: string) => await one<Person>("SELECT id,name,email,disabled FROM users WHERE id=?", userId);
const switchRow = async (switchId: string) => await one<SwitchRow>("SELECT * FROM deadman_switches WHERE id=?", switchId);
const workspaceName = async (workspaceId: string) => (await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", workspaceId))?.name || "";
const list = (json: string | null) => {
  try {
    const value = JSON.parse(json || "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const instanceHost = () => {
  try {
    return new URL(mailAppUrl()).host;
  } catch {
    return mailAppUrl();
  }
};

// ---- The switch of the instance ----

export const deadmanForcedOff = () => /^(off|false|0|no)$/i.test(process.env.FLOWPLAN_DEAD_MAN_SWITCH?.trim() || "");
export async function deadmanEnabled() {
  if (deadmanForcedOff()) return false;
  return (await instanceSettings()).deadManSwitch !== false;
}
// Usable: allowed and e-mail delivery set up.
export async function deadmanAvailable() {
  return !!mailConfig() && (await deadmanEnabled());
}
function requireSession(user: Identity) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
}
async function requireAvailable() {
  if (!(await deadmanEnabled())) throw new HttpError(403, "Die Nachricht bei Inaktivität ist auf dieser Instanz ausgeschaltet.");
  if (!mailConfig()) throw new HttpError(409, "Für die Nachricht bei Inaktivität muss der E-Mail-Versand eingerichtet sein.");
}
// A full member of the workspace: no guest.
async function fullMember(userId: string, workspaceId: string) {
  return !!(await one(
    "SELECT 1 FROM members m WHERE m.workspace_id=? AND m.user_id=? AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)",
    workspaceId,
    userId,
  ));
}

// ---- Time ----

// The last use that counts for the switch (without explicit check-ins).
export async function lastUse(row: Pick<SwitchRow, "user_id" | "workspace_id" | "source">) {
  if (row.source === "workspace")
    return Number((await one<{ at: number }>("SELECT at FROM workspace_activity WHERE user_id=? AND workspace_id=?", row.user_id, row.workspace_id))?.at || 0);
  const u = await one<{ login: number | null; active: number | null }>("SELECT last_login_at login,last_active_at active FROM users WHERE id=?", row.user_id);
  return Math.max(Number(u?.login || 0), Number(u?.active || 0));
}

// Where an armed switch stands at `now`, given its last sign of life:
// warnings that a sign of life made void count as not sent.
export function schedule(row: Pick<SwitchRow, "period_days" | "warned" | "warned_at">, last: number, now: number) {
  const deadline = last + row.period_days * DAY;
  const warned = deadline - now > DEADMAN_WARNING_DAYS[0] * DAY ? 0 : row.warned;
  // Never before the last warning plus a day.
  const fireAt = warned & LAST_WARNING && row.warned_at ? Math.max(deadline, row.warned_at + DAY) : Math.max(deadline, now + DAY);
  let nextWarningAt: number | null = null;
  DEADMAN_WARNING_DAYS.forEach((days, i) => {
    if (nextWarningAt === null && !(warned & (1 << i))) nextWarningAt = Math.max(now, deadline - days * DAY);
  });
  // The warnings that are due now (bits) and the one to send (the latest).
  let due = 0;
  DEADMAN_WARNING_DAYS.forEach((days, i) => {
    if (deadline - now <= days * DAY && !(warned & (1 << i))) due |= 1 << i;
  });
  return { deadline, warned, fireAt, nextWarningAt, due, fireNow: !!(warned & LAST_WARNING) && now >= fireAt };
}

// ---- Overview ----

function view(row: SwitchRow, last: number, now: number): DeadmanView {
  const on = !!row.enabled;
  const s = schedule(row, last, now);
  return {
    id: row.id,
    state: !on ? "off" : row.state,
    periodDays: row.period_days,
    note: row.note,
    recipients: list(row.recipients),
    source: row.source,
    grantEmergency: !!row.grant_emergency,
    lastCheckin: last,
    nextWarningAt: on && row.state === "armed" ? s.nextWarningAt : null,
    fireAt: on && row.state === "armed" ? s.fireAt : null,
    firedAt: row.fired_at,
    firedTo: list(row.fired_to),
  };
}

export async function deadmanOverview(user: Identity, now = Date.now()): Promise<DeadmanOverview> {
  requireSession(user);
  const enabled = await deadmanEnabled();
  const mail = !!mailConfig();
  // Coming back re-arms what went off (the holder is here, after all).
  for (const row of await all<SwitchRow>("SELECT * FROM deadman_switches WHERE user_id=? AND enabled=1", user.id))
    await transaction(async () => await settleSignOfLife(row.id, now));
  const { emergencyEnabled, acceptedContacts } = await import("./emergency-access");
  const workspaces = await all<{ id: string; name: string; icon: string | null }>(
    `SELECT w.id,w.name,w.icon FROM workspaces w JOIN members m ON m.workspace_id=w.id AND m.user_id=?
     WHERE NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=w.id AND g.user_id=m.user_id) ORDER BY w.name,w.id`,
    user.id,
  );
  const rows = new Map((await all<SwitchRow>("SELECT * FROM deadman_switches WHERE user_id=?", user.id)).map((r) => [r.workspace_id, r]));
  const out: DeadmanOverview["workspaces"] = [];
  for (const w of workspaces) {
    const row = rows.get(w.id);
    out.push({ workspaceId: w.id, name: w.name, icon: w.icon || "", switch: row ? view(row, Math.max(row.checkin_at, await lastUse(row)), now) : null });
  }
  return {
    available: enabled && mail,
    mail,
    enabled,
    forcedOff: deadmanForcedOff(),
    emergency: await emergencyEnabled(),
    trustedContacts: await acceptedContacts(user.id),
    workspaces: out,
  };
}

// ---- Commands (POST /api/command, action "deadman.*", session only) ----

export const DEADMAN_ACTIONS = ["deadman.save", "deadman.remove", "deadman.checkin", "deadman.preview"] as const;

const email = z
  .string()
  .max(320)
  .transform((v) => v.trim().toLowerCase());
const saveInput = z.object({
  workspaceId: uuid,
  enabled: z.boolean(),
  periodDays: z
    .number()
    .int()
    .refine((d) => (DEADMAN_PERIOD_DAYS as readonly number[]).includes(d), "Ungültige Eingabe.")
    .default(DEADMAN_DEFAULT_PERIOD),
  note: z.string().max(4 * DEADMAN_MAX_NOTE).default(""),
  recipients: z.array(email).max(100).default([]),
  source: z.enum(["account", "workspace"]).default("account"),
  grantEmergency: z.boolean().default(false),
});
type SaveInput = z.infer<typeof saveInput>;
function validated(b: Record<string, unknown>): SaveInput {
  const data = saveInput.parse(b);
  const recipients = [...new Set(data.recipients.filter(Boolean))];
  for (const address of recipients)
    if (address.length > 254 || !z.email().safeParse(address).success) throw new HttpError(400, `Ungültige E-Mail-Adresse: ${address.slice(0, 80)}`);
  if (recipients.length > DEADMAN_MAX_RECIPIENTS) throw new HttpError(400, `Höchstens ${DEADMAN_MAX_RECIPIENTS} Empfänger.`);
  const note = data.note.replace(/\r\n?/g, "\n").trim();
  if (note.length > DEADMAN_MAX_NOTE) throw new HttpError(400, `Die Notiz darf höchstens ${DEADMAN_MAX_NOTE} Zeichen lang sein.`);
  if (data.enabled && (!note || !recipients.length)) throw new HttpError(400, "Bitte gib eine Notiz und mindestens einen Empfänger an.");
  return { ...data, note, recipients };
}

export async function deadmanCommand(user: Identity, action: string, b: Record<string, unknown>, now = Date.now()): Promise<unknown> {
  requireSession(user);
  switch (action) {
    case "deadman.save":
      return await save(user, b, now);
    case "deadman.remove": {
      const workspaceId = uuid.parse(b.workspaceId);
      await lockFor(`deadman-user:${user.id}`);
      const row = await one<SwitchRow>("SELECT * FROM deadman_switches WHERE user_id=? AND workspace_id=?", user.id, workspaceId);
      if (!row) return { ok: true };
      await run("DELETE FROM deadman_switches WHERE id=?", row.id);
      await audit(user.id, "deadman.disarm", row.id, `workspace:${workspaceId} removed`);
      return { ok: true };
    }
    case "deadman.checkin": {
      const workspaceId = b.workspaceId === undefined ? null : uuid.parse(b.workspaceId);
      const rows = await all<SwitchRow>(
        `SELECT * FROM deadman_switches WHERE user_id=? AND enabled=1${workspaceId ? " AND workspace_id=?" : ""}`,
        ...(workspaceId ? [user.id, workspaceId] : [user.id]),
      );
      for (const row of rows) await checkIn(row, now, "button");
      return { ok: true, count: rows.length };
    }
    case "deadman.preview": {
      if (!allow(`deadman-preview:${user.id}`, 60, HOUR)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
      const data = validated({ ...b, enabled: false });
      if (!(await fullMember(user.id, data.workspaceId))) throw new HttpError(403, "Nur Mitglieder eines Arbeitsbereichs (keine Gäste) können eine Nachricht bei Inaktivität einrichten.");
      const holder = (await person(user.id))!;
      const mail = await recipientMail(holder, data.note, data.periodDays, await userLocale(user.id), "inactive");
      return { from: mail.from, to: data.recipients, subject: mail.subject, text: mail.text } satisfies DeadmanPreview;
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

async function save(user: Identity, b: Record<string, unknown>, now: number) {
  const data = validated(b);
  if (!allow(`deadman-save:${user.id}`, 20, HOUR)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  if (data.enabled) await requireAvailable();
  await lockFor(`deadman-user:${user.id}`);
  if (!(await fullMember(user.id, data.workspaceId)))
    throw new HttpError(403, "Nur Mitglieder eines Arbeitsbereichs (keine Gäste) können eine Nachricht bei Inaktivität einrichten.");
  const before = await one<SwitchRow>("SELECT * FROM deadman_switches WHERE user_id=? AND workspace_id=?", user.id, data.workspaceId);
  if (!before) {
    const count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM deadman_switches WHERE user_id=?", user.id))?.n || 0);
    if (count >= DEADMAN_MAX_SWITCHES) throw new HttpError(409, `Höchstens ${DEADMAN_MAX_SWITCHES} Nachrichten bei Inaktivität.`);
  }
  const recipients = JSON.stringify(data.recipients);
  const switchId = before?.id || id();
  // Saving is a sign of life: the period starts again, a message that went
  // out is armed again.
  if (before)
    await run(
      "UPDATE deadman_switches SET enabled=?,period_days=?,note=?,recipients=?,source=?,grant_emergency=?,state='armed',checkin_at=?,warned=0,warned_at=NULL,updated_at=? WHERE id=?",
      data.enabled ? 1 : 0,
      data.periodDays,
      data.note,
      recipients,
      data.source,
      data.grantEmergency ? 1 : 0,
      now,
      now,
      switchId,
    );
  else
    await run(
      "INSERT INTO deadman_switches(id,user_id,workspace_id,enabled,period_days,note,recipients,source,grant_emergency,state,checkin_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'armed',?,?,?)",
      switchId,
      user.id,
      data.workspaceId,
      data.enabled ? 1 : 0,
      data.periodDays,
      data.note,
      recipients,
      data.source,
      data.grantEmergency ? 1 : 0,
      now,
      now,
      now,
    );
  const old = list(before?.recipients ?? "[]");
  const recipientsChanged = [...old].sort().join() !== [...data.recipients].sort().join();
  const noteChanged = (before?.note ?? "") !== data.note;
  const wasOn = !!before?.enabled;
  const detail = `workspace:${data.workspaceId} period:${data.periodDays}d source:${data.source}${data.grantEmergency ? " emergency" : ""}`;
  if (data.enabled && !wasOn) await audit(user.id, "deadman.arm", switchId, detail);
  if (!data.enabled && wasOn) await audit(user.id, "deadman.disarm", switchId, detail);
  if (recipientsChanged) await audit(user.id, "deadman.recipients", switchId, `workspace:${data.workspaceId} recipients:${old.length}→${data.recipients.length}`);
  if (
    before &&
    (noteChanged ||
      before.period_days !== data.periodDays ||
      before.source !== data.source ||
      !!before.grant_emergency !== data.grantEmergency) &&
    data.enabled === wasOn
  )
    await audit(user.id, "deadman.change", switchId, `${detail}${noteChanged ? " note" : ""}`);
  if (before?.state === "fired" && data.enabled) await audit(user.id, "deadman.rearm", switchId, `workspace:${data.workspaceId} saved`);
  // Recipients or note changed: the holder hears of it by e-mail at once –
  // after an account takeover that is where they would notice.
  if (recipientsChanged || noteChanged) await changedMail(user.id, data.workspaceId, old, data.recipients, recipientsChanged, noteChanged);
  return { id: switchId };
}

// An explicit sign of life: the period starts again, a message that went
// out is armed again.
async function checkIn(row: SwitchRow, now: number, how: string) {
  await lockFor(`deadman:${row.id}`);
  if (row.state === "fired") return await rearm(row, now, how);
  await run("UPDATE deadman_switches SET checkin_at=?,warned=0,warned_at=NULL WHERE id=? AND state='armed'", now, row.id);
  await audit(row.user_id, "deadman.checkin", row.id, `workspace:${row.workspace_id} ${how}`);
  return true;
}
async function rearm(row: SwitchRow, now: number, how: string) {
  const changed = await run(
    "UPDATE deadman_switches SET state='armed',checkin_at=?,warned=0,warned_at=NULL,updated_at=? WHERE id=? AND state='fired'",
    now,
    now,
    row.id,
  );
  if (!changed.changes) return false;
  await audit(row.user_id, "deadman.rearm", row.id, `workspace:${row.workspace_id} ${how}`);
  const to = list(row.fired_to).join(", ");
  await notify(
    row.user_id,
    `Deine Nachricht bei Inaktivität für „${await workspaceName(row.workspace_id)}“ wurde am ${when(row.fired_at || now)} an ${to} verschickt. Sie ist jetzt wieder eingeschaltet.`,
  );
  return true;
}

// Use since the message went out re-arms it; use since a warning voids the
// warnings. Returns whether something changed.
async function settleSignOfLife(switchId: string, now: number) {
  await lockFor(`deadman:${switchId}`);
  const row = await switchRow(switchId);
  if (!row || !row.enabled) return false;
  const use = await lastUse(row);
  if (row.state === "fired") return row.fired_at !== null && use > row.fired_at ? await rearm(row, now, "use") : false;
  if (row.warned && schedule(row, Math.max(row.checkin_at, use), now).warned === 0) {
    const changed = await run("UPDATE deadman_switches SET warned=0,warned_at=NULL WHERE id=? AND warned=?", row.id, row.warned);
    if (changed.changes) await audit(row.user_id, "deadman.checkin", row.id, `workspace:${row.workspace_id} use`);
    return !!changed.changes;
  }
  return false;
}

async function notify(userId: string, body: string) {
  const nid = id();
  await run("INSERT INTO notifications(id,user_id,body,kind,link) VALUES(?,?,?,'security',?)", nid, userId, body, DEADMAN_LINK);
  return nid;
}
const markEmailed = async (nid: string) => await run("UPDATE notifications SET emailed_at=? WHERE id=?", nowText(), nid);

// ---- The "Ich bin da" link (no sign-in needed) ----

// Signed over the switch, its last explicit check-in and the end of its
// validity: using it is a check-in, so it works once.
export function hereToken(row: Pick<SwitchRow, "id" | "checkin_at">, now = Date.now()) {
  const data = `${row.id}.${row.checkin_at}.${now + DEADMAN_LINK_DAYS * DAY}`;
  return `${data}.${signValue(HERE_PURPOSE, data)}`;
}
async function switchOfToken(token: string, now: number) {
  const m = /^([0-9a-f-]{36})\.(\d{1,16})\.(\d{1,16})\.([\w-]{20,100})$/.exec(token.trim());
  if (!m || !validSignature(HERE_PURPOSE, `${m[1]}.${m[2]}.${m[3]}`, m[4]) || Number(m[3]) <= now) return null;
  const row = await switchRow(m[1]);
  if (!row || !row.enabled || row.state !== "armed" || row.checkin_at !== Number(m[2])) return null;
  return row;
}
export async function herePreview(token: string, now = Date.now()) {
  const row = await switchOfToken(token, now);
  if (!row) return null;
  return { workspace: await workspaceName(row.workspace_id), locale: await userLocale(row.user_id) };
}
export async function hereWithToken(token: string, now = Date.now()) {
  return await transaction(async () => {
    const found = await switchOfToken(token, now);
    if (!found) return null;
    if (!allow(`deadman-here:${found.id}`, 10, HOUR)) return null;
    await lockFor(`deadman:${found.id}`);
    const row = await switchRow(found.id);
    if (!row || row.checkin_at !== found.checkin_at || row.state !== "armed") return null;
    await checkIn(row, now, "e-mail link");
    return { workspace: await workspaceName(row.workspace_id), locale: await userLocale(row.user_id), fireAt: now + row.period_days * DAY };
  });
}

// ---- The e-mails ----

// The message to a recipient: the note as written, the sender named, a
// footer that says what this is. No links, images or tracking.
async function recipientMail(holder: Person, note: string, periodDays: number, locale: Locale, reason: "inactive" | "deletion") {
  const t = translate(locale);
  const host = instanceHost();
  const from = `${holder.name} via Flowplan (${host})`;
  const subject = t(`Eine Nachricht von ${holder.name}`, `A message from ${holder.name}`);
  const footer =
    reason === "deletion"
      ? t(
          `Diese Nachricht hat ${holder.name} in Flowplan (${host}) für den Fall hinterlegt, dass das Konto ${periodDays} Tage lang nicht genutzt wird. Flowplan hat sie jetzt automatisch verschickt, weil das Konto wegen Inaktivität gelöscht wird. Du bekommst sie, weil ${holder.name} deine Adresse als Empfänger eingetragen hat. Sie wird nur einmal verschickt; du musst nichts tun. Fragen zum Konto beantwortet die Administration von ${host}.`,
          `${holder.name} left this message in Flowplan (${host}) for the case that the account is not used for ${periodDays} days. Flowplan sent it automatically now because the account is being deleted for inactivity. You get it because ${holder.name} added your address as a recipient. It is sent only once; you need not do anything. Questions about the account go to the administrators of ${host}.`,
        )
      : t(
          `Diese Nachricht hat ${holder.name} in Flowplan (${host}) für den Fall hinterlegt, dass das Konto ${periodDays} Tage lang nicht genutzt wird. Flowplan hat sie jetzt automatisch verschickt, weil das eingetreten ist. Du bekommst sie, weil ${holder.name} deine Adresse als Empfänger eingetragen hat. Sie wird nur einmal verschickt; du musst nichts tun. Fragen zum Konto beantwortet die Administration von ${host}.`,
          `${holder.name} left this message in Flowplan (${host}) for the case that the account is not used for ${periodDays} days. Flowplan sent it automatically now because that has happened. You get it because ${holder.name} added your address as a recipient. It is sent only once; you need not do anything. Questions about the account go to the administrators of ${host}.`,
        );
  const text = `${note}\n\n-- \n${footer}\n`;
  const paragraphs = note
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;white-space:pre-wrap">${mailEscape(p)}</p>`)
    .join("");
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#ffffff;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1c22"><div style="max-width:560px;margin:0 auto;padding:28px 20px"><h1 style="font-size:19px;margin:0 0 16px">${mailEscape(subject)}</h1>${paragraphs}<p style="margin:28px 0 0;padding-top:14px;border-top:1px solid #e4e1da;font-size:12px;color:#6f6b76">${mailEscape(footer)}</p></div></body></html>`;
  return { from, subject, text, html };
}

async function holderMail(holder: Person, subject: string, lines: string[], action?: { label: string; url: string }) {
  if (!/^[^\s@]+@[^\s@]+$/.test(holder.email)) return false;
  const locale = await userLocale(holder.id);
  const text = `${lines.join("\n\n")}${action ? `\n\n${action.label}: ${action.url}` : ""}\n`;
  return await queueMail(holder.email, subject, text, await mailLayout(subject, lines.map(mailEscape), action, locale));
}

async function changedMail(userId: string, workspaceId: string, old: string[], now: string[], recipientsChanged: boolean, noteChanged: boolean) {
  const holder = await person(userId);
  if (!holder) return;
  const ws = await workspaceName(workspaceId);
  const t = translate(await userLocale(userId));
  const nid = await notify(
    userId,
    recipientsChanged
      ? `Die Empfänger deiner Nachricht bei Inaktivität für „${ws}“ wurden geändert: ${now.join(", ") || "–"}.`
      : `Die Notiz deiner Nachricht bei Inaktivität für „${ws}“ wurde geändert.`,
  );
  const subject = recipientsChanged
    ? t("Die Empfänger deiner Nachricht bei Inaktivität wurden geändert", "The recipients of your inactivity message changed")
    : t("Deine Nachricht bei Inaktivität wurde geändert", "Your inactivity message changed");
  const lines = [
    t(`Hallo ${holder.name},`, `Hello ${holder.name},`),
    recipientsChanged
      ? t(
          `die Empfänger deiner Nachricht bei Inaktivität für „${ws}“ wurden eben geändert. Jetzt: ${now.join(", ") || "niemand"}. Vorher: ${old.join(", ") || "niemand"}.`,
          `the recipients of your inactivity message for “${ws}” were just changed. Now: ${now.join(", ") || "nobody"}. Before: ${old.join(", ") || "nobody"}.`,
        )
      : t(`die Notiz deiner Nachricht bei Inaktivität für „${ws}“ wurde eben geändert.`, `the note of your inactivity message for “${ws}” was just changed.`),
    ...(recipientsChanged && noteChanged ? [t("Auch die Notiz wurde geändert.", "The note was changed as well.")] : []),
    t(
      "Warst du das nicht? Ändere sofort dein Passwort, melde unter Einstellungen → Konto & Sicherheit fremde Geräte ab und prüfe die Nachricht bei Inaktivität.",
      "Wasn't you? Change your password right away, sign out unknown devices under Settings → Account & security and check the inactivity message.",
    ),
  ];
  if (mailConfig() && (await holderMail(holder, subject, lines, { label: t("Einstellungen öffnen", "Open settings"), url: `${mailAppUrl()}/${DEADMAN_LINK}` })))
    await markEmailed(nid);
}

// ---- The worker: warnings, sending, re-arming ----

type Round = { fires: number; maxFires: number };

export async function processDeadman(now = Date.now(), options: { maxFires?: number } = {}) {
  if (!(await deadmanAvailable())) return 0;
  const round: Round = { fires: 0, maxFires: options.maxFires ?? DEADMAN_FIRES_PER_ROUND };
  let changed = 0;
  for (const { id: switchId } of await all<{ id: string }>("SELECT id FROM deadman_switches WHERE enabled=1 ORDER BY updated_at,id"))
    if (await transaction(async () => await step(switchId, now, round))) changed++;
  return changed;
}

async function step(switchId: string, now: number, round: Round) {
  if (await settleSignOfLife(switchId, now)) return true;
  const row = await switchRow(switchId);
  if (!row || !row.enabled || row.state !== "armed") return false;
  const last = Math.max(row.checkin_at, await lastUse(row));
  const s = schedule(row, last, now);
  if (s.fireNow) {
    if (round.fires >= round.maxFires) return false;
    round.fires++;
    return await fire(row, now, "inactive");
  }
  if (!s.due) return false;
  return await warn(row, s, now);
}

async function warn(row: SwitchRow, s: ReturnType<typeof schedule>, now: number) {
  const warned = s.warned | s.due;
  const marked = await run("UPDATE deadman_switches SET warned=?,warned_at=? WHERE id=? AND state='armed' AND warned=?", warned, now, row.id, row.warned);
  if (!marked.changes) return false;
  const holder = await person(row.user_id);
  if (!holder) return false;
  const fireAt = s.due & LAST_WARNING ? Math.max(s.deadline, now + DAY) : s.deadline;
  const days = Math.max(1, Math.round((fireAt - now) / DAY));
  const ws = await workspaceName(row.workspace_id);
  const recipients = list(row.recipients);
  await audit(row.user_id, "deadman.warn", row.id, `workspace:${row.workspace_id} ${days}d`);
  const nid = await notify(
    holder.id,
    `Erinnerung: Deine Nachricht bei Inaktivität für „${ws}“ wird am ${when(fireAt)} an ${recipients.length} Empfänger verschickt, wenn du dich nicht meldest. „Ich bin da“ oder jede Nutzung setzt sie zurück.`,
  );
  const t = translate(await userLocale(holder.id));
  const url = `${mailAppUrl()}/api/deadman/here?token=${encodeURIComponent(hereToken({ id: row.id, checkin_at: row.checkin_at }, now))}`;
  const lines = [
    t(`Hallo ${holder.name},`, `Hello ${holder.name},`),
    row.source === "workspace"
      ? t(
          `du hast den Arbeitsbereich „${ws}“ länger nicht genutzt. Meldest du dich nicht, verschickt Flowplan am ${when(fireAt)} deine Nachricht bei Inaktivität an: ${recipients.join(", ")}.`,
          `you have not used the workspace “${ws}” for a while. Unless you check in, Flowplan sends your inactivity message on ${when(fireAt)} to: ${recipients.join(", ")}.`,
        )
      : t(
          `du hast Flowplan länger nicht genutzt. Meldest du dich nicht, verschickt Flowplan am ${when(fireAt)} deine Nachricht bei Inaktivität für „${ws}“ an: ${recipients.join(", ")}.`,
          `you have not used Flowplan for a while. Unless you check in, Flowplan sends your inactivity message for “${ws}” on ${when(fireAt)} to: ${recipients.join(", ")}.`,
        ),
    ...(row.grant_emergency
      ? [t("Deine Vertrauenspersonen bekommen dann sofort Notfallzugriff.", "Your trusted contacts then get emergency access at once.")]
      : []),
    t(
      "Bist du da? Ein Klick auf den Knopf genügt – ohne Anmeldung. Jede Anmeldung oder Nutzung setzt die Frist ebenfalls zurück.",
      "Are you there? One click on the button is enough – no sign-in needed. Any sign-in or use resets the period as well.",
    ),
  ];
  const subject =
    days <= 1
      ? t(`Letzte Erinnerung: Deine Nachricht bei Inaktivität wird morgen verschickt`, `Last reminder: your inactivity message will be sent tomorrow`)
      : t(`Erinnerung: Deine Nachricht bei Inaktivität wird in ${days} Tagen verschickt`, `Reminder: your inactivity message will be sent in ${days} days`);
  if (await holderMail(holder, subject, lines, { label: t("Ich bin da", "I'm here"), url })) await markEmailed(nid);
  return true;
}

// Sends the note once to each recipient – in the transaction that marks the
// switch as gone off, so a restart neither loses nor repeats it.
async function fire(row: SwitchRow, now: number, reason: "inactive" | "deletion") {
  await lockFor(`deadman:${row.id}`);
  const recipients = list(row.recipients);
  const changed = await run(
    "UPDATE deadman_switches SET state='fired',fired_at=?,fired_to=?,updated_at=? WHERE id=? AND state='armed' AND enabled=1 AND checkin_at=? AND warned=?",
    now,
    JSON.stringify(recipients),
    now,
    row.id,
    row.checkin_at,
    row.warned,
  );
  if (!changed.changes) return false;
  const holder = await person(row.user_id);
  if (!holder) return false;
  const locale = await userLocale(holder.id);
  const mail = await recipientMail(holder, row.note, row.period_days, locale, reason);
  let queued = 0;
  for (const to of recipients) if (await queueMail(to, mail.subject, mail.text, mail.html, { fromName: mail.from })) queued++;
  // #281: trusted contacts get access now – not when the account is being
  // deleted anyway.
  const granted =
    reason === "inactive" && row.grant_emergency ? await (await import("./emergency-access")).grantForInactivity(holder.id, row.id, now) : [];
  await audit(holder.id, "deadman.fire", row.id, `workspace:${row.workspace_id} recipients:${queued}${granted.length ? ` emergency:${granted.length}` : ""}${reason === "deletion" ? " deletion" : ""}`);
  if (reason === "deletion") return true;
  const ws = await workspaceName(row.workspace_id);
  const nid = await notify(holder.id, `Deine Nachricht bei Inaktivität für „${ws}“ wurde an ${recipients.join(", ")} verschickt.`);
  const t = translate(locale);
  const lines = [
    t(`Hallo ${holder.name},`, `Hello ${holder.name},`),
    t(
      `du hast ${row.period_days} Tage lang auf keine Erinnerung reagiert. Flowplan hat deshalb deine Nachricht bei Inaktivität für „${ws}“ an ${recipients.join(", ")} verschickt.`,
      `you did not respond to any reminder for ${row.period_days} days. Flowplan has therefore sent your inactivity message for “${ws}” to ${recipients.join(", ")}.`,
    ),
    ...(granted.length
      ? [t(`Notfallzugriff bekommen haben: ${granted.join(", ")}. Beenden kannst du ihn unter Einstellungen → Konto & Sicherheit → Notfallzugriff.`, `Emergency access was given to: ${granted.join(", ")}. You can end it under Settings → Account & security → Emergency access.`)]
      : []),
    t(
      "Bist du wieder da? Sobald du Flowplan nutzt, ist die Nachricht wieder eingeschaltet – verschickt wird sie erst nach einer neuen Frist.",
      "Back again? As soon as you use Flowplan, the message is switched on again – it is only sent after a new period.",
    ),
  ];
  if (await holderMail(holder, t("Deine Nachricht bei Inaktivität wurde verschickt", "Your inactivity message was sent"), lines, { label: t("Flowplan öffnen", "Open Flowplan"), url: `${mailAppUrl()}/${DEADMAN_LINK}` }))
    await markEmailed(nid);
  return true;
}

// An account deleted for inactivity (lib/inactive-accounts.ts): its armed
// messages go out right before – after the deletion notices, which gave
// the holder two weeks to come back.
export async function fireBeforeDeletion(userId: string, now = Date.now()) {
  if (!(await deadmanAvailable())) return 0;
  let n = 0;
  for (const row of await all<SwitchRow>("SELECT * FROM deadman_switches WHERE user_id=? AND enabled=1 AND state='armed'", userId))
    if (await fire(row, now, "deletion")) n++;
  return n;
}

const runtime = globalThis as unknown as { flowplanDeadmanTimer?: ReturnType<typeof setInterval> };
export function startDeadmanWorker(onChanged: () => void = () => {}) {
  if (runtime.flowplanDeadmanTimer) return;
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      if (await processDeadman()) onChanged();
    } catch (error) {
      console.error("Nachricht bei Inaktivität: Prüfung fehlgeschlagen", error);
    }
  };
  runtime.flowplanDeadmanTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanDeadmanTimer.unref();
  setTimeout(tick, 30_000).unref();
}
