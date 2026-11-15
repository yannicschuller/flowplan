"use client";
// Settings: a landing page of tiles (personal, connections, the workspace)
// and one page per section (components/settings/user/*), addressed as
// #settings/<section>. docs/settings-architecture.md
import { GearSix } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { SettingsShell } from "./settings/shell";
import { groupsOf, sectionDefs } from "./settings/registry";
import { UserSettingsProvider, type UserSettingsProps } from "./settings/user-context";
import { userTiles } from "./settings/user/tiles";
import { setOwnSettingsLevel, useSettingsLevel } from "@/lib/settings-level-client";

const SECTIONS = sectionDefs("settings");
const GROUPS = groupsOf("settings");

export default function Settings(props: UserSettingsProps) {
  const t = useT();
  const { boot } = props;
  // The settings level (#294, lib/settings-level.ts): what Settings shows.
  const level = useSettingsLevel();
  return (
    <UserSettingsProvider {...props}>
      <SettingsShell
        area="settings"
        title={t("Einstellungen", "Settings")}
        description={t(`${boot.user.name} · Arbeitsbereich „${boot.workspace.name}“`, `${boot.user.name} · workspace “${boot.workspace.name}”`)}
        HeaderIcon={GearSix}
        sections={SECTIONS}
        groups={GROUPS}
        groupTitle={(g) => (g.id === "workspace" ? t(`Arbeitsbereich „${boot.workspace.name}“`, `Workspace “${boot.workspace.name}”`) : t(g.title.de, g.title.en))}
        summaries={userTiles(boot, props.theme, t)}
        level={{ value: level, onChange: (next) => void setOwnSettingsLevel(props.mutate, next).catch((e) => props.onError((e as Error).message)) }}
      />
    </UserSettingsProvider>
  );
}
