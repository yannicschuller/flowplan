"use client";
// Administration → Grenzen & Aufbewahrung: the defaults for storage, own
// workspaces and uploads, and how long page versions are kept. Single
// workspaces and people can differ (Arbeitsbereiche, Benutzer).
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, InstanceNumber } from "./parts";

export default function LimitsSection() {
  const t = useT();
  const { data } = useAdminData();
  if (!data) return <AdminLoading />;
  const s = data.settings;
  const unlimited = t("unbegrenzt", "unlimited");
  const quota = s.defaultQuotaMb ?? data.metrics.defaultQuotaMb;
  return (
    <>
      <AdminStatus
        items={[
          {
            tone: "info",
            label: t(`Upload bis ${s.maxUploadMb} MB`, `Uploads up to ${s.maxUploadMb} MB`),
          },
          {
            tone: quota ? "info" : "off",
            label: quota ? t(`${quota} MB je Arbeitsbereich`, `${quota} MB per workspace`) : t("Arbeitsbereiche unbegrenzt", "Workspaces unlimited"),
          },
          {
            tone: data.metrics.retentionDays ? "info" : "off",
            label: data.metrics.retentionDays ? t(`Versionen ${data.metrics.retentionDays} Tage`, `Versions ${data.metrics.retentionDays} days`) : t("Versionen für immer", "Versions forever"),
          },
        ]}
      >
        {t("Standardwerte für alle. 0 = unbegrenzt; für Admins gelten keine Grenzen.", "Defaults for everyone. 0 = unlimited; admins are not limited.")}
      </AdminStatus>
      <SettingGroup
        id="storage-limits"
        title={t("Speicher und Uploads", "Storage and uploads")}
        description={
          <>
            {t("Abweichungen für einzelne Arbeitsbereiche und Personen:", "Exceptions for single workspaces and people:")}{" "}
            <a href="#admin/workspaces">{t("Arbeitsbereiche", "Workspaces")}</a>, <a href="#admin/users">{t("Benutzer", "Users")}</a>.
          </>
        }
      >
        <InstanceNumber
          field="defaultQuotaMb"
          label={t("Speicher je Arbeitsbereich", "Storage per workspace")}
          description={t("Dateien und Bilder aller Mitglieder zusammen. Leer = Wert aus der Umgebung.", "Files and images of all members together. Empty = value from the environment.")}
          unit="MB"
          placeholder={data.metrics.defaultQuotaMb ? String(data.metrics.defaultQuotaMb) : "∞"}
        />
        <InstanceNumber
          field="defaultUserStorageMb"
          label={t("Speicher je Person", "Storage per person")}
          description={t("Alles, was eine Person hochlädt oder kopiert – über alle Arbeitsbereiche.", "Everything a person uploads or copies – across all workspaces.")}
          unit="MB"
          placeholder={unlimited}
        />
        <InstanceNumber
          field="defaultUserWorkspaces"
          label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")}
          description={t("Wie viele Arbeitsbereiche eine Person besitzen darf.", "How many workspaces a person may own.")}
          max={10000}
          placeholder={unlimited}
        />
        <InstanceNumber
          field="maxUploadMb"
          label={t("Größte Datei beim Hochladen", "Largest upload")}
          description={t("Für jede einzelne Datei; je Person änderbar.", "For each single file; can differ per person.")}
          unit="MB"
          min={1}
          max={1024}
          fallback={10}
        />
      </SettingGroup>
      <SettingGroup
        id="retention"
        title={t("Aufbewahrung", "Retention")}
        description={t(
          "Wie lange ältere Stände aufbewahrt werden. Die Sicherungen stellst du unter Speicher & Sicherung ein.",
          "How long older states are kept. Backups are set under Storage & backup.",
        )}
      >
        <InstanceNumber
          field="retentionDays"
          label={t("Versionen aufbewahren", "Keep versions")}
          description={t(
            "Ältere Versionsstände von Seiten werden danach gelöscht. 0 = für immer, leer = Wert aus der Umgebung.",
            "Older page versions are deleted afterwards. 0 = forever, empty = value from the environment.",
          )}
          unit={t("Tage", "days")}
          max={36500}
          placeholder={data.metrics.retentionDays ? String(data.metrics.retentionDays) : "∞"}
        />
      </SettingGroup>
    </>
  );
}
