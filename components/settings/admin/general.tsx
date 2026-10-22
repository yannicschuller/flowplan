"use client";
// Administration → Instanz: the instance's name and public demo, the running
// version and whether a newer one is out. The other instance settings live
// where they belong: registration and two-factor under Anmeldung & SSO,
// limits under Grenzen & Aufbewahrung, backups under Speicher & Sicherung,
// the notice under Wartung & Hinweise, extensions and domains under
// Erweiterungen & Domains.
import { ArrowCircleUp } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { SettingGroup, SettingRow } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, FixLink, InstanceSwitch, InstanceText, useDocs } from "./parts";

export default function GeneralSection() {
  const t = useT();
  const docs = useDocs();
  const { data } = useAdminData();
  if (!data) return <AdminLoading />;
  const build = data.build;
  const update = data.update;
  return (
    <>
      <AdminStatus
        items={[
          {
            tone: "ok",
            label: build?.version ? `v${build.version}` : t("Version unbekannt", "Version unknown"),
          },
          update
            ? {
                tone: "info",
                label: t(`${update.latest} verfügbar`, `${update.latest} available`),
              }
            : { tone: "ok", label: t("Aktuell", "Up to date") },
        ]}
      />
      {update && (
        <div className="callout admin-update" role="status">
          <ArrowCircleUp size={20} aria-hidden="true" />
          <span>
            <strong>{t(`Flowplan ${update.latest} ist verfügbar.`, `Flowplan ${update.latest} is available.`)}</strong>{" "}
            {t(`Diese Instanz läuft mit ${update.current}.`, `This instance runs ${update.current}.`)}
          </span>
          <span className="admin-update-links">
            {update.url && (
              <a href={update.url} target="_blank" rel="noreferrer">
                {t("Was ist neu", "What's new")}
              </a>
            )}
            <a href={docs("installation", "aktualisieren", "update")} target="_blank" rel="noreferrer">
              {t("So aktualisierst du", "How to update")}
            </a>
          </span>
        </div>
      )}
      <SettingGroup
        id="instance"
        title={t("Instanz", "Instance")}
        description={t("Wie die Instanz heißt und was Besucher ohne Konto dürfen.", "What the instance is called and what visitors without an account may do.")}
      >
        <InstanceText
          field="name"
          maxLength={60}
          label={t("Name der Instanz", "Instance name")}
          description={t("Erscheint bei der Anmeldung und im Browser-Tab.", "Shown when signing in and in the browser tab.")}
          placeholder={t("z. B. Flowplan der Muster GmbH", "e.g. Flowplan of Example Ltd")}
        />
        <InstanceSwitch
          field="publicDemo"
          label={t("Öffentliche Demo", "Public demo")}
          description={t(
            "Besucher bekommen unter /demo ohne Konto einen Arbeitsbereich mit Beispielen. Er verschwindet nach 45 Minuten ohne Aktivität (spätestens nach 3 Stunden). Demos können nichts veröffentlichen, teilen oder einladen.",
            "Visitors get a workspace with examples at /demo without an account. It disappears after 45 minutes without activity (3 hours at the latest). Demos cannot publish, share or invite.",
          )}
        />
      </SettingGroup>
      <SettingGroup id="version" title={t("Version", "Version")}>
        <SettingRow
          label={t("Laufende Version", "Running version")}
          description={build?.builtAt ? t(`Gebaut am ${new Date(build.builtAt).toLocaleString(LOCALE_TAG)}`, `Built on ${new Date(build.builtAt).toLocaleString(LOCALE_TAG)}`) : undefined}
        >
          {build && (
            <span className="admin-build" aria-label={t("Laufende Version", "Running version")}>
              {build.version && <strong>v{build.version}</strong>}
              {build.commit ? (
                <a href={`${build.repository}/commit/${build.commit}`} target="_blank" rel="noreferrer" title={t(`Commit ${build.commit} auf GitHub ansehen`, `View commit ${build.commit} on GitHub`)}>
                  <code>{build.commit.slice(0, 7)}</code>
                </a>
              ) : (
                <span title={t("Beim Bauen war kein Commit bekannt (GIT_COMMIT oder SOURCE_COMMIT).", "No commit was known when building (GIT_COMMIT or SOURCE_COMMIT).")}>
                  {t("Commit unbekannt", "commit unknown")}
                </span>
              )}
            </span>
          )}
        </SettingRow>
        <SettingRow
          label={t("Admin-Gruppe", "Admin group")}
          description={t("Personen dieser SSO- oder LDAP-Gruppe verwalten die Instanz (OIDC_ADMIN_GROUP).", "People in this SSO or LDAP group administer the instance (OIDC_ADMIN_GROUP).")}
        >
          <code>{data.adminGroup}</code>
        </SettingRow>
      </SettingGroup>
      <SettingGroup id="moved" title={t("Weitere Einstellungen der Instanz", "More instance settings")}>
        <SettingRow label={t("Registrierung, Zwei-Faktor, SSO", "Sign-up, two-factor, SSO")}>
          <FixLink href="#admin/signin">{t("Anmeldung & SSO", "Sign-in & SSO")}</FixLink>
        </SettingRow>
        <SettingRow label={t("Kontingente, Uploads, Versionen", "Quotas, uploads, versions")}>
          <FixLink href="#admin/limits">{t("Grenzen & Aufbewahrung", "Limits & retention")}</FixLink>
        </SettingRow>
        <SettingRow label={t("Geplante Sicherung", "Scheduled backup")}>
          <FixLink href="#admin/storage/backup">{t("Speicher & Sicherung", "Storage & backup")}</FixLink>
        </SettingRow>
        <SettingRow label={t("Hinweis für alle, Wartung", "Notice for everyone, maintenance")}>
          <FixLink href="#admin/maintenance">{t("Wartung & Hinweise", "Maintenance & notices")}</FixLink>
        </SettingRow>
        <SettingRow label={t("Block-Erweiterungen, eigene Domains", "Block extensions, custom domains")}>
          <FixLink href="#admin/extensions">{t("Erweiterungen & Domains", "Extensions & domains")}</FixLink>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
