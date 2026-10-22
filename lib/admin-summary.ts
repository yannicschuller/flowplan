// The facts behind the tiles of the administration's landing page
// (components/settings/admin/tiles.ts formats them): one small object per
// section, only from data the server already keeps. Numbers and states, no
// texts – the browser words them in its language. Administrators only, never
// with an API token (app/api/admin/summary/route.ts).
import { one } from "./db";
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
import { activeAlerts, opsEventSummary, requireOpsAdmin, workerStatuses } from "./admin-ops";
import { pendingRestore } from "./instance-backup";
import type { UpdateStatus } from "./update-check";
import type { Identity } from "./types";

const DAY = 86_400_000;
// From this share of its quota a workspace counts as nearly full (as the
// storage alert in lib/admin-ops.ts).
const NEARLY_FULL = 0.9;
const count = (sql: string, ...args: (string | number)[]) => Number(one<{ n: number }>(sql, ...args)?.n || 0);
// audit.created_at is SQLite's CURRENT_TIMESTAMP: UTC, "YYYY-MM-DD HH:MM:SS".
const sqliteTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function adminSummary(now = Date.now(), update: UpdateStatus | null = null) {
  const settings = instanceSettings();
  const metrics = instanceMetrics();
  const usage = workspaceUsage();
  const nearlyFull = usage.filter((w) => w.effectiveQuotaMb > 0 && w.bytes >= w.effectiveQuotaMb * 1024 * 1024 * NEARLY_FULL).length;
  const backup = scheduledBackupStatus();
  const mirror = storageStatus();
  const mail = mailStatus();
  const exports = markdownExportStatus();
  const lastExport = exports.runs.reduce<(typeof exports.runs)[number] | null>((a, r) => (!a || r.at > a.at ? r : a), null);
  const key = encryptionKeyStatus();
  const ldap = ldapStatus();
  let ai = { enabled: false, provider: null as string | null, access: "everyone" as "everyone" | "selected" };
  try {
    const s = instanceAiSettings();
    ai = { enabled: s.enabled, provider: s.provider?.kind ?? null, access: s.access };
  } catch {}
  const events = opsEventSummary(now);
  const workers = workerStatuses(now).filter((w) => w.active && w.error && (w.errorAt ?? 0) >= now - DAY);
  return {
    users: {
      total: count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'"),
      disabled: count("SELECT COUNT(*) n FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%' AND disabled=1"),
      sessions: count("SELECT COUNT(*) n FROM sessions WHERE expires>?", now),
      allowSignup: !!settings.allowSignup,
      localLogin: localLoginEnabled(),
    },
    signin: {
      oidc: !!process.env.OIDC_ISSUER,
      ssoMappings: count("SELECT COUNT(*) n FROM sso_mappings"),
      scimTokens: count("SELECT COUNT(*) n FROM scim_tokens"),
      ldap: ldap.configured,
      ldapError: !!(ldap.lastSync && !ldap.lastSync.ok),
    },
    workspaces: { total: usage.length, nearlyFull },
    storage: {
      bytes: metrics.databaseBytes + metrics.uploadBytes,
      s3: mirror.enabled ? { pending: mirror.pending, failing: mirror.failing } : null,
      backup: { enabled: backup.enabled, lastAt: backup.last?.at ?? null, failed: !!backup.last?.error },
      restorePending: !!pendingRestore(),
    },
    export: { pages: exports.pages.length, lastAt: lastExport?.at ?? null, failed: !!lastExport?.error },
    mail: { configured: mail.configured, pending: mail.pending, failed: mail.failed },
    ai,
    security: { encrypted: key.enabled, problem: !!key.problem },
    audit: { day: count("SELECT COUNT(*) n FROM audit WHERE created_at>=?", sqliteTime(now - DAY)) },
    monitoring: {
      failingWorkers: workers.map((w) => w.key),
      alerts: activeAlerts(now).map((a) => a.event),
      loginFailures: events.totals.login_failure.day,
      rateLimited: events.totals.rate_limited.day,
    },
    general: {
      name: settings.name,
      version: buildInfo().version,
      update: update ? update.latest : null,
      announcement: !!settings.announcement,
    },
  };
}
export type AdminSummary = ReturnType<typeof adminSummary>;

// For the route: checks the person first.
export function adminSummaryFor(user: Identity, now = Date.now(), update: UpdateStatus | null = null) {
  requireOpsAdmin(user);
  return adminSummary(now, update);
}
