// The tiles of the administration's landing page: the facts of
// /api/admin/summary (lib/admin-summary.ts) as a status line, a tone and a
// badge, in the reader's language. "ok" shows no badge (nothing to say).
import type { AdminSummary } from "@/lib/admin-summary";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { TileSummary } from "../shell";

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
  return {
    users: {
      line: join(
        u.total === 1 ? t("1 Konto", "1 account") : t(`${u.total} Konten`, `${u.total} accounts`),
        u.sessions === 1 ? t("1 aktive Sitzung", "1 active session") : t(`${u.sessions} aktive Sitzungen`, `${u.sessions} active sessions`),
        u.disabled > 0 && t(`${u.disabled} deaktiviert`, `${u.disabled} disabled`),
      ),
      tone: u.localLogin && u.allowSignup ? "info" : undefined,
      badge: u.localLogin && u.allowSignup ? t("Registrierung offen", "Sign-up open") : undefined,
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
    ai: {
      line: s.ai.enabled ? join(s.ai.provider || t("Kein Anbieter der Instanz", "No instance provider"), s.ai.access === "selected" ? t("ausgewählte Personen", "selected people") : t("alle Personen", "everyone")) : t("Ausgeschaltet", "Switched off"),
    },
    security: {
      line: s.security.encrypted ? t("Schlüssel gesetzt", "Key set") : t("Kein Schlüssel", "No key"),
      tone: s.security.problem ? "error" : undefined,
      badge: s.security.problem ? t("Schlüssel nicht lesbar", "Key not readable") : undefined,
    },
    audit: { line: s.audit.day === 1 ? t("1 Änderung in 24 Stunden", "1 change in 24 hours") : t(`${s.audit.day} Änderungen in 24 Stunden`, `${s.audit.day} changes in 24 hours`) },
    monitoring: {
      line:
        workers || alerts
          ? join(workers > 0 && t(`${workers} Dienste mit Fehler`, `${workers} workers failing`), alerts > 0 && t(`${alerts} Warnungen`, `${alerts} alerts`))
          : t(`Alles in Ordnung · ${s.monitoring.loginFailures} fehlgeschlagene Anmeldungen (24 Std.)`, `All fine · ${s.monitoring.loginFailures} failed sign-ins (24 h)`),
      tone: workers || alerts ? "error" : undefined,
      badge: workers ? s.monitoring.failingWorkers.join(", ") : alerts ? t("Warnung", "Alert") : undefined,
    },
    general: {
      line: join(`v${s.general.version}`, s.general.name),
      tone: s.general.update ? "info" : undefined,
      badge: s.general.update ? t(`${s.general.update} verfügbar`, `${s.general.update} available`) : undefined,
    },
  };
}
