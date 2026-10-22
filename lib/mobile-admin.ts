// The administrators' widgets of the apps (flowplan-app): the state of the
// instance, live numbers and storage, read in the background with the
// app's device token (GET /api/mobile/admin-summary, lib/mobile-devices.ts).
// The administration itself (lib/admin-summary.ts, lib/admin-monitoring.ts)
// refuses every token; this is a small, read-only extract of it:
//
// - only for a device whose person is an instance administrator right now –
//   checked on every call against the session the device is bound to, so
//   leaving the admin group, signing out or removing the device ends it;
// - numbers, states and codes only (the app words them): no names, e-mail
//   addresses or workspace names;
// - with the statistics switched off (FLOWPLAN_METRICS=off or in the
//   administration) the live numbers and the chart are left out.
import { adminGroup } from "./auth";
import { adminSummary } from "./admin-summary";
import { diskUsage, liveNumbers, metricsSetting } from "./metrics";
import { one } from "./db";
import type { UpdateStatus } from "./update-check";
import type { Identity } from "./types";

// The person behind a device token administers the instance (the same rule
// as for the browser: the admin group of the session, never a demo).
export function isInstanceAdmin(user: Identity) {
  return !user.demo && user.groups.includes(adminGroup());
}

// Problems (something is broken) and notices (something wants attention),
// most important first, as codes.
export const ADMIN_PROBLEMS = ["workers", "alerts", "backup", "s3", "key", "mail", "export", "ldap"] as const;
export const ADMIN_NOTICES = ["restore", "quota", "backupOff", "mailOff", "domains", "maintenance"] as const;
export type AdminProblem = (typeof ADMIN_PROBLEMS)[number];
export type AdminNotice = (typeof ADMIN_NOTICES)[number];

const midnight = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function mobileAdminSummary(now = Date.now(), update: UpdateStatus | null = null) {
  const s = adminSummary(now, update);
  const problems: AdminProblem[] = [];
  const notices: AdminNotice[] = [];
  if (s.monitoring.failingWorkers.length) problems.push("workers");
  if (s.monitoring.alerts.length) problems.push("alerts");
  if (s.storage.backup.failed) problems.push("backup");
  if (s.storage.s3?.failing) problems.push("s3");
  if (s.security.problem) problems.push("key");
  if (s.mail.configured && s.mail.failed) problems.push("mail");
  if (s.export.failed) problems.push("export");
  if (s.signin.ldapError) problems.push("ldap");
  if (s.storage.restorePending) notices.push("restore");
  if (s.workspaces.nearlyFull) notices.push("quota");
  if (!s.storage.backup.enabled) notices.push("backupOff");
  if (!s.mail.configured) notices.push("mailOff");
  if (s.extensions.domainsFailing) notices.push("domains");
  if (s.maintenance.state) notices.push("maintenance");
  const metrics = metricsSetting().enabled;
  const live = metrics ? liveNumbers(now) : null;
  const disk = diskUsage();
  return {
    at: now,
    health: {
      state: problems.length ? ("problem" as const) : notices.length ? ("notice" as const) : ("ok" as const),
      problems,
      notices,
      // For the badges: how many workers fail, how many workspaces are nearly full.
      failingWorkers: s.monitoring.failingWorkers.length,
      nearlyFull: s.workspaces.nearlyFull,
    },
    version: s.general.version,
    update: s.general.update,
    uptimeSeconds: s.general.uptimeSeconds,
    backup: { enabled: s.storage.backup.enabled, lastAt: s.storage.backup.lastAt, failed: s.storage.backup.failed },
    // null: statistics switched off.
    live: live
      ? {
          activeNow: live.activeNow,
          requestsPerMinute: live.requestsPerMinute,
          errorRate: Math.round(live.errorRate * 10_000) / 10_000,
          errorsHour: live.errorsHour,
          signinsToday: Number(one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind='login_success' AND at>=?", midnight(now))?.n || 0),
          // Requests per hour, the last 24 hours, oldest first (null: not collected).
          requests24h: s.charts.requests24h,
        }
      : null,
    storage: {
      bytes: s.storage.bytes,
      disk: disk ? { total: disk.total, free: disk.free } : null,
      // The fullest workspace with a quota: its share only, not its name.
      fullestQuota: s.workspaces.fullest ? s.workspaces.fullest.share : null,
      nearlyFull: s.workspaces.nearlyFull,
      workspaces: s.workspaces.total,
    },
  };
}
export type MobileAdminSummary = ReturnType<typeof mobileAdminSummary>;
