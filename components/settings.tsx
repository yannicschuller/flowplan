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
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useAiQuota } from "./ai-quota";
import { quotaPossible } from "@/lib/limits-summary";
import { combinedSettings, useSettingsVariant } from "@/lib/settings-variant";
import CombinedSettings, { AdminBridge, useAdminTiles } from "./settings/variants";

const SECTIONS = sectionDefs("settings");
const GROUPS = groupsOf("settings");
const ADMIN_SECTIONS = sectionDefs("admin");

export default function Settings(props: UserSettingsProps) {
  // PROTOTYPE (lib/settings-variant.ts): one screen for both areas.
  const variant = useSettingsVariant();
  if (variant && combinedSettings(variant)) return <CombinedSettings {...props} variant={variant} />;
  return <SeparateSettings {...props} bridge={variant === "d" && !!props.boot.user.isAdmin} />;
}

function SeparateSettings({ bridge, ...props }: UserSettingsProps & { bridge: boolean }) {
  const t = useT();
  const adminTiles = useAdminTiles(bridge);
  const { boot } = props;
  // The settings level (#294, lib/settings-level.ts): what Settings shows.
  const level = useSettingsLevel();
  // The Speicher & KI tile's AI bar.
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
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
        summaries={userTiles(boot, props.theme, t, quota, LOCALE_TAG)}
        searchSections={bridge ? ADMIN_SECTIONS : undefined}
        after={bridge ? <AdminBridge summary={adminTiles.monitoring} /> : undefined}
        level={{ value: level, onChange: (next) => void setOwnSettingsLevel(props.mutate, next).catch((e) => props.onError((e as Error).message)) }}
      />
    </UserSettingsProvider>
  );
}
