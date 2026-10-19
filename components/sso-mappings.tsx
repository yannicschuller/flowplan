"use client";
// SSO groups → workspace role and/or workspace group (lib/sso-mappings.ts).
// Used per workspace in Settings → Groups & permissions, and for any
// workspace in the administration.
import { useState } from "react";
import { IdentificationCard, Plus, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Select } from "./select";

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
          ? t("Ansehen", "View")
          : "";
  const groupsOf = (ws: string) =>
    groups.filter((g) => !g.workspace_id || g.workspace_id === ws);
  const groupName = (id: string | null) =>
    groups.find((g) => g.id === id)?.name || "";
  const workspaceName = (id: string) =>
    workspaces?.find((w) => w.id === id)?.name || "";
  return (
    <div className="sso-mappings">
      {!readOnly && (
        <form
          className="invite-form"
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
          {workspaces && (
            <Select
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
          )}
          <input
            required
            value={ssoGroup}
            maxLength={200}
            aria-label={t("SSO-Gruppe", "SSO group")}
            placeholder={t(
              "SSO-Gruppe, z. B. marketing",
              "SSO group, e.g. marketing",
            )}
            onChange={(e) => setSsoGroup(e.target.value)}
          />
          <Select
            aria-label={t("Rolle im Arbeitsbereich", "Role in the workspace")}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">
              {t("Keine Mitgliedschaft", "No membership")}
            </option>
            <option value="viewer">{t("Ansehen", "View")}</option>
            <option value="editor">{t("Bearbeiten", "Edit")}</option>
            <option value="owner">{t("Eigentümer", "Owner")}</option>
          </Select>
          <Select
            aria-label={t("Gruppe im Arbeitsbereich", "Group in the workspace")}
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">{t("Keine Gruppe", "No group")}</option>
            {groupsOf(target).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <button className="button primary" disabled={!role && !groupId}>
            <Plus />
            {t("Zuordnen", "Map")}
          </button>
        </form>
      )}
      {mappings.map((m) => (
        <div className="utility-row" key={m.id}>
          <IdentificationCard />
          <strong>{m.sso_group}</strong>
          <span>
            {[
              workspaces ? workspaceName(m.workspace_id) : null,
              m.role
                ? t(
                    `Mitglied: ${roleName(m.role)}`,
                    `Member: ${roleName(m.role)}`,
                  )
                : null,
              m.group_id
                ? t(
                    `Gruppe: ${groupName(m.group_id)}`,
                    `Group: ${groupName(m.group_id)}`,
                  )
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {!readOnly && (
            <button
              type="button"
              className="icon-button"
              title={t("Zuordnung entfernen", "Remove mapping")}
              aria-label={t(
                `Zuordnung für ${m.sso_group} entfernen`,
                `Remove the mapping for ${m.sso_group}`,
              )}
              onClick={() => void onDelete(m.workspace_id, m.id)}
            >
              <X size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
