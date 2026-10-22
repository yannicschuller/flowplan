"use client";
// Administration: a landing page of tiles with the state of each area
// (/api/admin/summary) and one page per section (components/settings/admin/*),
// addressed as #admin/<section>. docs/settings-architecture.md
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ShieldCheck } from "@phosphor-icons/react";
import type { AdminSummary } from "@/lib/admin-summary";
import { useT } from "./i18n";
import { api } from "./ui";
import { StatusBadge } from "./settings-ui";
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
  const onHome = useSettingsRoute("admin").section === null;
  useEffect(() => {
    if (onHome) void loadSummary();
  }, [onHome, loadSummary]);
  const tiles: Record<string, TileSummary> = summary ? adminTiles(summary, t) : {};
  const problems = Object.values(tiles).filter((x) => x.tone === "error").length,
    notices = Object.values(tiles).filter((x) => x.tone === "warn").length;
  return (
    <SettingsShell
      area="admin"
      title={t("Administration", "Administration")}
      description={t("Benutzer, Arbeitsbereiche, Daten und Dienste deiner Flowplan-Instanz.", "Users, workspaces, data and services of your Flowplan instance.")}
      HeaderIcon={ShieldCheck}
      sections={SECTIONS}
      groups={GROUPS}
      summaries={tiles}
      status={
        summary ? (
          <p className="settings-status" role="status">
            {problems ? <StatusBadge tone="error">{t(`${problems} mit Fehler`, `${problems} with errors`)}</StatusBadge> : null}
            {notices ? <StatusBadge tone="warn">{t(`${notices} mit Hinweis`, `${notices} with notices`)}</StatusBadge> : null}
            {!problems && !notices && <StatusBadge tone="ok">{t("Alles in Ordnung", "All fine")}</StatusBadge>}
            <span className="muted">
              {t("Version", "Version")} {summary.general.version}
            </span>
          </p>
        ) : (
          <p className="settings-status muted" role="status">
            {t("Zustand wird geladen …", "Loading state …")}
          </p>
        )
      }
      detailActions={
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
      }
    />
  );
}
