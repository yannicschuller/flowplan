"use client";
// Administration → Grenzen & Aufbewahrung: the defaults for storage, own
// workspaces and uploads, and how long page versions are kept. Single
// workspaces and people can differ (Arbeitsbereiche, Benutzer).
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, InstanceNumber, InstanceSelect, InstanceSwitch } from "./parts";
import { WorkflowLimits } from "./workflow-limits";

export default function LimitsSection() {
  const t = useT();
  const { data } = useAdminData();
  if (!data) return <AdminLoading />;
  const s = data.settings;
  const unlimited = t("unbegrenzt", "unlimited");
  const quota = s.defaultQuotaMb ?? data.metrics.defaultQuotaMb;
  const owner = data.storageAccounting?.current === "owner";
  const envAccounting = data.storageAccounting?.env ?? "uploader";
  const accountingLabel = (mode: "uploader" | "owner") =>
    mode === "owner" ? t("Eigentümer des Arbeitsbereichs", "Workspace owner") : t("Hochladende Person", "Uploader");
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
          {
            tone: (s.trashDays ?? 30) > 0 ? "info" : "off",
            label: (s.trashDays ?? 30) > 0 ? t(`Papierkorb ${s.trashDays ?? 30} Tage`, `Trash ${s.trashDays ?? 30} days`) : t("Papierkorb ohne Frist", "Trash kept until emptied"),
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
          description={
            owner
              ? t("Alle Dateien in den Arbeitsbereichen, die eine Person angelegt hat – egal, wer sie hochlädt.", "All files in the workspaces a person created – whoever uploads them.")
              : t("Alles, was eine Person hochlädt oder kopiert – über alle Arbeitsbereiche.", "Everything a person uploads or copies – across all workspaces.")
          }
          unit="MB"
          placeholder={unlimited}
        />
        <InstanceSelect
          field="storageAccounting"
          label={t("Speicher zählt bei", "Storage counts for")}
          description={t(
            "Wessen Speicher eine Datei belegt: die Person, die sie hochlädt, oder die Person, die den Arbeitsbereich angelegt hat (für gehostete Angebote).",
            "Whose storage a file uses: the person who uploads it, or the person who created the workspace (for hosted offerings).",
          )}
          standard={t(`Wie in der Umgebung (${accountingLabel(envAccounting)})`, `As in the environment (${accountingLabel(envAccounting)})`)}
          options={[
            { value: "uploader", label: accountingLabel("uploader") },
            { value: "owner", label: accountingLabel("owner") },
          ]}
        />
        <InstanceNumber
          field="defaultUserWorkspaces"
          label={t("Eigene Arbeitsbereiche je Person", "Own workspaces per person")}
          description={
            owner
              ? t("Wie viele Arbeitsbereiche eine Person anlegen darf.", "How many workspaces a person may create.")
              : t("Wie viele Arbeitsbereiche eine Person besitzen darf.", "How many workspaces a person may own.")
          }
          max={10000}
          placeholder={unlimited}
        />
        <InstanceNumber
          field="maxUploadMb"
          label={t("Größte Datei beim Hochladen", "Largest upload")}
          description={t(
            "Für jede einzelne Datei; je Person änderbar. Gilt auch für Importe aus AFFiNE (mindestens 100 MB).",
            "For each single file; can differ per person. Also applies to imports from AFFiNE (at least 100 MB).",
          )}
          unit="MB"
          min={1}
          max={1024}
          fallback={10}
        />
        <InstanceSwitch
          field="defaultUserAi"
          label={t("KI je Person", "AI per person")}
          description={t("Ob Personen ohne eigene Einstellung KI nutzen dürfen (Administration → KI regelt den Rest).", "Whether people without their own setting may use AI (Administration → AI decides the rest).")}
        />
        <InstanceNumber
          field="defaultUserAiTokensPerMonth"
          label={t("KI-Tokens je Person und Monat", "AI tokens per person and month")}
          description={t("Über den KI-Anbieter der Instanz, je Kalendermonat. Leer oder 0 = unbegrenzt.", "Through the instance's AI provider, per calendar month. Empty or 0 = unlimited.")}
          max={1_000_000_000}
          placeholder={unlimited}
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
        <InstanceNumber
          field="trashDays"
          label={t("Papierkorb leeren nach", "Empty the trash after")}
          description={t(
            "Gelöschte Seiten, Bereiche, Datenbankeinträge und Vorlagen werden nach so vielen Tagen im Papierkorb endgültig gelöscht – mit ihren Dateien. 0 = nie automatisch.",
            "Deleted pages, spaces, database records and templates are deleted permanently after this many days in the trash – with their files. 0 = never automatically.",
          )}
          unit={t("Tage", "days")}
          max={3650}
          fallback={30}
          placeholder="30"
        />
      </SettingGroup>
      <WorkflowLimits />
    </>
  );
}
