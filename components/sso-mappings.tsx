"use client";
// SSO groups → workspace role and/or workspace group (lib/sso-mappings.ts).
// Used per workspace in Settings → Groups & permissions, and for any
// workspace in the administration. Renders rows of the surrounding
// SettingGroup: the add form (fields in a grid, the button below them on
// the left), then the mappings as a ResponsiveTable with an empty state.
import { useState } from "react";
import { IdentificationCard, Plus, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";
import { EmptyState, ResponsiveTable, type Column } from "./settings-ui";

export type SsoMappingRow = {
  id: string;
  workspace_id: string;
  sso_group: string;
  role: "viewer" | "editor" | "owner" | null;
  group_id: string | null;
};
type Group = { id: string; name: string; workspace_id?: string };

export function SsoMappings({
  mappings,
  groups,
  workspaceId,
  workspaces,
  onAdd,
  onDelete,
  readOnly = false,
}: {
  mappings: SsoMappingRow[];
  groups: Group[];
  // Fixed workspace (settings), or a choice of workspaces (administration).
  workspaceId?: string;
  workspaces?: { id: string; name: string }[];
  onAdd: (
    workspaceId: string,
    mapping: { ssoGroup: string; role: string | null; groupId: string | null },
  ) => Promise<unknown>;
  onDelete: (workspaceId: string, id: string) => Promise<unknown> | void;
  // Owners who aren't instance admins see the mappings but can't change them.
  readOnly?: boolean;
}) {
  const t = useT();
  const [ssoGroup, setSsoGroup] = useState(""),
    [role, setRole] = useState("editor"),
    [groupId, setGroupId] = useState(""),
    [target, setTarget] = useState(workspaceId || workspaces?.[0]?.id || "");
  const roleName = (r: string | null) =>
    r === "owner"
      ? t("Eigentümer", "Owner")
      : r === "editor"
        ? t("Bearbeiten", "Edit")
        : r === "viewer"
          ? t("Ansehen", "View||role")
          : "";
  const groupsOf = (ws: string) =>
    groups.filter((g) => !g.workspace_id || g.workspace_id === ws);
  const groupName = (id: string | null) =>
    groups.find((g) => g.id === id)?.name || "";
  const workspaceName = (id: string) =>
    workspaces?.find((w) => w.id === id)?.name || "";
  const columns: Column<SsoMappingRow>[] = [
    {
      key: "sso",
      header: t("SSO-Gruppe", "SSO group"),
      primary: true,
      render: (m) => (
        <span className="sso-mapping-name">
          <IdentificationCard size={16} aria-hidden />
          <span className="ws-break">{m.sso_group}</span>
        </span>
      ),
    },
    ...(workspaces
      ? [
          {
            key: "workspace",
            header: t("Arbeitsbereich", "Workspace"),
            render: (m: SsoMappingRow) => workspaceName(m.workspace_id),
          },
        ]
      : []),
    {
      key: "role",
      header: t("Rolle", "Role"),
      render: (m) => (m.role ? roleName(m.role) : <span className="sso-mapping-none">{t("Keine Mitgliedschaft", "No membership")}</span>),
    },
    {
      key: "group",
      header: t("Gruppe", "Group"),
      render: (m) => (m.group_id ? groupName(m.group_id) : <span className="sso-mapping-none">{t("Keine Gruppe", "No group")}</span>),
    },
    ...(readOnly
      ? []
      : [
          {
            key: "remove",
            header: t("Entfernen", "Remove"),
            align: "end" as const,
            render: (m: SsoMappingRow) => (
              <button
                type="button"
                className="icon-button ws-danger-icon"
                title={t("Zuordnung entfernen", "Remove mapping")}
                aria-label={t(`Zuordnung für ${m.sso_group} entfernen`, `Remove the mapping for ${m.sso_group}`)}
                onClick={() => void onDelete(m.workspace_id, m.id)}
              >
                <X size={16} />
              </button>
            ),
          },
        ]),
  ];
  // Rows of the surrounding setting group: the form, then the mappings.
  return (
    <>
      {!readOnly && (
        <form
          className="setting-row wide sso-mapping-form"
          aria-label={t("Neue Zuordnung", "New mapping")}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!target || (!role && !groupId)) return;
            const ok = await onAdd(target, {
              ssoGroup: ssoGroup.trim(),
              role: role || null,
              groupId: groupId || null,
            });
            if (ok !== false) {
              setSsoGroup("");
              setGroupId("");
            }
          }}
        >
          <div className={`ws-form ws-form-inline${workspaces ? "" : " three"}`}>
            {workspaces && (
              <div className="ws-field">
                <label htmlFor="sso-map-workspace">{t("Arbeitsbereich", "Workspace")}</label>
                <Select
                  id="sso-map-workspace"
                  aria-label={t("Arbeitsbereich", "Workspace")}
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setGroupId("");
                  }}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="ws-field">
              <label htmlFor="sso-map-group">{t("SSO-Gruppe", "SSO group")}</label>
              <input id="sso-map-group" required value={ssoGroup} maxLength={200} placeholder={t("z. B. marketing", "e.g. marketing")} onChange={(e) => setSsoGroup(e.target.value)} />
            </div>
            <div className="ws-field">
              <label htmlFor="sso-map-role">{t("Rolle im Arbeitsbereich", "Role in the workspace")}</label>
              <Select id="sso-map-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">{t("Keine Mitgliedschaft", "No membership")}</option>
                <option value="viewer">{t("Ansehen", "View||role")}</option>
                <option value="editor">{t("Bearbeiten", "Edit")}</option>
                <option value="owner">{t("Eigentümer", "Owner")}</option>
              </Select>
            </div>
            <div className="ws-field">
              <label htmlFor="sso-map-target">{t("Gruppe im Arbeitsbereich", "Group in the workspace")}</label>
              <Select id="sso-map-target" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">{t("Keine Gruppe", "No group")}</option>
                {groupsOf(target).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="ws-form-actions">
              <button className="button primary" disabled={!ssoGroup.trim() || (!role && !groupId)}>
                <Plus aria-hidden />
                {t("Zuordnen", "Map||action")}
              </button>
            </div>
          </div>
        </form>
      )}
      <div className="setting-row wide sso-mapping-list">
        <ResponsiveTable
          label={t("Zuordnungen", "Mappings")}
          rows={mappings}
          rowKey={(m) => m.id}
          columns={columns}
          empty={
            <EmptyState icon={<IdentificationCard size={18} />} title={t("Noch keine Zuordnungen", "No mappings yet")}>
              {t(
                "Wer zu einer zugeordneten SSO-Gruppe gehört, bekommt Rolle und Gruppe bei der nächsten SSO-Anmeldung.",
                "Whoever belongs to a mapped SSO group gets the role and group at their next SSO sign-in.",
              )}
            </EmptyState>
          }
        />
      </div>
    </>
  );
}
