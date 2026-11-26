// The weekly error digest (Administration → Überwachung → Fehler im
// Detail, "Wöchentliche Fehlerübersicht"): on Mondays the administrators get
// one notification of the kind "error_digest" naming the server errors that
// were new in the last seven days or came back after four quiet weeks – only
// counts, route and error name, and a link to the error details. Reporting
// stays in the instance: the administrator opens a GitHub issue from the
// page (lib/error-report.ts githubIssue, built in the browser); nothing
// leaves the instance without that click.
//
// Errors are told apart by their build-independent signature
// (lib/error-details.ts errorSignature), so the next build's same error is
// not new again. What the digest knows of a signature – first and last
// seen, when a digest last named it, reported (and the issue's address),
// muted until – is kept in error_digest_state, beyond the 14 days of the
// error details (kept 400 days after it was last seen).
//
// A signature is in the digest when
// - it was never named in a digest and never marked as reported, or it
//   came back after at least four quiet weeks;
// - it is not muted;
// - in the last seven days it happened at least 3 times, or on 2 different
//   days, or it is a failing background worker or job;
// - it is not the browser specs' failure (lib/e2e-failure.ts) and not a
//   503 without an exception while the instance was shutting down.
// At most 10, the most frequent first. Failures of third-party services
// are not in error_groups at all (upstream_failures, #514).
//
// Timing: the leader (lib/cluster/leader.ts) checks every ten minutes; the
// first check on a Monday from 07:00 (the server's time zone, else UTC)
// runs it, once per Monday across instances (instance_settings
// "error-digest-run"). Switched off, the state is still kept up to date and
// no notification is sent.
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { errorDetails, type ErrorRange } from "./error-details";
import { isErrorSignature, type ErrorGroupView, type ErrorSignatureMark } from "./error-report";
import { leaderDuty } from "./cluster/leader";
import type { Identity } from "./types";

const HOUR = 3_600_000,
  DAY = 86_400_000,
  WEEK = 7 * DAY;
export const ERROR_DIGEST = { windowDays: 7, quietWeeks: 4, minCount: 3, minDays: 2, maxItems: 10, keepDays: 400, hour: 7 } as const;
const SETTING_KEY = "error-digest";
const RUN_KEY = "error-digest-run";
export const ERROR_DIGEST_LINK = "#settings/instance/monitoring/errors";

type StateRow = { signature: string; first_seen: number; last_seen: number; last_digest_at: number | null; reported_at: number | null; issue_url: string | null; muted_until: number | null };

/* ---------- The setting ---------- */

export async function errorDigestSetting(): Promise<{ enabled: boolean }> {
  try {
    const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", SETTING_KEY);
    return { enabled: row ? JSON.parse(row.value)?.enabled !== false : true };
  } catch {
    return { enabled: true };
  }
}
export async function saveErrorDigestSetting(enabled: boolean) {
  await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", SETTING_KEY, JSON.stringify({ enabled }));
  return { enabled };
}

/* ---------- The time zone ---------- */

export function digestZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || "UTC";
  } catch {
    return "UTC";
  }
}
// The calendar day, weekday (1 = Monday) and hour of a moment in a zone.
export function localParts(ms: number, zone = digestZone()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) % 24 };
}

/* ---------- Choosing ---------- */

export type DigestCandidate = {
  signature: string;
  kind: ErrorGroupView["kind"];
  route: string;
  action: string;
  name: string;
  // In the window: failures, the days they happened on, the first one.
  count: number;
  days: number;
  firstInWindow: number;
  firstSeen: number;
  lastSeen: number;
};
export type DigestItem = DigestCandidate & { reason: "new" | "back" };

// The groups that never count: the browser specs' failing endpoint, and a
// 503 without an exception while the instance was shutting down.
export function excludedGroup(g: Pick<ErrorGroupView, "name" | "route" | "status" | "frames" | "occurrences">) {
  if (g.name === "E2eTestFailure" || /\/api\/e2e\//.test(g.route)) return true;
  if (g.status === 503 && !g.frames.length && /^HTTP 503$/.test(g.name) && g.occurrences.length > 0 && g.occurrences.every((o) => o.stopping)) return true;
  return false;
}
// The groups of the error details, per signature, with their counts in the
// window [since, now] (the hourly buckets of the 7-day view).
export function digestCandidates(groups: ErrorGroupView[], since: number, zone = digestZone()): DigestCandidate[] {
  const bySignature = new Map<string, DigestCandidate & { dayKeys: Set<string> }>();
  for (const g of groups) {
    if (excludedGroup(g)) continue;
    const inWindow = g.buckets.filter(([at]) => at + HOUR > since);
    const c = bySignature.get(g.signature) || {
      signature: g.signature,
      kind: g.kind,
      route: g.route,
      action: g.action,
      name: g.name,
      count: 0,
      days: 0,
      firstInWindow: Infinity,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      dayKeys: new Set<string>(),
    };
    for (const [at, n] of inWindow) {
      c.count += n;
      c.firstInWindow = Math.min(c.firstInWindow, Math.max(at, since));
      c.dayKeys.add(localParts(at, zone).day);
    }
    c.firstSeen = Math.min(c.firstSeen, g.firstSeen);
    c.lastSeen = Math.max(c.lastSeen, g.lastSeen);
    if (g.kind !== "request") c.kind = g.kind;
    bySignature.set(g.signature, c);
  }
  return [...bySignature.values()].map(({ dayKeys, ...c }) => ({ ...c, days: dayKeys.size }));
}
// Which candidates go into the digest (the rules at the top), at most
// ERROR_DIGEST.maxItems, the most frequent first; `more` counts the rest.
export function selectDigest(candidates: DigestCandidate[], states: Map<string, Pick<StateRow, "last_seen" | "last_digest_at" | "reported_at" | "muted_until">>, now: number) {
  const chosen: DigestItem[] = [];
  for (const c of candidates) {
    if (!c.count) continue;
    const s = states.get(c.signature);
    if (s?.muted_until && s.muted_until > now) continue;
    const back = !!s && c.firstInWindow - Number(s.last_seen) >= ERROR_DIGEST.quietWeeks * WEEK;
    const fresh = !s || (s.last_digest_at == null && s.reported_at == null);
    if (!back && !fresh) continue;
    const enough = c.count >= ERROR_DIGEST.minCount || c.days >= ERROR_DIGEST.minDays || c.kind === "worker" || c.kind === "job";
    if (!enough) continue;
    chosen.push({ ...c, reason: back ? "back" : "new" });
  }
  chosen.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen || a.signature.localeCompare(b.signature));
  return { items: chosen.slice(0, ERROR_DIGEST.maxItems), more: Math.max(0, chosen.length - ERROR_DIGEST.maxItems) };
}

/* ---------- The notification ---------- */

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Stored in German like every notification; lib/i18n-errors.ts has the
// English. Only counts, route and error name.
export function digestText(items: DigestItem[], more = 0) {
  const total = items.length + more;
  const shown = items.slice(0, 3).map((i) => `${short(i.name, 40)} in ${short(i.action ? `${i.route} · ${i.action}` : i.route, 80)} (${i.count}×)`);
  const rest = total - shown.length;
  const head = total === 1 ? "Wöchentliche Fehlerübersicht: 1 Fehlerart neu oder wieder aufgetreten" : `Wöchentliche Fehlerübersicht: ${total} Fehlerarten neu oder wieder aufgetreten`;
  return `${head} – ${shown.join("; ")}${rest > 0 ? ` und ${rest} weitere` : ""}.`;
}

/* ---------- One run ---------- */

async function states(signatures: string[]) {
  const map = new Map<string, StateRow>();
  for (let i = 0; i < signatures.length; i += 200) {
    const slice = signatures.slice(i, i + 200);
    if (!slice.length) continue;
    for (const r of await all<StateRow>(`SELECT * FROM error_digest_state WHERE signature IN (${slice.map(() => "?").join(",")})`, ...slice)) map.set(r.signature, r);
  }
  return map;
}
async function remember(c: Pick<DigestCandidate, "signature" | "firstSeen" | "lastSeen">, digestAt: number | null) {
  await run(
    `INSERT INTO error_digest_state(signature,first_seen,last_seen,last_digest_at) VALUES(?,?,?,?)
     ON CONFLICT(signature) DO UPDATE SET first_seen=CASE WHEN excluded.first_seen<error_digest_state.first_seen THEN excluded.first_seen ELSE error_digest_state.first_seen END,last_seen=CASE WHEN excluded.last_seen>error_digest_state.last_seen THEN excluded.last_seen ELSE error_digest_state.last_seen END,last_digest_at=COALESCE(excluded.last_digest_at,error_digest_state.last_digest_at)`,
    c.signature,
    c.firstSeen,
    c.lastSeen,
    digestAt,
  );
}
// One digest: chooses, notifies the administrators (when switched on) and
// brings the state up to date. Answers what it chose.
export async function runErrorDigest(now = Date.now(), options: { notify?: boolean } = {}) {
  const view = await errorDetails(now, "7d", 1000);
  const candidates = digestCandidates(view.groups, now - ERROR_DIGEST.windowDays * DAY);
  const known = await states(candidates.map((c) => c.signature));
  const { items, more } = selectDigest(candidates, known, now);
  const notify = options.notify ?? (await errorDigestSetting()).enabled;
  const chosen = new Set(items.map((i) => i.signature));
  for (const c of candidates) await remember(c, notify && chosen.has(c.signature) ? now : null);
  await run("DELETE FROM error_digest_state WHERE last_seen<? AND (muted_until IS NULL OR muted_until<?)", now - ERROR_DIGEST.keepDays * DAY, now);
  if (!notify || !items.length) return { items, more, sent: 0 };
  const { adminUserIds } = await import("./auth");
  const body = digestText(items, more);
  let sent = 0;
  for (const admin of await adminUserIds()) {
    await run("INSERT INTO notifications(id,user_id,body,kind,link) VALUES(?,?,?,'error_digest',?)", id(), admin, body, ERROR_DIGEST_LINK);
    sent++;
  }
  try {
    const { dispatchPush } = await import("./push");
    void dispatchPush();
  } catch {}
  return { items, more, sent };
}
// Whether this moment is a Monday from 07:00 whose digest has not run yet –
// claimed at once, so one instance runs it.
export async function claimDigestRun(now = Date.now(), zone = digestZone()) {
  const local = localParts(now, zone);
  if (local.weekday !== 1 || local.hour < ERROR_DIGEST.hour) return false;
  const value = JSON.stringify({ week: local.day });
  const moved = await run(
    "INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE instance_settings.value<>excluded.value",
    RUN_KEY,
    value,
  );
  return moved.changes > 0;
}
export async function errorDigestIfDue(now = Date.now()) {
  if (!(await claimDigestRun(now))) return null;
  return await runErrorDigest(now);
}

const runtime = globalThis as unknown as { flowplanErrorDigestTimer?: ReturnType<typeof setInterval> };
// Every ten minutes, the leader's duty (lib/cluster/leader.ts).
export function startErrorDigestWorker() {
  if (runtime.flowplanErrorDigestTimer) return;
  const tick = () => void leaderDuty("error-digest", () => errorDigestIfDue().catch((error) => console.error("Error digest failed", error)));
  setTimeout(tick, 180_000).unref?.();
  runtime.flowplanErrorDigestTimer = setInterval(tick, 10 * 60_000);
  runtime.flowplanErrorDigestTimer.unref?.();
}

/* ---------- The administrator's view and actions ---------- */

// The error details with each group's mark (reported, muted) and the
// digest's switch (app/api/admin/monitoring?view=errors).
export async function errorDetailsView(now = Date.now(), range: ErrorRange = "24h") {
  const view = await errorDetails(now, range);
  const known = await states([...new Set(view.groups.map((g) => g.signature))]);
  const markOf = (signature: string): ErrorSignatureMark | null => {
    const s = known.get(signature);
    if (!s || (s.reported_at == null && !(s.muted_until && s.muted_until > now))) return null;
    return { reportedAt: s.reported_at == null ? null : Number(s.reported_at), issueUrl: s.issue_url || "", mutedUntil: s.muted_until && s.muted_until > now ? Number(s.muted_until) : null };
  };
  return { ...view, groups: view.groups.map((g) => ({ ...g, mark: markOf(g.signature) })), digest: await errorDigestSetting() };
}

const signature = z.string().refine(isErrorSignature, "Ungültige Fehlersignatur.");
// An issue of the repository (or a fork's, an own tracker's): https only.
const issueUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => !v || /^https:\/\/[^\s/?#@]+\/[^\s]*$/.test(v), "Bitte die Adresse des Issues angeben (https://…).");
export const errorMarkActions = z.discriminatedUnion("action", [
  // Reported (or no longer): the issue's address, if the administrator pastes it.
  z.object({ action: z.literal("errors.reported"), signature, reported: z.boolean().default(true), issueUrl: issueUrl.optional() }),
  // Muted for 1–52 weeks; 0 lifts it.
  z.object({ action: z.literal("errors.mute"), signature, weeks: z.number().int().min(0).max(52) }),
  z.object({ action: z.literal("errors.digest"), enabled: z.boolean() }),
]);
export type ErrorMarkAction = z.infer<typeof errorMarkActions>;

// The first and last time of a signature among the error details (a mark
// needs its row in error_digest_state).
async function seenOf(sig: string, now: number) {
  const view = await errorDetails(now, "7d", 1000);
  const groups = view.groups.filter((g) => g.signature === sig);
  if (!groups.length) return null;
  return { firstSeen: Math.min(...groups.map((g) => g.firstSeen)), lastSeen: Math.max(...groups.map((g) => g.lastSeen)) };
}
export async function applyErrorMark(user: Identity, input: ErrorMarkAction, now = Date.now()) {
  if (input.action === "errors.digest") {
    await saveErrorDigestSetting(input.enabled);
    await audit(user.id, "admin.errors.digest", "instance", input.enabled ? "on" : "off");
    return;
  }
  const existing = await one<StateRow>("SELECT * FROM error_digest_state WHERE signature=?", input.signature);
  if (!existing) {
    const seen = await seenOf(input.signature, now);
    if (!seen) throw new HttpError(404, "Diese Fehlerart gibt es nicht mehr.");
    await remember({ signature: input.signature, ...seen }, null);
  }
  if (input.action === "errors.reported") {
    await run("UPDATE error_digest_state SET reported_at=?,issue_url=? WHERE signature=?", input.reported ? now : null, input.reported ? input.issueUrl || null : null, input.signature);
    await audit(user.id, "admin.errors.reported", "instance", `${input.signature}${input.reported ? "" : " (undone)"}`);
  } else {
    await run("UPDATE error_digest_state SET muted_until=? WHERE signature=?", input.weeks ? now + input.weeks * WEEK : null, input.signature);
    await audit(user.id, "admin.errors.mute", "instance", `${input.signature} ${input.weeks}w`);
  }
}
