"use client";
// Settings → Arbeitsbereich → Allgemein: name and icon, inbound e-mail
// (owners), and – in the danger zone at the end – leaving and deleting.
import { useState } from "react";
import { useT } from "../../i18n";
import { CONTROL, SaveState, SettingGroup, SettingRow, useSaveState, type SaveStatus } from "../../settings-ui";
import { WorkspaceIconPicker } from "../../workspace-icon";
import { InboundMailSettings } from "../../inbound-mail-settings";
import { WorkspaceLifecycle } from "../../workspace-lifecycle";
import { useUserSettings } from "../user-context";

export default function WorkspaceSection() {
  const t = useT();
  const { boot, owner, mutate, reload, onError, onWorkspaceExit } = useUserSettings();
  const [name, setName] = useState(boot.workspace.name);
  const [nameStatus, saveName] = useSaveState();
  const [iconSaved, setIconSaved] = useState<SaveStatus>({ state: "idle" });
  const update = (body: Record<string, unknown>) => async () => {
    await mutate({ action: "workspace.update", workspaceId: boot.workspace.id, ...body });
    await reload();
  };
  return (
    <>
      <SettingGroup
        id="identity"
        title={t("Name & Symbol", "Name & icon")}
        description={owner ? t("So erscheint der Arbeitsbereich im Umschalter und in Einladungen.", "This is how the workspace appears in the switcher and in invitations.") : t("Nur Eigentümer ändern Name und Symbol.", "Only owners change the name and icon.")}
      >
        <SettingRow label={t("Symbol", "Icon")} description={t("Ein Emoji, ein Symbol oder ein Bild; sonst der erste Buchstabe.", "An emoji, an icon or a picture; otherwise the first letter.")}>
          <WorkspaceIconPicker
            name={boot.workspace.name}
            icon={boot.workspace.icon}
            disabled={!owner}
            save={async (icon) => {
              // The picker shows a failure itself; the row says "saved".
              setIconSaved({ state: "saving" });
              try {
                await update({ icon })();
                setIconSaved({ state: "saved" });
                setTimeout(() => setIconSaved((s) => (s.state === "saved" ? { state: "idle" } : s)), 3000);
              } catch (e) {
                setIconSaved({ state: "idle" });
                throw e;
              }
            }}
          />
          <SaveState status={iconSaved} />
        </SettingRow>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== boot.workspace.name) void saveName(update({ name: name.trim() }));
          }}
        >
          <SettingRow label={t("Name", "Name")} id="workspace-name">
            <input id="workspace-name" className={CONTROL.lg} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} disabled={!owner} />
            {owner && (
              <button className="button primary" disabled={nameStatus.state === "saving" || name.trim() === boot.workspace.name || !name.trim()}>
                {t("Speichern", "Save")}
              </button>
            )}
            <SaveState status={nameStatus} />
          </SettingRow>
        </form>
      </SettingGroup>
      {owner && <InboundMailSettings workspaceId={boot.workspace.id} pages={boot.pages} onError={onError} />}
      <WorkspaceLifecycle key={boot.workspace.id} boot={boot} onExit={onWorkspaceExit} />
    </>
  );
}
