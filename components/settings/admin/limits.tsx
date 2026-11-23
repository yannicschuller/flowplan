"use client";
// Administration → Grenzen & Aufbewahrung: the defaults for storage, own
// workspaces and uploads, the limits per group, their export / import as
// one file (limits-file.tsx), and how long page versions are kept. Single workspaces and people can differ (Arbeitsbereiche,
// Benutzer).
import { Trash } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { ResponsiveTable, SaveState, SettingGroup, useSaveState } from "../../settings-ui";
import { useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { AdminStatus, InstanceNumber, InstanceText, NumberInput } from "./parts";
import { WorkflowLimits } from "./workflow-limits";
import { GroupPicker, groupLabel } from "./group-picker";
import { LimitsFile } from "./limits-file";
import { Select } from "../../select";
import type { GroupLimitRule, GroupLimits, StorageMode, UserLimits } from "@/lib/user-limits";

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
          description={t(
            "Für jede einzelne Datei; je Person änderbar. Gilt auch für Importe aus AFFiNE (mindestens 100 MB).",
            "For each single file; can differ per person. Also applies to imports from AFFiNE (at least 100 MB).",
          )}
          unit="MB"
          min={1}
          max={1024}
          fallback={10}
        />
        <InstanceText
          field="moreLimitsUrl"
          label={t("Link für mehr Speicher oder KI", "Link for more storage or AI")}
          description={t(
            "Optional: eine Adresse, die Personen unter „Deine Grenzen“ sehen – etwa eine Seite, auf der sie mehr bekommen. Leer = kein Link.",
            "Optional: an address people see under “Your limits” – for example a page where they get more. Empty = no link.",
          )}
          placeholder="https://"
          maxLength={500}
        />
      </SettingGroup>
      <GroupLimits />
      <LimitsFile />
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

// "Grenzen pro Gruppe": storage, own workspaces and the largest upload for
// the members of a group (lib/user-limits.ts). Saved per row at once.
function GroupLimits() {
  const t = useT();
  const { data, mutate, load } = useAdminData();
  const [status, run] = useSaveState();
  const view = data?.groupLimits;
  if (!view) return null;
  const save = (target: string, limits: GroupLimits | null) =>
    void run(async () => {
      await mutate({ action: "admin.groupLimits", target, limits });
      await load();
    });
  const name = (target: string) => {
    const g = view.groups.find((x) => x.id === target);
    return g ? groupLabel(g, t) : t("Gelöschte Gruppe", "Deleted group");
  };
  const rows = [...view.rules].sort((a, b) => name(a.target).localeCompare(name(b.target)));
  const taken = new Set(rows.map((r) => r.target));
  const unlimited = t("unbegrenzt", "unlimited");
  const s = data.settings;
  const set = (rule: GroupLimitRule, field: keyof UserLimits, value: number | null) => {
    const next: GroupLimits = { ...rule.limits, [field]: value };
    if (value === null) delete next[field];
    save(rule.target, next);
  };
  // "Zusätzlich (Add-on)": the storage is added on top instead of competing.
  const setMode = (rule: GroupLimitRule, mode: StorageMode) => {
    const next: GroupLimits = { ...rule.limits, storageMode: mode };
    if (mode === "limit") delete next.storageMode;
    // 0 (unlimited) means nothing as an add-on.
    else if (next.storageMb === 0) delete next.storageMb;
    save(rule.target, next);
  };
  const members = (target: string) => view.groups.find((g) => g.id === target)?.members;
  return (
    <SettingGroup
      id="group-limits"
      title={t("Grenzen pro Gruppe", "Limits per group")}
      description={t(
        "Mehr (oder weniger) für die Mitglieder einer Gruppe. Für eine Person gilt ihr eigener Wert, sonst der großzügigste ihrer Gruppen (0 = unbegrenzt), sonst der Standard; Speicher-Add-ons kommen dazu. Leer = von der Gruppe nicht festgelegt. Für Admins gelten keine Grenzen.",
        "More (or less) for the members of a group. A person gets their own value, else the most generous of their groups (0 = unlimited), else the default; storage add-ons come on top. Empty = not set by the group. Admins are not limited.",
      )}
      actions={<SaveState status={status} />}
    >
      {rows.length > 0 && (
        <div className="mon-table group-limits-table">
          <ResponsiveTable
            label={t("Grenzen pro Gruppe", "Limits per group")}
            rows={rows}
            rowKey={(r) => r.target}
            columns={[
              {
                key: "name",
                header: t("Gruppe", "Group"),
                primary: true,
                render: (r) => (
                  <span>
                    {name(r.target)}
                    {members(r.target) !== undefined && <small className="limit-source">{t(`${members(r.target)} Mitglieder`, `${members(r.target)} members`)}</small>}
                  </span>
                ),
              },
              {
                key: "storage",
                header: t("Speicher (MB)", "Storage (MB)"),
                render: (r) => {
                  const addon = r.limits.storageMode === "add";
                  return (
                    <span className="group-limits-storage">
                      <NumberInput
                        value={r.limits.storageMb ?? null}
                        min={addon ? 1 : 0}
                        max={10_000_000}
                        label={t(`${name(r.target)}: Speicher`, `${name(r.target)}: storage`)}
                        placeholder={addon ? "+ MB" : s.defaultUserStorageMb ? String(s.defaultUserStorageMb) : unlimited}
                        onCommit={(v) => set(r, "storageMb", v)}
                      />
                      <Select
                        className="group-limits-mode"
                        aria-label={t(`${name(r.target)}: Art des Speichers`, `${name(r.target)}: kind of storage`)}
                        value={addon ? "add" : "limit"}
                        onChange={(e) => setMode(r, e.target.value === "add" ? "add" : "limit")}
                      >
                        <option value="limit">{t("Grenze", "Limit")}</option>
                        <option value="add">{t("Zusätzlich (Add-on)", "Additional (add-on)")}</option>
                      </Select>
                    </span>
                  );
                },
              },
              {
                key: "workspaces",
                header: t("Eigene Arbeitsbereiche", "Own workspaces"),
                render: (r) => <NumberInput value={r.limits.workspaces ?? null} max={10_000} label={t(`${name(r.target)}: eigene Arbeitsbereiche`, `${name(r.target)}: own workspaces`)} placeholder={s.defaultUserWorkspaces ? String(s.defaultUserWorkspaces) : unlimited} onCommit={(v) => set(r, "workspaces", v)} />,
              },
              {
                key: "upload",
                header: t("Größte Datei (MB)", "Largest file (MB)"),
                render: (r) => <NumberInput value={r.limits.uploadMb ?? null} min={1} max={1024} label={t(`${name(r.target)}: größte Datei`, `${name(r.target)}: largest file`)} placeholder={String(s.maxUploadMb)} onCommit={(v) => set(r, "uploadMb", v)} />,
              },
              {
                key: "remove",
                header: "",
                render: (r) => (
                  <button type="button" className="icon-button" aria-label={t(`Grenzen für ${name(r.target)} entfernen`, `Remove the limits for ${name(r.target)}`)} onClick={() => save(r.target, null)}>
                    <Trash size={16} />
                  </button>
                ),
              },
            ]}
          />
          <p className="limit-source group-limits-note">
            {t(
              "Zusätzlich (Add-on): der Speicher der Gruppe kommt zur Grenze der Person dazu (Gruppe oder Standard), statt mit ihren anderen Gruppen verglichen zu werden – nicht bei einem eigenen Wert der Person.",
              "Additional (add-on): the group’s storage is added to the person’s limit (a group or the default) instead of being compared with their other groups – not when the person has their own value.",
            )}
          </p>
        </div>
      )}
      <GroupPicker
        label={t("Gruppe hinzufügen", "Add a group")}
        description={t("Gruppen der Arbeitsbereiche (in allen Arbeitsbereichen einer Person) und Verzeichnisgruppen aus SCIM, LDAP und SSO.", "Workspace groups (in all of a person's workspaces) and directory groups from SCIM, LDAP and SSO.")}
        groups={view.groups}
        taken={taken}
        onPick={(target) => save(target, {})}
      />
    </SettingGroup>
  );
}
