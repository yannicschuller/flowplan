"use client";
// The start page of the settings (#settings, #532): the search over every
// area on top, then the person's own state – storage and AI as rings and a
// compact "Dein Setup" (appearance with a small preview, notifications,
// devices) – and for admins "Instanz auf einen Blick": on top the state of
// the instance and the live panels (admin/live-panels.tsx: people,
// requests, AI, storage, errors, server, accounts, sign-ins, backups,
// background work – charts of real data, each linked to its section), then
// one tile each for accounts, storage and backup, monitoring, failed
// sign-ins, features and the version. Every tile is a link into its
// section; numbers are live (/api/admin/summary, the panels'
// /api/admin/monitoring?view=live), a trend only where a history exists.
// Phones stack it (rings first, the instance after them) and the list of
// all sections follows (components/settings/nav.tsx).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowsClockwise,
  Bell,
  CaretRight,
  CheckCircle,
  DeviceMobile,
  GearSix,
  HardDrives,
  MagnifyingGlass,
  Palette,
  Pulse,
  ShieldWarning,
  SquaresFour,
  UsersThree,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { AdminSummary } from "@/lib/admin-summary";
import { FEATURE_MODULES } from "@/lib/feature-modules";
import { useFeatureModules } from "@/lib/feature-modules-client";
import { LANGUAGES } from "@/lib/i18n";
import { aiSummary, storageSummary } from "@/lib/limits-summary";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { QuotaStatus } from "@/lib/ai/quota-shared";
import { searchSettings, settingsHash, type SettingsSearchResult, type Text } from "@/lib/settings-sections";
import { withinLevel, type SettingsLevel } from "@/lib/settings-level";
import type { ThemeChoice } from "@/lib/theme";
import type { Bootstrap } from "@/lib/types";
import { useT } from "../i18n";
import { LevelSwitch, useLevelName } from "../settings-level";
import { StatusBadge, type Tone } from "../settings-ui";
import { Sparkline } from "../sparkline";
import { InstanceLive, type StripItem } from "./admin/live-panels";
import { num, uptime } from "./admin/monitoring-format";
import { moduleTexts } from "./user/feature-modules";
import { PagePreview, Ring, ringText, sizeText, StorageStack } from "./previews";
import { markOpenedFromHome, Tile, type TileSummary } from "./shell";
import type { SectionDef } from "./registry";

type StartProps = {
  boot: Bootstrap;
  theme: ThemeChoice;
  quota: QuotaStatus | null;
  // Every section the search finds (the instance's for admins).
  searchable: SectionDef[];
  summaryOf: (s: SectionDef) => TileSummary | undefined;
  level: { value: SettingsLevel; onChange: (level: SettingsLevel) => void };
  // Admins: the summary of the instance (null while it loads).
  admin: { summary: AdminSummary | null; tiles: Record<string, TileSummary>; sections: SectionDef[] } | null;
  // #settings/instance: the start page opens at the instance's overview.
  atInstance: boolean;
  tx: (text: Text) => string;
};

const time = (at: number) => {
  const d = new Date(at);
  return Date.now() - at < 86_400_000 ? d.toLocaleTimeString(LOCALE_TAG, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" });
};

export function SettingsStart({ boot, theme, quota, searchable, summaryOf, level, admin, atInstance, tx }: StartProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const levelName = useLevelName();
  const instance = useRef<HTMLElement>(null);
  const results = useMemo(() => (query.trim() ? searchSettings(searchable, query, tx) : null), [query, searchable, tx]);
  // #settings/instance (the old #admin): the instance's overview in sight.
  useEffect(() => {
    if (atInstance && admin) instance.current?.scrollIntoView({ block: "start" });
  }, [atInstance, admin]);
  const above = (l: SettingsLevel | undefined) => (l && !withinLevel(l, level.value) ? l : undefined);
  const resultSummary = (r: SettingsSearchResult<SectionDef>): TileSummary | undefined => {
    if (r.section.area === "admin")
      return { line: r.entry ? t(`Instanz › ${tx(r.section.title)}`, `Instance › ${tx(r.section.title)}`) : t("Instanz", "Instance"), badge: t("Instanz", "Instance"), tone: "off" };
    const high = above(r.level);
    if (high)
      return {
        line: r.entry ? t(`in ${tx(r.section.title)} · Stufe ${levelName(high)}`, `in ${tx(r.section.title)} · ${levelName(high)} level`) : t(`Stufe ${levelName(high)}`, `${levelName(high)} level`),
      };
    return r.entry ? { line: t(`in ${tx(r.section.title)}`, `in ${tx(r.section.title)}`) } : summaryOf(r.section);
  };
  return (
    <div className="settings-home sv-start">
      <header className="settings-home-head">
        <span className="settings-head-icon" aria-hidden>
          <GearSix size={26} />
        </span>
        <div>
          <h1>{t("Einstellungen", "Settings")}</h1>
          <p>{t(`${boot.user.name} · Arbeitsbereich „${boot.workspace.name}“`, `${boot.user.name} · workspace “${boot.workspace.name}”`)}</p>
        </div>
      </header>
      <div className="settings-search sv-start-search" role="search">
        <MagnifyingGlass size={17} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={admin ? t("Einstellung suchen – auch in der Instanz …", "Search settings – the instance too …") : t("Einstellung suchen …", "Search settings …")}
          aria-label={t("Einstellung suchen", "Search settings")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results?.[0]) {
              markOpenedFromHome();
              location.hash = settingsHash({ area: results[0].section.area, section: results[0].section.id, anchor: results[0].anchor });
            }
          }}
        />
      </div>
      {results ? (
        <section className="settings-results" aria-label={t("Suchergebnisse", "Search results")}>
          <p className="settings-results-count" role="status">
            {results.length ? t(`${results.length} Treffer`, `${results.length} results`) : t("Nichts gefunden. Versuche ein anderes Wort.", "Nothing found. Try another word.")}
          </p>
          <ul className="settings-tiles list">
            {results.map((r, i) => (
              <li key={`${r.section.area}-${r.section.id}-${i}`}>
                <Tile section={r.section} summary={resultSummary(r)} title={r.entry ? tx(r.entry.title) : tx(r.section.title)} anchor={r.anchor} level={r.section.area === "settings" ? above(r.level) : undefined} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <LevelSwitch value={level.value} onChange={level.onChange} />
          <section className="sv-start-block" aria-labelledby="settings-start-you">
            <h2 id="settings-start-you">{t("Für dich", "For you")}</h2>
            <div className="sv-start-you">
              <UsageCard boot={boot} quota={quota} />
              <SetupCard boot={boot} theme={theme} summaryOf={summaryOf} searchable={searchable} />
            </div>
          </section>
          {admin && (
            <section ref={instance} className="sv-start-block sv-start-instance" id="instance-overview" aria-labelledby="settings-start-instance">
              <h2 id="settings-start-instance">{t("Instanz auf einen Blick", "Instance at a glance")}</h2>
              <InstanceOverview {...admin} />
            </section>
          )}
          <button
            type="button"
            className="button sv-start-all"
            onClick={() => {
              const nav = document.querySelector<HTMLElement>(".sv-side");
              nav?.scrollIntoView({ block: "start" });
              nav?.querySelector<HTMLElement>("a")?.focus({ preventScroll: true });
            }}
          >
            <ArrowDown size={16} aria-hidden />
            {t("Alle Bereiche", "All sections")}
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- for everyone

function UsageCard({ boot, quota }: { boot: Bootstrap; quota: QuotaStatus | null }) {
  const t = useT();
  const storage = boot.myLimits ? storageSummary(boot.myLimits, t, LOCALE_TAG) : null;
  const ai = boot.user.demo ? null : aiSummary(boot.ai, quota, t, LOCALE_TAG);
  const showAi = !!ai && ai.state !== "none";
  if (!storage && !showAi) return null;
  return (
    <div className="sv-start-card sv-start-usage">
      <h3>{t("Speicher & KI", "Storage & AI")}</h3>
      <div className="sv-start-rings">
        {storage && (
          <a className="sv-start-ring" href={settingsHash({ area: "settings", section: "usage", anchor: "storage" })} onClick={markOpenedFromHome}>
            <Ring share={storage.share} center={ringText(storage.share)} label={t("Speicher", "Storage")} size={84} />
            <span>
              <strong>{t("Speicher", "Storage")}</strong>
              <small>{storage.text}</small>
            </span>
          </a>
        )}
        {showAi && ai && (
          <a className="sv-start-ring" href={settingsHash({ area: "settings", section: "usage", anchor: "ai" })} onClick={markOpenedFromHome}>
            <Ring share={ai.share} tone={2} center={ringText(ai.share, ai.state === "off")} label={t("KI-Kontingent", "AI quota")} size={84} />
            <span>
              <strong>{t("KI-Kontingent", "AI quota")}</strong>
              <small>{ai.text}</small>
            </span>
          </a>
        )}
      </div>
    </div>
  );
}

// Offline use on this device (components/offline.ts), loaded on demand.
function useOfflineState(userId: string) {
  const [state, setState] = useState<"on" | "off" | "unsupported" | null>(null);
  useEffect(() => {
    let live = true;
    void import("../offline")
      .then(async (m) => {
        if (!m.offlineSupported()) return "unsupported" as const;
        const marker = await m.offlineMarker();
        return marker?.user === userId ? ("on" as const) : ("off" as const);
      })
      .then((s) => live && setState(s))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [userId]);
  return state;
}

function SetupCard({ boot, theme, summaryOf, searchable }: { boot: Bootstrap; theme: ThemeChoice; summaryOf: (s: SectionDef) => TileSummary | undefined; searchable: SectionDef[] }) {
  const t = useT();
  const offline = useOfflineState(boot.user.id);
  const section = (id: string) => searchable.find((s) => s.area === "settings" && s.id === id);
  const notifications = section("notifications");
  const themeName = theme === "dark" ? t("Dunkel", "Dark") : theme === "light" ? t("Hell", "Light") : t("Hell/Dunkel automatisch", "Light/dark automatic");
  const language = boot.language ? LANGUAGES[boot.language].name : t("Sprache automatisch", "Language automatic");
  const rows: { id: string; Icon: Icon; title: string; line: string; visual?: ReactNode }[] = [
    { id: "appearance", Icon: Palette, title: t("Erscheinungsbild", "Look"), line: `${themeName} · ${language}`, visual: <PagePreview small /> },
    ...(notifications ? [{ id: "notifications", Icon: Bell, title: t("Benachrichtigungen", "Notifications"), line: summaryOf(notifications)?.line || "" }] : []),
    {
      id: "devices",
      Icon: DeviceMobile,
      title: t("Dieses Gerät", "This device"),
      line:
        offline === "on"
          ? t("Offline-Kopie an", "Offline copy on")
          : offline === "off"
            ? t("Offline-Kopie aus", "Offline copy off")
            : offline === "unsupported"
              ? t("Offline hier nicht möglich", "Offline not possible here")
              : " ",
    },
  ];
  return (
    <div className="sv-start-card sv-start-setup">
      <h3>{t("Dein Setup", "Your setup")}</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.id}>
            <a href={settingsHash({ area: "settings", section: r.id })} onClick={markOpenedFromHome}>
              {r.visual ? <span className="sv-start-thumb">{r.visual}</span> : (
                <span className="sv-start-icon" aria-hidden>
                  <r.Icon size={18} />
                </span>
              )}
              <span className="sv-side-text">
                <span>{r.title}</span>
                <small>{r.line}</small>
              </span>
              <CaretRight size={14} aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ admins

type InstanceTile = { id: string; section: string; anchor?: string; Icon: Icon; title: string; value?: string; line: string; tone?: Tone; badge?: string; visual?: ReactNode };

function InstanceOverview({ summary, tiles, sections }: { summary: AdminSummary | null; tiles: Record<string, TileSummary>; sections: SectionDef[] }) {
  const t = useT();
  const { off } = useFeatureModules();
  const texts = moduleTexts(t);
  // The state line's problems and notices: the tiles' errors and warnings.
  const listed = (tone: string): StripItem[] =>
    sections.filter((s) => tiles[s.id]?.tone === tone).map((s) => ({ id: s.id, title: t(s.title.de, s.title.en), badge: tiles[s.id].badge }));
  const problems = listed("error"),
    notices = listed("warn");
  // On top: the state and the live panels; the tiles below.
  const live = <InstanceLive problems={problems} notices={notices} version={summary?.general.version} uptimeSeconds={summary?.general.uptimeSeconds} loaded={!!summary} />;
  if (!summary)
    return (
      <>
        {live}
        <div className="sv-start-tiles placeholder" aria-hidden />
      </>
    );
  const s = summary;
  // The same count as the state line's headline (the sections' problems
  // and notices) plus the monitoring's own alerts and failing workers.
  const warnings = problems.length + notices.length + s.monitoring.alerts.length + s.monitoring.failingWorkers.length;
  const on = FEATURE_MODULES.filter((m) => !off.includes(m));
  const backupLine = s.storage.restorePending
    ? t("Wiederherstellung wartet auf Neustart", "Restore waits for a restart")
    : !s.storage.backup.enabled
      ? t("Geplante Sicherung aus", "Scheduled backup off")
      : s.storage.backup.lastAt
        ? t(`Letzte Sicherung ${time(s.storage.backup.lastAt)}`, `Last backup ${time(s.storage.backup.lastAt)}`)
        : t("Noch keine Sicherung", "No backup yet");
  const list: InstanceTile[] = [
    {
      id: "accounts",
      section: "users",
      Icon: UsersThree,
      title: t("Konten & Sitzungen", "Accounts & sessions"),
      value: num(s.users.total),
      line: [
        s.users.sessions === 1 ? t("1 aktive Sitzung", "1 active session") : t(`${num(s.users.sessions)} aktive Sitzungen`, `${num(s.users.sessions)} active sessions`),
        t(`${num(s.users.activeNow)} gerade aktiv`, `${num(s.users.activeNow)} active now`),
      ].join(" · "),
      visual:
        s.charts.active24h.filter((v) => typeof v === "number").length >= 2 ? (
          <Sparkline values={s.charts.active24h} label={t("Aktive Personen je Stunde, letzte 24 Stunden", "Active people per hour, last 24 hours")} height={30} />
        ) : undefined,
    },
    {
      id: "storage",
      section: "storage",
      Icon: HardDrives,
      title: t("Speicher & Sicherung", "Storage & backup"),
      value: sizeText(s.storage.bytes),
      line: backupLine,
      tone: s.storage.backup.failed ? "error" : !s.storage.backup.enabled || s.storage.restorePending ? "warn" : undefined,
      badge: s.storage.backup.failed ? t("Sicherung fehlgeschlagen", "Backup failed") : s.storage.s3?.failing ? t("S3 meldet Fehler", "S3 reports errors") : undefined,
      visual: <StorageStack databaseBytes={s.storage.databaseBytes} uploadBytes={s.storage.uploadBytes} />,
    },
    {
      id: "monitoring",
      section: "monitoring",
      Icon: Pulse,
      title: t("Überwachung", "Monitoring"),
      value: warnings ? (warnings === 1 ? t("1 Warnung", "1 warning") : t(`${warnings} Warnungen`, `${warnings} warnings`)) : t("In Ordnung", "OK"),
      line: [
        s.monitoring.errorsHour === 1 ? t("1 Fehler in der letzten Stunde", "1 error in the last hour") : t(`${num(s.monitoring.errorsHour)} Fehler in der letzten Stunde`, `${num(s.monitoring.errorsHour)} errors in the last hour`),
        s.monitoring.failingWorkers.length > 0 && (s.monitoring.failingWorkers.length === 1 ? t("1 Hintergrunddienst mit Fehler", "1 background service failing") : t(`${s.monitoring.failingWorkers.length} Hintergrunddienste mit Fehler`, `${s.monitoring.failingWorkers.length} background services failing`)),
      ]
        .filter(Boolean)
        .join(" · "),
      tone: problems.length ? "error" : warnings ? "warn" : "ok",
    },
    {
      id: "signins",
      section: "threats",
      anchor: "addresses",
      Icon: ShieldWarning,
      title: t("Fehlgeschlagene Anmeldungen", "Failed sign-ins"),
      value: num(s.securityCenter.failedDay),
      line: [
        t("letzte 24 Stunden", "last 24 hours"),
        s.securityCenter.open > 0 && (s.securityCenter.open === 1 ? t("1 offener Vorfall", "1 open incident") : t(`${s.securityCenter.open} offene Vorfälle`, `${s.securityCenter.open} open incidents`)),
        s.securityCenter.blocks > 0 && (s.securityCenter.blocks === 1 ? t("1 Sperre", "1 block") : t(`${s.securityCenter.blocks} Sperren`, `${s.securityCenter.blocks} blocks`)),
      ]
        .filter(Boolean)
        .join(" · "),
      tone: s.securityCenter.critical ? "error" : s.securityCenter.open ? "warn" : undefined,
    },
    {
      id: "features",
      section: "general",
      anchor: "modules-off",
      Icon: SquaresFour,
      title: t("Funktionen", "Features"),
      value: t(`${on.length} von ${FEATURE_MODULES.length} an`, `${on.length} of ${FEATURE_MODULES.length} on`),
      line: off.length ? t(`Aus: ${off.map((m) => texts[m].label).join(", ")}`, `Off: ${off.map((m) => texts[m].label).join(", ")}`) : t("Alle eingeschaltet", "All switched on"),
      visual: (
        <span className="sv-start-modules" aria-hidden>
          {FEATURE_MODULES.map((m) => (
            <i key={m} className={off.includes(m) ? "off" : "on"} />
          ))}
        </span>
      ),
    },
    {
      id: "version",
      section: "general",
      anchor: "version",
      Icon: ArrowsClockwise,
      title: t("Version", "Version"),
      value: `v${s.general.version}`,
      line: [s.general.update ? t(`Update auf ${s.general.update} verfügbar`, `Update to ${s.general.update} available`) : t("Aktuell", "Up to date"), t(`läuft seit ${uptime(s.general.uptimeSeconds, t)}`, `running for ${uptime(s.general.uptimeSeconds, t)}`)].join(" · "),
      tone: s.general.update ? "info" : undefined,
      badge: s.general.update ? t("Update", "Update") : undefined,
    },
  ];
  return (
    <>
      {live}
      <ul className="sv-start-tiles">
        {list.map((tile) => (
          <li key={tile.id}>
            <a className={`sv-start-tile${tile.tone === "error" ? " alert" : ""}`} href={settingsHash({ area: "admin", section: tile.section, anchor: tile.anchor })} data-tile={tile.id} onClick={markOpenedFromHome}>
              <span className="sv-start-tile-head">
                <span className="sv-start-icon" aria-hidden>
                  <tile.Icon size={18} />
                </span>
                <strong>{tile.title}</strong>
                {tile.tone === "ok" ? (
                  <CheckCircle size={16} weight="fill" className="sv-start-ok" aria-hidden />
                ) : tile.tone === "warn" || tile.tone === "error" ? (
                  <WarningCircle size={16} weight="fill" className={`sv-start-warn tone-${tile.tone}`} aria-hidden />
                ) : null}
                <CaretRight size={14} className="sv-start-caret" aria-hidden />
              </span>
              {tile.value && <span className="sv-start-value">{tile.value}</span>}
              <small className="sv-start-line">{tile.line}</small>
              {tile.badge && <StatusBadge tone={tile.tone && tile.tone !== "ok" ? tile.tone : "info"}>{tile.badge}</StatusBadge>}
              {tile.visual && <span className="sv-start-visual">{tile.visual}</span>}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
