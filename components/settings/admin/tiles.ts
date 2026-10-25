// The tiles of the administration's landing page: the facts of
// /api/admin/summary (lib/admin-summary.ts) as a status line, a tone and a
// badge, in the reader's language. "ok" shows no badge (nothing to say) –
// except for push, whose badge is the relay's reachability (green, amber,
// red).
import type { AdminSummary } from "@/lib/admin-summary";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { TileSummary } from "../shell";
import { compact, num, percent } from "./monitoring-format";
import { pushTile } from "./push-format";

type T = (de: string, en: string) => string;
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} GB`
    : `${(bytes / 1024 ** 2).toLocaleString(LOCALE_TAG, { maximumFractionDigits: bytes < 10 * 1024 ** 2 ? 1 : 0 })} MB`;
const time = (at: number) => {
  const d = new Date(at);
  return Date.now() - at < 86_400_000 ? d.toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
};
const join = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

export function adminTiles(s: AdminSummary, t: T): Record<string, TileSummary> {
  const workers = s.monitoring.failingWorkers.length;
  const alerts = s.monitoring.alerts.length;
  const u = s.users;
  const c = s.charts;
  return {
    users: {
      line: join(
        u.total === 1 ? t("1 Konto", "1 account") : t(`${u.total} Konten`, `${u.total} accounts`),
        u.sessions === 1 ? t("1 aktive Sitzung", "1 active session") : t(`${u.sessions} aktive Sitzungen`, `${u.sessions} active sessions`),
        u.disabled > 0 && t(`${u.disabled} deaktiviert`, `${u.disabled} disabled`),
      ),
      tone: u.localLogin && u.allowSignup ? "info" : undefined,
      badge: u.localLogin && u.allowSignup ? t("Registrierung offen", "Sign-up open") : undefined,
      value: num(u.activeNow),
      valueLabel: t("gerade aktiv", "active now"),
      spark: c.active24h,
      sparkLabel: t("Aktive Personen je Stunde, letzte 24 Stunden", "Active people per hour, last 24 hours"),
    },
    signin: {
      line: join(s.signin.oidc ? t("SSO an", "SSO on") : t("SSO aus", "SSO off"), s.signin.scimTokens ? t("SCIM an", "SCIM on") : t("SCIM aus", "SCIM off"), s.signin.ldap ? t("LDAP an", "LDAP on") : t("LDAP aus", "LDAP off")),
      tone: s.signin.ldapError ? "error" : undefined,
      badge: s.signin.ldapError ? t("LDAP-Abgleich fehlgeschlagen", "LDAP sync failed") : undefined,
    },
    workspaces: {
      line: join(
        s.workspaces.total === 1 ? t("1 Arbeitsbereich", "1 workspace") : t(`${s.workspaces.total} Arbeitsbereiche`, `${s.workspaces.total} workspaces`),
        !s.workspaces.nearlyFull && t("kein Kontingent knapp", "no quota running low"),
      ),
      tone: s.workspaces.nearlyFull ? "warn" : undefined,
      badge: s.workspaces.nearlyFull ? t(`${s.workspaces.nearlyFull} fast voll`, `${s.workspaces.nearlyFull} nearly full`) : undefined,
      ...(s.workspaces.fullest
        ? {
            value: percent(s.workspaces.fullest.share),
            valueLabel: s.workspaces.fullest.name,
            meter: s.workspaces.fullest.share,
            meterLabel: t(`Kontingent von ${s.workspaces.fullest.name}`, `Quota of ${s.workspaces.fullest.name}`),
          }
        : {}),
    },
    storage: {
      line: join(
        size(s.storage.bytes),
        s.storage.restorePending
          ? t("Wiederherstellung wartet auf Neustart", "Restore waits for a restart")
          : !s.storage.backup.enabled
            ? t("geplante Sicherung aus", "scheduled backup off")
            : s.storage.backup.lastAt
              ? t(`letzte Sicherung ${time(s.storage.backup.lastAt)}`, `last backup ${time(s.storage.backup.lastAt)}`)
              : t("noch keine Sicherung", "no backup yet"),
        s.storage.s3 && t("S3", "S3"),
      ),
      tone: s.storage.backup.failed || s.storage.s3?.failing ? "error" : !s.storage.backup.enabled || s.storage.restorePending ? "warn" : undefined,
      badge: s.storage.backup.failed ? t("Sicherung fehlgeschlagen", "Backup failed") : s.storage.s3?.failing ? t("S3 meldet Fehler", "S3 reports errors") : undefined,
      value: size(s.storage.bytes),
      valueLabel: t("Datenbank und Dateien", "Database and files"),
      spark: c.storage30d,
      sparkLabel: t("Speicher je Tag, letzte 30 Tage", "Storage per day, last 30 days"),
    },
    limits: {
      line: join(
        t(`Upload ${s.limits.uploadMb} MB`, `Upload ${s.limits.uploadMb} MB`),
        s.limits.retentionDays ? t(`Versionen ${s.limits.retentionDays} Tage`, `Versions ${s.limits.retentionDays} days`) : t("Versionen für immer", "Versions forever"),
        s.limits.quotaMb ? t(`Kontingent ${size(s.limits.quotaMb * 1024 * 1024)}`, `Quota ${size(s.limits.quotaMb * 1024 * 1024)}`) : t("kein Kontingent", "no quota"),
        s.limits.exceptions > 0 && (s.limits.exceptions === 1 ? t("1 Ausnahme", "1 exception") : t(`${s.limits.exceptions} Ausnahmen`, `${s.limits.exceptions} exceptions`)),
      ),
    },
    extensions: {
      line: join(
        s.extensions.plugins === 1 ? t("1 Block-Erweiterung", "1 block extension") : t(`${s.extensions.plugins} Block-Erweiterungen`, `${s.extensions.plugins} block extensions`),
        s.extensions.domains === 1 ? t("1 Domain", "1 domain") : t(`${s.extensions.domains} Domains`, `${s.extensions.domains} domains`),
      ),
      tone: s.extensions.domainsFailing ? "warn" : undefined,
      badge: s.extensions.domainsFailing
        ? t(`DNS bei ${s.extensions.domainsFailing} Domain${s.extensions.domainsFailing === 1 ? "" : "s"} nicht bestätigt`, `DNS of ${s.extensions.domainsFailing} domain${s.extensions.domainsFailing === 1 ? "" : "s"} not confirmed`)
        : undefined,
    },
    maintenance: {
      line:
        s.maintenance.state === "active" && s.maintenance.end
          ? t(`Wartung bis ${time(s.maintenance.end)}`, `Maintenance until ${time(s.maintenance.end)}`)
          : s.maintenance.state === "scheduled" && s.maintenance.start
            ? t(`Wartung geplant ab ${time(s.maintenance.start)}`, `Maintenance planned from ${time(s.maintenance.start)}`)
            : s.maintenance.announcement
              ? t("Hinweis für alle wird angezeigt", "Notice for everyone is shown")
              : t("Kein Hinweis aktiv", "No notice active"),
      tone: s.maintenance.state ? "info" : undefined,
      badge: s.maintenance.state === "active" ? t("Wartung läuft", "Maintenance running") : s.maintenance.state === "scheduled" ? t("Wartung geplant", "Maintenance planned") : undefined,
    },
    export: {
      line: s.export.pages ? t(`${s.export.pages} Seiten bei jeder Sicherung`, `${s.export.pages} pages with every backup`) : t("Aus", "Off"),
      tone: s.export.failed ? "error" : undefined,
      badge: s.export.failed ? t("Letzter Export fehlgeschlagen", "Last export failed") : undefined,
    },
    mail: {
      line: s.mail.configured ? t(`${s.mail.pending} in der Warteschlange`, `${s.mail.pending} queued`) : t("Nicht eingerichtet – Einladungen per Link", "Not set up – invitations by link"),
      tone: !s.mail.configured ? "warn" : s.mail.failed ? "error" : undefined,
      badge: s.mail.failed ? t(`${s.mail.failed} aufgegeben`, `${s.mail.failed} given up`) : undefined,
    },
    push: {
      ...pushTile(s.push, t),
      ...(s.push.enabled
        ? {
            value: num(s.push.delivered24h),
            valueLabel: t("zugestellt (24 Std.)", "delivered (24 h)"),
            ...(s.push.hourly ? { spark: s.push.hourly, sparkLabel: t("Zugestellte Push-Benachrichtigungen je Stunde, letzte 24 Stunden", "Delivered push notifications per hour, last 24 hours") } : {}),
          }
        : {}),
    },
    ai: {
      ...(s.ai.enabled
        ? {
            value: compact(s.ai.tokensToday),
            valueLabel: t("Tokens heute", "Tokens today"),
            spark: c.aiTokens14d,
            sparkLabel: t("KI-Tokens je Tag, letzte 14 Tage", "AI tokens per day, last 14 days"),
          }
        : {}),
      line: s.ai.enabled ? join(s.ai.provider || t("Kein Anbieter der Instanz", "No instance provider"), s.ai.access === "selected" ? t("ausgewählte Personen", "selected people") : t("alle Personen", "everyone")) : t("Ausgeschaltet", "Switched off"),
    },
    security: {
      line: s.security.encrypted ? t("Schlüssel gesetzt", "Key set") : t("Kein Schlüssel", "No key"),
      tone: s.security.problem ? "error" : undefined,
      badge: s.security.problem ? t("Schlüssel nicht lesbar", "Key not readable") : undefined,
    },
    audit: {
      line: s.audit.day === 1 ? t("1 Änderung in 24 Stunden", "1 change in 24 hours") : t(`${s.audit.day} Änderungen in 24 Stunden`, `${s.audit.day} changes in 24 hours`),
      value: num(s.audit.day),
      valueLabel: t("in 24 Std.", "in 24 h"),
      spark: c.audit14d,
      sparkLabel: t("Änderungen je Tag, letzte 14 Tage", "Changes per day, last 14 days"),
    },
    monitoring: {
      line:
        workers || alerts
          ? join(workers > 0 && t(`${workers} Dienste mit Fehler`, `${workers} workers failing`), alerts > 0 && t(`${alerts} Warnungen`, `${alerts} alerts`))
          : t(`Alles in Ordnung · ${s.monitoring.loginFailures} fehlgeschlagene Anmeldungen (24 Std.)`, `All fine · ${s.monitoring.loginFailures} failed sign-ins (24 h)`),
      tone: workers || alerts ? "error" : undefined,
      badge: workers ? s.monitoring.failingWorkers.join(", ") : alerts ? t("Warnung", "Alert") : undefined,
      // Errors per hour when there were any, else the requests.
      ...(c.errors24h.some((v) => (v || 0) > 0)
        ? { spark: c.errors24h, sparkTone: 2 as const, sparkLabel: t("Fehler (5xx) je Stunde, letzte 24 Stunden", "Errors (5xx) per hour, last 24 hours") }
        : { spark: c.requests24h, sparkLabel: t("Anfragen je Stunde, letzte 24 Stunden", "Requests per hour, last 24 hours") }),
    },
    general: {
      line: join(`v${s.general.version}`, s.general.name),
      tone: s.general.update ? "info" : undefined,
      badge: s.general.update ? t(`${s.general.update} verfügbar`, `${s.general.update} available`) : undefined,
    },
  };
}
