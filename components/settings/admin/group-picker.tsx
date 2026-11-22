"use client";
// Choosing a group for a limit (Administration → KI → Kontingente and
// Grenzen & Aufbewahrung → Grenzen pro Gruppe): the workspace groups and
// the directory groups known so far (SCIM, LDAP, the names of the SSO group
// mappings), and a directory group by name that does not exist yet
// (lib/group-keys.ts).
import { useId, useState, type ReactNode } from "react";
import { Plus } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Select } from "../../select";
import { SettingRow } from "../../settings-ui";
import { directoryKey, MAX_DIRECTORY_NAME, type GroupChoice } from "@/lib/group-keys";

type T = (de: string, en: string) => string;

export const groupLabel = (g: Pick<GroupChoice, "name" | "workspace" | "directory">, t: T) => (g.directory ? `${t("Verzeichnis", "Directory")} · ${g.name}` : `${g.workspace ?? "–"} · ${g.name}`);

// The options of a group <Select>: workspace groups and directory groups
// that have no limit yet (`taken`: their keys).
export function GroupOptions({ groups, taken, prefix = "" }: { groups: GroupChoice[]; taken: Set<string>; prefix?: string }) {
  const t = useT();
  const free = groups.filter((g) => !taken.has(g.id));
  const workspace = free.filter((g) => !g.directory),
    directory = free.filter((g) => g.directory);
  return (
    <>
      {workspace.length > 0 && (
        <optgroup label={t("Gruppen der Arbeitsbereiche", "Workspace groups")}>
          {workspace.map((g) => (
            <option key={g.id} value={`${prefix}${g.id}`}>
              {groupLabel(g, t)}
            </option>
          ))}
        </optgroup>
      )}
      {directory.length > 0 && (
        <optgroup label={t("Verzeichnisgruppen (SCIM, LDAP, SSO)", "Directory groups (SCIM, LDAP, SSO)")}>
          {directory.map((g) => (
            <option key={g.id} value={`${prefix}${g.id}`}>
              {groupLabel(g, t)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

// A row: pick a group, or type the name of a directory group.
export function GroupPicker({ label, description, groups, taken, onPick, extra }: { label: string; description?: ReactNode; groups: GroupChoice[]; taken: Set<string>; onPick: (key: string) => void; extra?: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <>
      <SettingRow id={id} label={label} description={description}>
        <Select id={id} value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
          <option value="">{t("Auswählen …", "Choose …")}</option>
          {extra}
          <GroupOptions groups={groups} taken={taken} />
        </Select>
      </SettingRow>
      <DirectoryGroupInput taken={taken} onAdd={onPick} />
    </>
  );
}

// A directory group by its name – also one the directory has not pushed yet.
export function DirectoryGroupInput({ taken, onAdd }: { taken: Set<string>; onAdd: (key: string) => void }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState("");
  const key = directoryKey(name.trim());
  const ok = name.trim().length > 0 && !taken.has(key);
  const add = () => {
    if (!ok) return;
    onAdd(key);
    setName("");
  };
  return (
    <SettingRow
      id={id}
      label={t("Verzeichnisgruppe nach Name", "Directory group by name")}
      description={t(
        "Der Name einer SCIM-, LDAP- oder SSO-Gruppe, genau wie bei den SSO-Zuordnungen – gilt ohne Arbeitsbereich, auch für Konten mit E-Mail und Passwort, die das Verzeichnis als Mitglied führt.",
        "The name of a SCIM, LDAP or SSO group, exactly as for the SSO mappings – applies without a workspace, also to accounts with e-mail and password that the directory lists as members.",
      )}
    >
      <span className="group-picker-name">
        <input
          id={id}
          className="control-md"
          maxLength={MAX_DIRECTORY_NAME}
          placeholder={t("z. B. Team Plus", "e.g. Team Plus")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button compact" disabled={!ok} onClick={add}>
          <Plus size={15} aria-hidden /> {t("Hinzufügen", "Add")}
        </button>
      </span>
    </SettingRow>
  );
}
