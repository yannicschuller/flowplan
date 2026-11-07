// The facts behind the tiles of the administration's landing page
// (components/settings/admin/tiles.ts formats them): one small object per
// section, only from data the server already keeps. Numbers and states, no
// texts – the browser words them in its language. Administrators only, never
// with an API token (app/api/admin/summary/route.ts).
import { all, one } from "./db";
import { buildInfo } from "./build-info";
import { instanceMetrics, workspaceUsage } from "./instance-ops";
import { instanceSettings } from "./instance-settings";
import { mailStatus } from "./mail";
import { scheduledBackupStatus } from "./scheduled-backup";
import { markdownExportStatus } from "./scheduled-markdown-export";
import { encryptionKeyStatus } from "./encryption";
import { storageStatus } from "./storage";
import { ldapStatus } from "./ldap-auth";
import { localLoginEnabled } from "./local-auth";
import { instanceAiSettings } from "./ai/settings";
import { activeAlerts, opsEventSummary, requireOpsAdmin, storedMaintenance, workerStatuses } from "./admin-ops";
import { pendingRestore } from "./instance-backup";
import { activeSeries, aiUsage, liveNumbers, requestSeries, storageTrend } from "./metrics";
import { pushSummary } from "./push-status";
import type { UpdateStatus } from "./update-check";
import { plainHttpInstance } from "./instance-https";
import type { Identity } from "./types";

const DAY = 86_400_000;
// From this share of its quota a workspace counts as nearly full (as the
// storage alert in lib/admin-ops.ts).
const NEARLY_FULL = 0.9;
const count = async (sql: string, ...args: (string | number)[]) => Number((await one<{ n: number }>(sql, ...args))?.n || 0);
// audit.created_at is SQLite's CURRENT_TIMESTAMP: UTC, "YYYY-MM-DD HH:MM:SS".
const sqliteTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export async function adminSummary(now = Date.now(), update: UpdateStatus | null = null) {
  const settings = await instanceSettings();
  const metrics = await instanceMetrics();
  const usage = await workspaceUsage();
  const nearlyFull = usage.filter((w) => w.effectiveQuotaMb > 0 && w.bytes >= w.effectiveQuotaMb * 1024 * 1024 * NEARLY_FULL).length;
  const backup = await scheduledBackupStatus();
  const mirror = await storageStatus();
  const mail = await mailStatus();
  const exports = await markdownExportStatus();
  const lastExport = exports.runs.reduce<(typeof exports.runs)[number] | null>((a, r) => (!a || r.at > a.at ? r : a), null);
  const key = encryptionKeyStatus();
  const ldap = await ldapStatus();
  let ai = { enabled: false, provider: null as string | null, access: "everyone" as "everyone" | "selected" };
  try {
    const s = await instanceAiSettings();
    ai = { enabled: s.enabled, provider: s.provider?.kind ?? null, access: s.access };
  } catch {}
  const events = await opsEventSummary(now);
  const workers = (await workerStatuses(now)).filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY);
  // The fullest workspace with a quota (the tile's meter).
  const names = new Map((await all<{ id: string; name: string }>("SELECT id,name FROM workspaces")).map((w) => [w.id, w.name]));
  const fullest = usage
    .filter((w) => w.effectiveQuotaMb > 0)
    .map((w) => ({ name: names.get(w.id) || "", share: w.bytes / (w.effectiveQuotaMb * 1024 * 1024) }))
    .sort((a, b) => b.share - a.share)[0];
  const live = await liveNumbers(now);
  const tokens = (await aiUsage(now, 14)).days;
  const requests = (await requestSeries("24h", now)).points;
  return {
    users: {
      total: await count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'"),
      disabled: await count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%' AND disabled=1"),
      sessions: await count("SELECT COUNT(*) n FROM sessions WHERE expires>?", now),
      allowSignup: !!settings.allowSignup,
      localLogin: localLoginEnabled(),
      activeNow: live.activeNow,
    },
    signin: {
      oidc: !!process.env.OIDC_ISSUER,
      ssoMappings: await count("SELECT COUNT(*) n FROM sso_mappings"),
      scimTokens: await count("SELECT COUNT(*) n FROM scim_tokens"),
      ldap: ldap.configured,
      ldapError: !!(ldap.lastSync && !ldap.lastSync.ok),
    },
    workspaces: { total: usage.length, nearlyFull, fullest: fullest ? { name: fullest.name, share: Math.round(fullest.share * 1000) / 1000 } : null },
    storage: {
      bytes: metrics.databaseBytes + metrics.uploadBytes,
      s3: mirror.enabled ? { pending: mirror.pending, failing: mirror.failing } : null,
      backup: { enabled: backup.enabled, lastAt: backup.last?.at ?? null, failed: !!backup.last?.error },
      restorePending: !!pendingRestore(),
    },
    limits: {
      uploadMb: settings.maxUploadMb,
      retentionDays: metrics.retentionDays,
      quotaMb: metrics.defaultQuotaMb,
      // Workspaces with a quota of their own.
      exceptions: await count("SELECT COUNT(*) n FROM workspaces WHERE quota_mb IS NOT NULL"),
    },
    extensions: {
      plugins: await count("SELECT COUNT(*) n FROM plugins"),
      domains: await count("SELECT COUNT(*) n FROM custom_domains"),
      domainsVerified: await count("SELECT COUNT(*) n FROM custom_domains WHERE verified_at IS NOT NULL"),
      domainsFailing: await count("SELECT COUNT(*) n FROM custom_domains WHERE last_error IS NOT NULL"),
    },
    maintenance: await (async () => {
      const notice = await storedMaintenance();
      return {
        state: !notice || notice.end <= now ? null : notice.start <= now ? ("active" as const) : ("scheduled" as const),
        start: notice?.start ?? null,
        end: notice?.end ?? null,
        announcement: !!settings.announcement,
      };
    })(),
    // A failed run only counts while the export is on (#73): switched off, its
    // last error is history and never goes away on its own.
    export: { pages: exports.pages.length, lastAt: lastExport?.at ?? null, failed: exports.pages.length > 0 && !!lastExport?.error },
    mail: { configured: mail.configured, pending: mail.pending, failed: mail.failed },
    // The push relay and the deliveries of 24 hours (lib/push-status.ts);
    // the live check is what the route ran before (warmPushChecks).
    push: await pushSummary(now),
    ai: { ...ai, tokensToday: tokens.length ? tokens[tokens.length - 1].tokensIn + tokens[tokens.length - 1].tokensOut : 0 },
    security: { encrypted: key.enabled, problem: !!key.problem },
    // Administration → Sicherheit (lib/security-admin.ts).
    securityCenter: {
      open: await count("SELECT COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL"),
      critical: await count("SELECT COUNT(*) n FROM security_incidents WHERE resolved_at IS NULL AND severity='critical'"),
      failedDay: await count("SELECT COUNT(*) n FROM security_events WHERE kind='login.failure' AND at>=?", now - DAY),
      blocks: await count("SELECT COUNT(*) n FROM security_blocks WHERE until IS NULL OR until>?", now),
    },
    audit: { day: await count("SELECT COUNT(*) n FROM audit WHERE created_at>=?", sqliteTime(now - DAY)) },
    monitoring: {
      failingWorkers: workers.map((w) => w.key),
      alerts: (await activeAlerts(now)).map((a) => a.event),
      loginFailures: events.totals.login_failure.day,
      rateLimited: events.totals.rate_limited.day,
      errorsHour: live.errorsHour,
    },
    general: {
      name: settings.name,
      version: buildInfo().version,
      update: update ? update.latest : null,
      // APP_URL is plain http on another machine (lib/instance-https.ts).
      plainHttp: plainHttpInstance(),
      announcement: !!settings.announcement,
      uptimeSeconds: metrics.uptimeSeconds,
    },
    // Small series for the tiles' sparklines, oldest first; null: nothing
    // collected yet (lib/metrics.ts).
    charts: {
      active24h: (await activeSeries(now, 24)).map((p) => p.people),
      requests24h: hourly(requests.map((p) => p.requests)),
      errors24h: hourly(requests.map((p) => p.errors)),
      storage30d: (await storageTrend(now, 30)).map((d, i, list) => (i === list.length - 1 ? metrics.databaseBytes + metrics.uploadBytes : d.bytes)),
      aiTokens14d: tokens.map((d) => d.tokensIn + d.tokensOut),
      audit14d: await auditDays(now, 14),
    },
  };
}
export type AdminSummary = Awaited<ReturnType<typeof adminSummary>>;

// 5-minute buckets of a day, summed per hour (null while nothing was collected).
function hourly(values: (number | null)[]) {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += 12) {
    const part = values.slice(i, i + 12);
    out.push(part.every((v) => v === null) ? null : part.reduce<number>((a, v) => a + (v || 0), 0));
  }
  return out;
}
// Changes in the activity log per UTC day (audit.created_at is UTC).
async function auditDays(now: number, days: number) {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(new Date(now - i * DAY).toISOString().slice(0, 10));
  const rows = new Map(
    (await all<{ day: string; n: number }>("SELECT substr(created_at,1,10) AS day,COUNT(*) n FROM audit WHERE created_at>=? GROUP BY day", `${keys[0]} 00:00:00`)).map((r) => [r.day, Number(r.n)]),
  );
  return keys.map((k) => rows.get(k) || 0);
}

// For the route: checks the person first.
export async function adminSummaryFor(user: Identity, now = Date.now(), update: UpdateStatus | null = null) {
  requireOpsAdmin(user);
  return await adminSummary(now, update);
}
