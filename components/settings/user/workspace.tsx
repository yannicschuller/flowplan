"use client";
// Settings → Arbeitsbereich → Allgemein: name and icon, inbound e-mail
// (owners), archiving, leaving and deleting.
import { useState } from "react";
import { useT } from "../../i18n";
import { SettingGroup } from "../../settings-ui";
import { WorkspaceIconPicker } from "../../workspace-icon";
import { InboundMailSettings } from "../../inbound-mail-settings";
import { WorkspaceLifecycle } from "../../workspace-lifecycle";
import { useUserSettings } from "../user-context";

export default function WorkspaceSection() {
  const t = useT();
  const { boot, owner, act, onError, onWorkspaceExit } = useUserSettings();
  const [name, setName] = useState(boot.workspace.name);
  return (
    <>
      <SettingGroup title={t("Arbeitsbereich", "Workspace")} description={owner ? undefined : t("Nur Eigentümer ändern Name und Symbol.", "Only owners change the name and icon.")}>
        <form
          className="setting-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act({ action: "workspace.update", name })) onError(t("Arbeitsbereich gespeichert", "Workspace saved"));
          }}
        >
          <div className="workspace-identity">
            <WorkspaceIconPicker name={boot.workspace.name} icon={boot.workspace.icon} disabled={!owner} save={(icon) => act({ action: "workspace.update", icon })} />
            <label>
              {t("Name", "Name")}
              <input value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} />
            </label>
          </div>
          {owner && (
            <div className="setting-control">
              <button className="button primary" disabled={name.trim() === boot.workspace.name || !name.trim()}>
                {t("Speichern", "Save")}
              </button>
            </div>
          )}
        </form>
      </SettingGroup>
      {owner && <InboundMailSettings workspaceId={boot.workspace.id} pages={boot.pages} onError={onError} />}
      <WorkspaceLifecycle key={boot.workspace.id} boot={boot} onExit={onWorkspaceExit} />
    </>
  );
}
