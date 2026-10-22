"use client";
// Settings → Arbeitsbereich → Gruppen & Rechte: groups and their members,
// SSO group mappings, and the access of groups to spaces. Owners only.
import { useState } from "react";
import { MagnifyingGlass, Plus, ShieldCheck, Users } from "@phosphor-icons/react";
import type { Space } from "@/lib/types";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { Select } from "../../select";
import { SsoMappings } from "../../sso-mappings";
import { CONTROL, EmptyState, SaveState, SettingGroup, SettingRow, useSaveState } from "../../settings-ui";
import { useUserSettings } from "../user-context";
import { useSsoVia } from "./sso-via";

function SpaceAccess({ space: s }: { space: Space }) {
  const t = useT();
  const { boot, workspace: settings, mutate, reload } = useUserSettings();
  const [status, run] = useSaveState();
  const save = (body: Record<string, unknown>) =>
    run(async () => {
      await mutate({ workspaceId: boot.workspace.id, ...body });
      await reload();
    });
  const groups = settings?.groups || [];
  return (
    <div className="ws-space">
      <SettingRow
        label={s.name}
        id={`visibility-${s.id}`}
        description={s.visibility === "private" ? t("Nur Personen und Gruppen mit Zugriff sehen den Bereich.", "Only people and groups with access see the space.") : t("Alle Mitglieder sehen den Bereich.", "All members see the space.")}
      >
        <Select
          id={`visibility-${s.id}`}
          className={CONTROL.md}
          aria-label={t(`Sichtbarkeit ${s.name}`, `Visibility ${s.name}`)}
          value={s.visibility}
          onChange={(e) => void save({ action: "space.update", spaceId: s.id, name: s.name, version: s.version, private: e.target.value === "private" })}
        >
          <option value="team">{t("Gesamtes Team", "Whole team")}</option>
          <option value="private">{t("Nur Berechtigte", "Only people with access")}</option>
        </Select>
      </SettingRow>
      {groups.map((g) => (
        <div className="setting-row ws-sub" key={g.id}>
          <div className="setting-text">
            <label htmlFor={`grant-${s.id}-${g.id}`}>
              <Users size={15} aria-hidden /> {g.name}
            </label>
          </div>
          <div className="setting-control">
            <Select
              id={`grant-${s.id}-${g.id}`}
              className={CONTROL.md}
              aria-label={t(`Rechte ${g.name} in ${s.name}`, `Permissions of ${g.name} in ${s.name}`)}
              value={settings?.grants.find((x) => x.resource_id === s.id && x.group_id === g.id)?.role || "remove"}
              onChange={(e) => void save({ action: "grant.set", resourceId: s.id, groupId: g.id, role: e.target.value })}
            >
              <option value="remove">{t("Keine zusätzlichen Rechte", "No additional permissions")}</option>
              <option value="viewer">{t("Ansehen", "View")}</option>
              <option value="editor">{t("Bearbeiten", "Edit")}</option>
            </Select>
          </div>
        </div>
      ))}
      {status.state !== "idle" && (
        <div className="ws-space-state">
          <SaveState status={status} />
        </div>
      )}
    </div>
  );
}

export default function GroupsSection() {
  const t = useT();
  const { boot, owner, workspace: settings, act, onError } = useUserSettings();
  const { ssoVia, ssoNotice } = useSsoVia();
  const [groupName, setGroupName] = useState(""),
    [groupId, setGroupId] = useState<string | null>(null),
    [filter, setFilter] = useState("");
  if (!owner)
    return (
      <EmptyState icon={<ShieldCheck size={20} />} title={t("Nur für Eigentümer", "Owners only")}>
        {t("Gruppen und Berechtigungen verwaltet ein Eigentümer des Arbeitsbereichs.", "Groups and permissions are managed by an owner of the workspace.")}
      </EmptyState>
    );
  const groups = settings?.groups || [];
  const membersOf = (id: string) => boot.members.filter((m) => settings?.groupMembers.some((g) => g.group_id === id && g.user_id === m.id));
  const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const shown = boot.members.filter((m) => !filter.trim() || fold(`${m.name} ${m.email}`).includes(fold(filter.trim())));
  return (
    <>
      <SettingGroup id="groups" title={t("Gruppen", "Groups")} description={t("Fasse Mitglieder zusammen und vergebe gemeinsame Rechte für Bereiche.", "Bring members together and give them shared permissions for spaces.")}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "group.create", name: groupName })) setGroupName("");
          }}
        >
          <SettingRow label={t("Neue Gruppe", "New group")} id="new-group">
            <input id="new-group" required className={CONTROL.md} value={groupName} maxLength={200} aria-label={t("Gruppenname", "Group name")} onChange={(e) => setGroupName(e.target.value)} />
            <button className="button primary" disabled={!groupName.trim()}>
              <Plus aria-hidden />
              {t("Erstellen", "Create")}
            </button>
          </SettingRow>
        </form>
        {settings && !groups.length && (
          <div className="setting-row wide">
            <EmptyState icon={<Users size={20} />} title={t("Noch keine Gruppen", "No groups yet")}>
              {t("Mit Gruppen gibst du mehreren Personen auf einmal Zugriff auf private Bereiche.", "With groups you give several people access to private spaces at once.")}
            </EmptyState>
          </div>
        )}
        {!!groups.length && (
          <ul className="ws-list" aria-label={t("Gruppen", "Groups")}>
            {groups.map((g) => {
              const members = membersOf(g.id);
              return (
                <li className="ws-item ws-item-inline" key={g.id}>
                  <span className="ws-item-icon" aria-hidden>
                    <Users size={18} />
                  </span>
                  <div className="ws-item-text">
                    <strong>{g.name}</strong>
                    <small>{members.length ? `${members.length === 1 ? t("1 Mitglied", "1 member") : t(`${members.length} Mitglieder`, `${members.length} members`)} · ${members.slice(0, 3).map((m) => m.name).join(", ")}${members.length > 3 ? " …" : ""}` : t("Noch keine Mitglieder", "No members yet")}</small>
                  </div>
                  <div className="ws-item-controls">
                    <button className="button" aria-label={t(`Mitglieder von ${g.name} verwalten`, `Manage members of ${g.name}`)} onClick={() => setGroupId(g.id)}>
                      {t("Verwalten", "Manage")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingGroup>
      {(settings?.sso || !!settings?.ssoMappings?.length) && (
        <SettingGroup
          id="sso"
          title={t("SSO-Gruppen", "SSO groups")}
          description={
            <>
              {t(
                "Ordne Gruppen aus deinem Identitätsanbieter einer Rolle in diesem Arbeitsbereich und/oder einer Gruppe zu. Bei jeder SSO-Anmeldung kommen passende Personen hinzu; wer die SSO-Gruppe nicht mehr hat, verliert, was die Zuordnung gegeben hat. Die Zuordnung hat immer Vorrang: Rollen und Gruppen, die von Hand geändert wurden, setzt die nächste SSO-Anmeldung wieder so, wie die Zuordnung sagt. Der letzte Eigentümer bleibt immer.",
                "Map groups from your identity provider to a role in this workspace and/or to a group. At every SSO sign-in matching people are added; whoever no longer has the SSO group loses what the mapping gave. The mapping always wins: roles and groups changed by hand are set back to what the mapping says at the next SSO sign-in. The last owner always stays.",
              )}{" "}
              {!boot.user.isAdmin && t("Zuordnungen legt die Administration der Instanz an.", "Mappings are set up by the instance's administrators.")}
            </>
          }
        >
          <SsoMappings
            mappings={settings?.ssoMappings || []}
            groups={groups}
            workspaceId={boot.workspace.id}
            onAdd={(_, m) => act({ action: "sso.mapping.add", ...m })}
            onDelete={(_, mappingId) => act({ action: "sso.mapping.delete", id: mappingId })}
            readOnly={!boot.user.isAdmin}
          />
        </SettingGroup>
      )}
      <SettingGroup
        id="access"
        title={t("Zugriff auf Bereiche", "Access to spaces")}
        description={groups.length ? t("Wer jeden Bereich sieht und welche Gruppe darin zusätzlich ansehen oder bearbeiten darf.", "Who sees each space and which group may additionally view or edit in it.") : t("Wer jeden Bereich sieht. Mit Gruppen gibst du zusätzlich Rechte in einzelnen Bereichen.", "Who sees each space. With groups you can give extra permissions in single spaces.")}
      >
        {(boot.managedSpaces || boot.spaces).map((s) => (
          <SpaceAccess key={s.id} space={s} />
        ))}
      </SettingGroup>
      <Modal
        open={!!groupId}
        className="ws-sheet"
        onClose={() => {
          setGroupId(null);
          setFilter("");
        }}
        title={groups.find((g) => g.id === groupId)?.name || t("Gruppe", "Group")}
      >
        {boot.members.length > 6 && (
          <label className="ws-search">
            <MagnifyingGlass size={16} aria-hidden />
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("Mitglieder suchen", "Search members")} placeholder={t("Mitglieder suchen …", "Search members …")} />
          </label>
        )}
        <ul className="ws-checklist" aria-label={t("Mitglieder der Gruppe", "Members of the group")}>
          {shown.map((m) => (
            <li key={m.id}>
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={!!settings?.groupMembers.some((g) => g.group_id === groupId && g.user_id === m.id)}
                  onChange={async (e) => {
                    const changed = await act({ action: "group.member", groupId, userId: m.id, enabled: e.target.checked });
                    if (changed && groupId && ssoVia(m.id, groupId)) onError(ssoNotice);
                  }}
                />
                <Avatar name={m.name} userId={m.id} />
                <span>
                  {m.name}
                  <small>{groupId && ssoVia(m.id, groupId) ? t(`über SSO-Gruppe „${ssoVia(m.id, groupId)}“`, `via SSO group “${ssoVia(m.id, groupId)}”`) : m.email}</small>
                </span>
              </label>
            </li>
          ))}
          {!shown.length && <li className="ws-note">{t("Niemand heißt so.", "Nobody is called that.")}</li>}
        </ul>
      </Modal>
    </>
  );
}
