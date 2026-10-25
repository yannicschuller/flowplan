"use client";
// Administration: a landing page of tiles with the state of each area
// (/api/admin/summary) and one page per section (components/settings/admin/*),
// addressed as #admin/<section>. docs/settings-architecture.md
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ShieldCheck } from "@phosphor-icons/react";
import type { AdminSummary } from "@/lib/admin-summary";
import { useT } from "./i18n";
import { api } from "./ui";
import { LiveStrip } from "./settings/admin/live-strip";
import { SettingsShell, useSettingsRoute, type TileSummary } from "./settings/shell";
import { groupsOf, sectionDefs } from "./settings/registry";
import { AdminProvider, useAdmin, type AdminProps } from "./settings/admin-context";
import { adminTiles } from "./settings/admin/tiles";

const SECTIONS = sectionDefs("admin");
const GROUPS = groupsOf("admin");

export default function Admin(props: AdminProps) {
  return (
    <AdminProvider {...props}>
      <AdminShell />
    </AdminProvider>
  );
}

function AdminShell() {
  const t = useT();
  const { onError, load, data } = useAdmin();
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<AdminSummary>("/api/admin/summary"));
    } catch (e) {
      errorRef.current((e as Error).message);
    }
  }, []);
  // Fresh whenever the landing page shows (after changes in a section).
  const section = useSettingsRoute("admin").section;
  const onHome = section === null;
  // Sections that refresh themselves (the live dashboard, the storage check
  // and the push relay check with their own button) get no second
  // "Aktualisieren".
  const ownRefresh = section === "monitoring" || section === "storage" || section === "push";
  useEffect(() => {
    if (onHome) void loadSummary();
  }, [onHome, loadSummary]);
  const tiles: Record<string, TileSummary> = summary ? adminTiles(summary, t) : {};
  const listed = (tone: string) =>
    SECTIONS.filter((s) => tiles[s.id]?.tone === tone).map((s) => ({ id: s.id, title: t(s.title.de, s.title.en), badge: tiles[s.id].badge }));
  return (
    <SettingsShell
      area="admin"
      title={t("Administration", "Administration")}
      description={t("Benutzer, Arbeitsbereiche, Daten und Dienste deiner Flowplan-Instanz.", "Users, workspaces, data and services of your Flowplan instance.")}
      HeaderIcon={ShieldCheck}
      sections={SECTIONS}
      groups={GROUPS}
      summaries={tiles}
      status={<LiveStrip problems={listed("error")} notices={listed("warn")} version={summary?.general.version} uptimeSeconds={summary?.general.uptimeSeconds} loaded={!!summary} />}
      detailActions={
        ownRefresh ? undefined : (
          <button
            type="button"
            className="button compact"
            onClick={() => {
              if (data) void load();
              void loadSummary();
            }}
          >
            <ArrowCounterClockwise size={15} aria-hidden="true" />
            {t("Aktualisieren", "Refresh")}
          </button>
        )
      }
    />
  );
}
