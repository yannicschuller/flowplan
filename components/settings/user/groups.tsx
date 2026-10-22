"use client";
// Settings → Arbeitsbereich → Gruppen & Rechte: groups and their members,
// SSO group mappings, and the access of groups to spaces. Owners only.
import { useState } from "react";
import { Globe, Lock, Plus, ShieldCheck, Users } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { Select } from "../../select";
import { SsoMappings } from "../../sso-mappings";
import { useUserSettings } from "../user-context";
import { useSsoVia } from "./sso-via";

export default function GroupsSection() {
  const t = useT();
  const { boot, owner, workspace: settings, act, onError } = useUserSettings();
  const { ssoVia, ssoNotice } = useSsoVia();
  const [groupName, setGroupName] = useState(""),
    [groupId, setGroupId] = useState<string | null>(null);
  if (!owner)
    return (
      <div className="empty-state">
        <ShieldCheck size={36} />
        <h3>{t("Nur für Eigentümer", "Owners only")}</h3>
        <p>{t("Gruppen und Berechtigungen verwaltet ein Eigentümer des Arbeitsbereichs.", "Groups and permissions are managed by an owner of the workspace.")}</p>
      </div>
    );
  return (
    <>
      <section className="settings-section">
        <h2>{t("Gruppen", "Groups")}</h2>
        <p className="muted">{t("Fasse Mitglieder zusammen und vergebe gemeinsame Rechte für Bereiche.", "Bring members together and give them shared permissions for spaces.")}</p>
        <form
          className="invite-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "group.create", name: groupName })) setGroupName("");
          }}
        >
          <input required value={groupName} aria-label={t("Gruppenname", "Group name")} onChange={(e) => setGroupName(e.target.value)} placeholder={t("Neue Gruppe", "New group")} />
          <button className="button primary">
            <Plus />
            {t("Erstellen", "Create")}
          </button>
        </form>
        {settings?.groups.map((g) => (
          <div className="utility-row" key={g.id}>
            <Users />
            <strong>{g.name}</strong>
            <span>
              {settings.groupMembers.filter((m) => m.group_id === g.id).length} {t("Mitglieder", "Members")}
            </span>
            <button className="button compact" onClick={() => setGroupId(g.id)}>
              {t("Verwalten", "Manage")}
            </button>
          </div>
        ))}
      </section>
      {(settings?.sso || !!settings?.ssoMappings?.length) && (
        <section className="settings-section">
          <h2>{t("SSO-Gruppen", "SSO groups")}</h2>
          <p className="muted">
            {t(
              "Ordne Gruppen aus deinem Identitätsanbieter einer Rolle in diesem Arbeitsbereich und/oder einer Gruppe zu. Bei jeder SSO-Anmeldung kommen passende Personen hinzu; wer die SSO-Gruppe nicht mehr hat, verliert, was die Zuordnung gegeben hat. Die Zuordnung hat immer Vorrang: Rollen und Gruppen, die von Hand geändert wurden, setzt die nächste SSO-Anmeldung wieder so, wie die Zuordnung sagt. Der letzte Eigentümer bleibt immer.",
              "Map groups from your identity provider to a role in this workspace and/or to a group. At every SSO sign-in matching people are added; whoever no longer has the SSO group loses what the mapping gave. The mapping always wins: roles and groups changed by hand are set back to what the mapping says at the next SSO sign-in. The last owner always stays.",
            )}{" "}
            {!boot.user.isAdmin && t("Zuordnungen legt die Administration der Instanz an.", "Mappings are set up by the instance's administrators.")}
          </p>
          <SsoMappings
            mappings={settings?.ssoMappings || []}
            groups={settings?.groups || []}
            workspaceId={boot.workspace.id}
            onAdd={(_, m) => act({ action: "sso.mapping.add", ...m })}
            onDelete={(_, mappingId) => act({ action: "sso.mapping.delete", id: mappingId })}
            readOnly={!boot.user.isAdmin}
          />
        </section>
      )}
      <section className="settings-section">
        <h2>{t("Bereiche & Zugriffsrechte", "Spaces & access")}</h2>
        {(boot.managedSpaces || boot.spaces).map((s) => (
          <div className="space-settings" key={s.id}>
            <div className="utility-row">
              {s.visibility === "private" ? <Lock /> : <Globe />}
              <strong>{s.name}</strong>
              <Select
                aria-label={t(`Sichtbarkeit ${s.name}`, `Visibility ${s.name}`)}
                value={s.visibility}
                onChange={(e) => act({ action: "space.update", spaceId: s.id, name: s.name, version: s.version, private: e.target.value === "private" })}
              >
                <option value="team">{t("Gesamtes Team", "Whole team")}</option>
                <option value="private">{t("Nur Berechtigte", "Only people with access")}</option>
              </Select>
            </div>
            {settings?.groups.map((g) => (
              <div className="permission-row" key={g.id}>
                <Users size={16} />
                <span>{g.name}</span>
                <Select
                  aria-label={t(`Rechte ${g.name} in ${s.name}`, `Permissions of ${g.name} in ${s.name}`)}
                  value={settings.grants.find((x) => x.resource_id === s.id && x.group_id === g.id)?.role || "remove"}
                  onChange={(e) => act({ action: "grant.set", resourceId: s.id, groupId: g.id, role: e.target.value })}
                >
                  <option value="remove">{t("Keine zusätzlichen Rechte", "No additional permissions")}</option>
                  <option value="viewer">{t("Ansehen", "View")}</option>
                  <option value="editor">{t("Bearbeiten", "Edit")}</option>
                </Select>
              </div>
            ))}
          </div>
        ))}
      </section>
      <Modal open={!!groupId} onClose={() => setGroupId(null)} title={settings?.groups.find((g) => g.id === groupId)?.name || t("Gruppe", "Group")}>
        {boot.members.map((m) => (
          <label className="member-row checkbox-label" key={m.id}>
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
              {!!groupId && !!ssoVia(m.id, groupId) && <small>{t(`über SSO-Gruppe „${ssoVia(m.id, groupId)}“`, `via SSO group “${ssoVia(m.id, groupId)}”`)}</small>}
            </span>
          </label>
        ))}
      </Modal>
    </>
  );
}
