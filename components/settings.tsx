"use client";
// Settings (#532): one screen for the personal settings and – for admins –
// the instance, with one sidebar (components/settings/nav.tsx): Persönlich,
// Verbindungen, Arbeitsbereich, Hilfe & Info, then "Instanz" with Personen,
// Daten, Dienste, Sicherheit, Betrieb. #settings opens the start page
// (components/settings/start.tsx), #settings/<section> a personal section,
// #settings/instance/<section> one of the instance; the old #admin/… lead
// there (lib/settings-sections.ts). docs/settings-architecture.md
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { AdminSummary } from "@/lib/admin-summary";
import { settingsHash, type GroupMeta, type Text } from "@/lib/settings-sections";
import { sectionVisible } from "@/lib/settings-level";
import { setOwnSettingsLevel, useSettingsLevel } from "@/lib/settings-level-client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { quotaPossible } from "@/lib/limits-summary";
import { useT } from "./i18n";
import { api } from "./ui";
import { useAiQuota } from "./ai-quota";
import { SettingsDetail, useSettingsRoute, type TileSummary } from "./settings/shell";
import { groupsOf, sectionDefs, type SectionDef } from "./settings/registry";
import { UserSettingsProvider, type UserSettingsProps } from "./settings/user-context";
import { AdminProvider, useAdmin } from "./settings/admin-context";
import { userTiles } from "./settings/user/tiles";
import { adminTiles } from "./settings/admin/tiles";
import { SettingsNav } from "./settings/nav";
import { SettingsStart } from "./settings/start";

const USER = sectionDefs("settings");
const ADMIN = sectionDefs("admin");
const USER_GROUPS = groupsOf("settings");
const ADMIN_GROUPS = groupsOf("admin");
// Instance sections that refresh themselves (the live dashboard, the
// storage check and the push relay check have their own button): no
// second "Aktualisieren".
const OWN_REFRESH = new Set(["monitoring", "storage", "push"]);

export default function Settings(props: UserSettingsProps) {
  const admin = !!props.boot.user.isAdmin;
  return (
    <UserSettingsProvider {...props}>
      {admin ? (
        <AdminProvider mutate={props.mutate} onError={props.onError}>
          <SettingsScreen {...props} />
        </AdminProvider>
      ) : (
        <SettingsScreen {...props} />
      )}
    </UserSettingsProvider>
  );
}

// The instance's facts (/api/admin/summary) for the start page and the
// sidebar's lines; admins only. Loaded again whenever the start page shows
// (after changes in a section) and with "Aktualisieren".
function useAdminSummary(enabled: boolean, onHome: boolean, onError: (message: string) => void) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const load = useCallback(async () => {
    try {
      setSummary(await api<AdminSummary>("/api/admin/summary"));
    } catch (e) {
      errorRef.current((e as Error).message);
    }
  }, []);
  const loaded = summary !== null;
  useEffect(() => {
    if (enabled && (onHome || !loaded)) void load();
    // Only a change of page loads again, not the answer itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onHome, load]);
  return { summary, load };
}

// "Aktualisieren" in the header of an instance section: the section's data
// (/api/admin) and the summary.
function AdminRefresh({ onSummary }: { onSummary: () => void }) {
  const t = useT();
  const { data, load } = useAdmin();
  return (
    // A compact icon button in the page's header (design review): on
    // phones it stood alone, large, above the content.
    <button
      type="button"
      className="button compact settings-refresh"
      aria-label={t("Aktualisieren", "Refresh")}
      title={t("Aktualisieren", "Refresh")}
      onClick={() => {
        if (data) void load();
        onSummary();
      }}
    >
      <ArrowCounterClockwise size={16} aria-hidden="true" />
    </button>
  );
}

function SettingsScreen(props: UserSettingsProps) {
  const { boot } = props;
  const t = useT();
  const tx = useCallback((text: Text) => t(text.de, text.en), [t]);
  const admin = !!boot.user.isAdmin;
  // The settings level (#294, lib/settings-level.ts): what the sidebar shows.
  const level = useSettingsLevel();
  const levelProp = { value: level, onChange: (next: typeof level) => void setOwnSettingsLevel(props.mutate, next).catch((e) => props.onError((e as Error).message)) };
  // Speicher & KI: the AI ring and the sidebar's line.
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
  const route = useSettingsRoute();
  const found: SectionDef | null = route.section ? (route.area === "admin" ? (admin ? ADMIN : []) : USER).find((s) => s.id === route.section) || null : null;
  const onHome = !found;
  const { summary, load: loadSummary } = useAdminSummary(admin, onHome, props.onError);
  // The instance's addresses are for admins: everyone else gets the start page.
  const refused = route.area === "admin" && !admin;
  useEffect(() => {
    if (refused) history.replaceState(history.state, "", `${location.pathname}${location.search}${settingsHash({ area: "settings" })}`);
  }, [refused]);
  const userSummaries = userTiles(boot, props.theme, t, quota, LOCALE_TAG);
  const adminSummaries = useMemo(() => (summary ? adminTiles(summary, t) : {}), [summary, t]);
  const summaryOf = useCallback((s: SectionDef) => (s.area === "admin" ? adminSummaries[s.id] : userSummaries[s.id]), [adminSummaries, userSummaries]);
  const listed = useMemo(() => {
    const own = USER.filter((s) => sectionVisible(s, level));
    return admin ? [...own, ...ADMIN] : own;
  }, [admin, level]);
  const searchable = useMemo(() => (admin ? [...USER, ...ADMIN] : USER), [admin]);
  const groups: GroupMeta[] = admin ? [...USER_GROUPS, ...ADMIN_GROUPS] : USER_GROUPS;
  const groupName = (g: GroupMeta) => (g.id === "workspace" && g.area === "settings" ? t(`Arbeitsbereich „${boot.workspace.name}“`, `Workspace “${boot.workspace.name}”`) : tx(g.title));
  const root = useRef<HTMLDivElement>(null);
  // A new page starts at the top (the app scrolls an inner container).
  useEffect(() => {
    if (!route.anchor) root.current?.scrollIntoView({ block: "start" });
  }, [route.area, route.section, route.anchor]);
  const group = found ? groups.find((g) => g.id === found.group && g.area === found.area) : undefined;
  const crumb = group ? (found?.area === "admin" ? t(`Instanz › ${tx(group.title)}`, `Instance › ${tx(group.title)}`) : groupName(group)) : "";
  return (
    <div ref={root} className={`utility-content settings-shell settings-page sv${found?.area === "admin" ? " admin-page" : ""}`} data-area={found?.area ?? "settings"}>
      <div className="sv-layout" data-home={onHome ? "true" : "false"}>
        <SettingsNav sections={listed} searchable={searchable} groups={groups} groupName={groupName} current={found} home={onHome} summaryOf={summaryOf} tx={tx} searchOn={!onHome} />
        <div className="sv-main">
          {found ? (
            <SettingsDetail
              key={`${found.area}-${found.id}`}
              area={found.area}
              title={t("Einstellungen", "Settings")}
              groupName={crumb}
              section={found}
              anchor={route.anchor}
              level={found.area === "settings" ? levelProp : undefined}
              detailActions={found.area === "admin" && !OWN_REFRESH.has(found.id) ? <AdminRefresh onSummary={() => void loadSummary()} /> : undefined}
            />
          ) : (
            <SettingsStart
              boot={boot}
              theme={props.theme}
              quota={quota}
              searchable={searchable}
              summaryOf={summaryOf}
              level={levelProp}
              admin={admin ? { summary, tiles: adminSummaries, sections: ADMIN } : null}
              atInstance={route.area === "admin"}
              tx={tx}
            />
          )}
        </div>
      </div>
    </div>
  );
}

