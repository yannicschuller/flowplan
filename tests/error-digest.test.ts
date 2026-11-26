// The weekly error digest (lib/error-digest.ts): which error signatures it
// names (new, back after four quiet weeks, thresholds, exclusions, at most
// 10, muted and reported ones left out), when it runs, what the notification
// carries – and the administrators' actions on a signature
// (app/api/admin/monitoring: errors.reported, errors.mute, errors.digest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { ZodError } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-error-digest-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, all, id } = await import("../lib/db");
const { hash } = await import("../lib/auth");
const { requireOpsAdmin } = await import("../lib/admin-ops");
const details = await import("../lib/error-details");
const digest = await import("../lib/error-digest");
const { englishMessage } = await import("../lib/i18n-errors");

const HOUR = 3_600_000,
  DAY = 86_400_000,
  WEEK = 7 * DAY;

async function account(name: string, groups: string[] = []) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `sub-${uid}`, name, `${name}@example.test`);
  const session = `session-${uid}`;
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", hash(session), uid, JSON.stringify(groups), Date.now() + 3_600_000, Date.now());
  const identity: Identity = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: groups.includes("flowplan-admins"), disabled: 0, created_at: "" };
  return { identity };
}
const admin = await account("admin", ["flowplan-admins"]);
const member = await account("member");

const boom = (message: string, name = "Error") => {
  const e = new Error(message);
  e.name = name;
  e.stack = `${name}: ${message}\n    at t (${join(process.cwd(), ".next/server/chunks/ssr/[root-of-the-server]__0a1b._.js")}:1:100)`;
  return e;
};
// Failures at the given moments (route, kind) – flushed.
async function fail(route: string, times: number[], options: { kind?: "request" | "worker" | "job"; name?: string; status?: number; error?: unknown } = {}) {
  for (const at of times)
    details.captureError({ kind: options.kind, route, status: options.status ?? 500, error: "error" in options ? options.error : boom(`failed ${route}`, options.name), at });
  await details.flushErrorDetails(Math.max(...times) + 1);
}
const reset = async () => {
  await details.clearErrorDetails();
  await run("DELETE FROM error_digest_state");
  await run("DELETE FROM notifications WHERE kind='error_digest'");
};
const notices = () => all<{ user_id: string; body: string; link: string }>("SELECT user_id,body,link FROM notifications WHERE kind='error_digest'");

test("the notification kind: admin-only, inbox on, e-mail off; its text in English", async () => {
  const kinds = await import("../lib/notification-kinds");
  assert.ok(kinds.adminOnlyKinds.includes("error_digest"));
  assert.deepEqual(kinds.notificationDefaults.error_digest, { inbox: true, push: false, email: false, messenger: false });
  assert.ok(!kinds.kindsFor(false).includes("error_digest"));
  assert.deepEqual(await one("SELECT inbox,email FROM notification_defaults WHERE kind='error_digest'"), { inbox: 1, email: 0 });
  const text = digest.digestText(
    [
      { signature: "fp-err-v1-0000000000000001", kind: "request", route: "POST /api/command", action: "row.update", name: "TypeError", count: 12, days: 3, firstInWindow: 0, firstSeen: 0, lastSeen: 0, reason: "new" },
      { signature: "fp-err-v1-0000000000000002", kind: "worker", route: "worker ai", action: "", name: "Error", count: 2, days: 1, firstInWindow: 0, firstSeen: 0, lastSeen: 0, reason: "back" },
    ],
    3,
  );
  assert.equal(text, "Wöchentliche Fehlerübersicht: 5 Fehlerarten neu oder wieder aufgetreten – TypeError in POST /api/command · row.update (12×); Error in worker ai (2×) und 3 weitere.");
  assert.equal(englishMessage(text), "Weekly error summary: 5 kinds of errors new or back – TypeError in POST /api/command · row.update (12×); Error in worker ai (2×) and 3 more.");
});

test("digest: new signatures over the thresholds, worker and job errors always; exclusions; at most 10", async () => {
  await reset();
  const now = Date.UTC(2026, 10, 23, 8, 0); // a Monday
  // 3 times in a day: in. Twice on two days: in. Twice on one day: out. Once from a worker: in.
  await fail("GET /api/three", [now - 2 * HOUR, now - 2 * HOUR + 5, now - HOUR]);
  await fail("GET /api/two-days", [now - 3 * DAY, now - HOUR]);
  await fail("GET /api/two-same-day", [now - 3 * HOUR, now - 2 * HOUR]);
  await fail("worker ai", [now - 5 * HOUR], { kind: "worker" });
  // Never: the specs' failure, a 503 without exception while shutting down.
  await fail("GET /api/e2e/fail", [now - HOUR, now - HOUR + 1, now - HOUR + 2], { name: "E2eTestFailure" });
  const runtime = globalThis as { flowplanRuntime?: { stopping?: boolean } };
  const before = runtime.flowplanRuntime;
  runtime.flowplanRuntime = { ...(before || {}), stopping: true };
  await fail("GET /api/stopping", [now - HOUR, now - HOUR + 1, now - HOUR + 2], { status: 503, error: undefined });
  runtime.flowplanRuntime = before;
  // A 503 without exception outside a shutdown counts.
  await fail("GET /api/unavailable", [now - HOUR, now - HOUR + 1, now - HOUR + 2], { status: 503, error: undefined });
  // Older than the window: not counted.
  await fail("GET /api/last-week", [now - 9 * DAY, now - 9 * DAY + 1, now - 9 * DAY + 2]);
  const result = await digest.runErrorDigest(now);
  const routes = result.items.map((i) => i.route).sort();
  assert.deepEqual(routes, ["GET /api/three", "GET /api/two-days", "GET /api/unavailable", "worker ai"]);
  assert.equal(result.more, 0);
  assert.ok(result.items.every((i) => i.reason === "new"));
  // One notification for the administrator, none for the member; only counts, routes and names.
  const sent = await notices();
  assert.deepEqual(sent.map((n) => n.user_id), [admin.identity.id]);
  assert.equal(sent[0].link, "#settings/instance/monitoring/errors");
  assert.match(sent[0].body, /^Wöchentliche Fehlerübersicht: 4 Fehlerarten neu oder wieder aufgetreten – /);
  assert.doesNotMatch(sent[0].body, /failed|fp-err|abcd|member|admin/);
  // The state outlives the error details: every signature seen, the chosen ones with their digest.
  const state = await all<{ signature: string; last_digest_at: number | null }>("SELECT signature,last_digest_at FROM error_digest_state");
  assert.equal(state.filter((s) => s.last_digest_at === now).length, 4);
  assert.ok(state.length >= 6);
  // A week later the same errors again: not new any more.
  const next = now + WEEK;
  await fail("GET /api/three", [next - HOUR, next - HOUR + 1, next - HOUR + 2]);
  assert.deepEqual((await digest.runErrorDigest(next)).items, []);
  // Twelve new ones: ten in, the most frequent first, two more.
  await reset();
  for (let i = 0; i < 12; i++) await fail(`GET /api/many-${String(i).padStart(2, "0")}`, Array.from({ length: 3 + i }, (_, k) => now - HOUR + k));
  const many = await digest.runErrorDigest(now);
  assert.equal(many.items.length, 10);
  assert.equal(many.more, 2);
  assert.equal(many.items[0].route, "GET /api/many-11");
  assert.match((await notices())[0].body, / und 9 weitere\.$/);
});

test("digest: back after four quiet weeks, muted and reported ones left out, switched off sends nothing", async () => {
  await reset();
  const now = Date.UTC(2026, 10, 23, 8, 0);
  await fail("GET /api/back", [now - HOUR, now - HOUR + 1, now - HOUR + 2]);
  await fail("GET /api/recent", [now - HOUR, now - HOUR + 1, now - HOUR + 2]);
  await fail("GET /api/muted", [now - HOUR, now - HOUR + 1, now - HOUR + 2]);
  await fail("GET /api/reported", [now - HOUR, now - HOUR + 1, now - HOUR + 2]);
  const { groups } = await details.errorDetails(now, "7d");
  const sig = (route: string) => groups.find((g) => g.route === route)!.signature;
  // Named before; last seen 30 days ago – back. Named before, seen 10 days ago – not.
  await run("INSERT INTO error_digest_state(signature,first_seen,last_seen,last_digest_at) VALUES(?,?,?,?)", sig("GET /api/back"), now - 90 * DAY, now - 30 * DAY, now - 30 * DAY);
  await run("INSERT INTO error_digest_state(signature,first_seen,last_seen,last_digest_at) VALUES(?,?,?,?)", sig("GET /api/recent"), now - 20 * DAY, now - 10 * DAY, now - 14 * DAY);
  await run("INSERT INTO error_digest_state(signature,first_seen,last_seen,muted_until) VALUES(?,?,?,?)", sig("GET /api/muted"), now - DAY, now - DAY, now + WEEK);
  await run("INSERT INTO error_digest_state(signature,first_seen,last_seen,reported_at) VALUES(?,?,?,?)", sig("GET /api/reported"), now - DAY, now - DAY, now - DAY);
  const result = await digest.runErrorDigest(now);
  assert.deepEqual(result.items.map((i) => [i.route, i.reason]), [["GET /api/back", "back"]]);
  // The pure choice: a mute that ended no longer counts.
  const candidate = { signature: "fp-err-v1-00000000000000aa", kind: "request" as const, route: "GET /x", action: "", name: "Error", count: 5, days: 1, firstInWindow: now - HOUR, firstSeen: now - HOUR, lastSeen: now - HOUR };
  assert.equal(digest.selectDigest([candidate], new Map([[candidate.signature, { last_seen: now - DAY, last_digest_at: null, reported_at: null, muted_until: now - 1 }]]), now).items.length, 1);
  assert.equal(digest.selectDigest([{ ...candidate, count: 1 }], new Map(), now).items.length, 0);
  assert.equal(digest.selectDigest([{ ...candidate, count: 1, kind: "job" }], new Map(), now).items.length, 1);
  // Switched off: chosen, but nothing sent and nothing marked as named.
  await reset();
  await fail("GET /api/off", [now - HOUR, now - HOUR + 1, now - HOUR + 2]);
  await digest.saveErrorDigestSetting(false);
  const off = await digest.runErrorDigest(now);
  assert.equal(off.sent, 0);
  assert.equal((await notices()).length, 0);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM error_digest_state WHERE last_digest_at IS NOT NULL"))?.n, 0);
  await digest.saveErrorDigestSetting(true);
  assert.deepEqual(await digest.errorDigestSetting(), { enabled: true });
});

test("timing: Mondays from 07:00 in the zone, once a week", async () => {
  await run("DELETE FROM instance_settings WHERE key='error-digest-run'");
  const monday = Date.UTC(2026, 10, 23, 7, 30);
  assert.equal(await digest.claimDigestRun(Date.UTC(2026, 10, 23, 6, 59), "UTC"), false);
  assert.equal(await digest.claimDigestRun(Date.UTC(2026, 10, 22, 12), "UTC"), false);
  assert.equal(await digest.claimDigestRun(monday, "UTC"), true);
  assert.equal(await digest.claimDigestRun(monday + HOUR, "UTC"), false);
  assert.equal(await digest.claimDigestRun(monday + WEEK, "UTC"), true);
  // In Berlin it is Monday 07:30 when it is 06:30 UTC.
  assert.deepEqual(digest.localParts(Date.UTC(2026, 10, 23, 6, 30), "Europe/Berlin"), { day: "2026-11-23", weekday: 1, hour: 7 });
});

test("the actions on a signature: administrators in the browser only, validated", async () => {
  await reset();
  const now = Date.now();
  await fail("GET /api/action", [now - 2 * HOUR, now - HOUR]);
  const { groups } = await details.errorDetails(now, "24h");
  const signature = groups[0].signature;
  // The route: the origin checked, then an administrator in the browser
  // (never an API token), before any mark is applied (lib/admin-ops.ts).
  const route = readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/handler.ts"), "utf8");
  assert.match(route, /const admin = async \(\) => requireOpsAdmin\(await requireUser\(\)\)/);
  const postPart = route.slice(route.indexOf("export const POST"));
  assert.ok(postPart.indexOf("await checkOrigin(req)") < postPart.indexOf("applyErrorMark("));
  assert.ok(postPart.indexOf("await admin()") < postPart.indexOf("applyErrorMark("));
  assert.match(postPart, /applyErrorMark\(user, errorMarkActions\.parse\(raw\)\)/);
  const getPart = route.slice(route.indexOf("export const GET"), route.indexOf("const postSchema"));
  assert.ok(getPart.indexOf("await admin()") < getPart.indexOf("errorDetailsView("));
  assert.throws(() => requireOpsAdmin(member.identity), (e: { status?: number }) => e.status === 403);
  assert.throws(() => requireOpsAdmin({ ...admin.identity, apiScope: "write" }), (e: { status?: number }) => e.status === 403);
  assert.doesNotThrow(() => requireOpsAdmin(admin.identity));
  // Validated: a signature of the right form, 0–52 weeks, an https address, a boolean.
  for (const bad of [
    { action: "errors.mute", signature: "fp-err-v2-xyz", weeks: 4 },
    { action: "errors.mute", signature, weeks: 99 },
    { action: "errors.mute", signature, weeks: 1.5 },
    { action: "errors.reported", signature, issueUrl: "javascript:alert(1)" },
    { action: "errors.reported", signature, issueUrl: "http://github.com/x/y/issues/1" },
    { action: "errors.digest", enabled: "yes" },
  ])
    assert.throws(() => digest.errorMarkActions.parse(bad), ZodError, JSON.stringify(bad));
  const act = (input: unknown) => digest.applyErrorMark(admin.identity, digest.errorMarkActions.parse(input), now);
  await assert.rejects(act({ action: "errors.mute", signature: "fp-err-v1-0123456789abcdef", weeks: 1 }), (e: { status?: number }) => e.status === 404);
  // Muted for 4 weeks, reported with the issue's address – shown in the view.
  await act({ action: "errors.mute", signature, weeks: 4 });
  const view = await digest.errorDetailsView(now, "24h");
  const mark = view.groups.find((g) => g.signature === signature)!.mark!;
  assert.ok(mark.mutedUntil! > now + 3 * WEEK && mark.reportedAt === null);
  assert.deepEqual(view.digest, { enabled: true });
  await act({ action: "errors.reported", signature, issueUrl: "https://github.com/yannicschuller/flowplan/issues/600" });
  const row = await one<{ reported_at: number; issue_url: string; muted_until: number; first_seen: number; last_seen: number }>("SELECT * FROM error_digest_state WHERE signature=?", signature);
  assert.ok(row!.reported_at >= now && row!.muted_until > now);
  assert.equal(row!.issue_url, "https://github.com/yannicschuller/flowplan/issues/600");
  assert.equal(row!.first_seen, now - 2 * HOUR);
  assert.equal(row!.last_seen, now - HOUR);
  assert.equal((await digest.errorDetailsView(now, "24h")).groups[0].mark?.issueUrl, "https://github.com/yannicschuller/flowplan/issues/600");
  // Undone; unmuted.
  await act({ action: "errors.reported", signature, reported: false });
  await act({ action: "errors.mute", signature, weeks: 0 });
  assert.deepEqual(await one("SELECT reported_at,issue_url,muted_until FROM error_digest_state WHERE signature=?", signature), { reported_at: null, issue_url: null, muted_until: null });
  assert.equal((await digest.errorDetailsView(now, "24h")).groups[0].mark, null);
  // The switch.
  await act({ action: "errors.digest", enabled: false });
  assert.deepEqual(await digest.errorDigestSetting(), { enabled: false });
  await act({ action: "errors.digest", enabled: true });
  // Audited, with the signature only.
  const logged = await all<{ action: string; detail: string }>("SELECT action,detail FROM audit WHERE actor_id=? AND action LIKE 'admin.errors.%' ORDER BY created_at", admin.identity.id);
  assert.deepEqual([...new Set(logged.map((l) => l.action))].sort(), ["admin.errors.digest", "admin.errors.mute", "admin.errors.reported"]);
  assert.ok(logged.every((l) => !l.detail.includes("github.com")));
});
