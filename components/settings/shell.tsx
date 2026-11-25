"use client";
// The parts of the settings screen (components/settings.tsx,
// docs/settings-architecture.md): a tile (search results), and the page of
// a section with breadcrumb, title, one line of description and the
// section's content. The address is the hash (#settings/<section>[/<anchor>],
// #settings/instance/<section>[/<anchor>]), so reload, back and forward work
// and every section can be linked.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, CaretRight } from "@phosphor-icons/react";
import { parseSettingsHash, settingsHash, type SettingsArea, type SettingsRoute, type Text } from "@/lib/settings-sections";
import { anchorLevel, hiddenEntries, higherLevel, sectionMinLevel, withinLevel, type SettingsLevel } from "@/lib/settings-level";
import { LevelDot, LevelMore, LevelNotice, LevelViewProvider } from "../settings-level";
import { SettingsSkeleton } from "../skeleton";
import { useT } from "../i18n";
import { StatusBadge, type Tone } from "../settings-ui";
import { Sparkline } from "../sparkline";
import type { SectionDef } from "./registry";

// What a tile says about its section besides the title. Optional and only
// on wide tiles: a figure with its label (`value` + `valueLabel`), a trend
// (`spark`, oldest first; `sparkLabel` names it for screen readers; colour
// 1–5 of the chart palette) or a meter (`meter`, 0–1). Phones show the trend
// or the meter small next to the title.
export type TileSummary = {
  line?: string;
  tone?: Tone;
  badge?: string;
  value?: string;
  valueLabel?: string;
  spark?: (number | null)[];
  sparkLabel?: string;
  sparkTone?: 1 | 2 | 3 | 4 | 5;
  meter?: number;
  meterLabel?: string;
  // Several labelled figures, each with an optional bar (share 0–1, null:
  // no bar – unlimited or off), shown on phones too (Speicher & KI).
  bars?: TileBar[];
};
export type TileBar = { label: string; text: string; share: number | null };

// Set when a tile (or a search result) opened the section: "back" can then
// go back in the history instead of adding an entry.
let openedFromHome = false;
export const markOpenedFromHome = () => {
  openedFromHome = true;
};

// The route in the address: of one area, or (no area) of the settings
// screen – personal or instance. Old addresses (#admin/…, old tab ids,
// unknown sections) are corrected in place, without a history step.
export function useSettingsRoute(area?: SettingsArea): SettingsRoute {
  const read = (): SettingsRoute => {
    const parsed = typeof location === "undefined" ? null : parseSettingsHash(location.hash);
    return parsed && (!area || parsed.area === area) ? { area: parsed.area, section: parsed.section, anchor: parsed.anchor } : { area: area ?? "settings", section: null, anchor: null };
  };
  const [route, setRoute] = useState<SettingsRoute>(read);
  useEffect(() => {
    const sync = () => {
      const parsed = parseSettingsHash(location.hash);
      if (!parsed || (area && parsed.area !== area)) return;
      if (parsed.redirected) history.replaceState(history.state, "", `${location.pathname}${location.search}${settingsHash(parsed)}`);
      setRoute((r) => (r.area === parsed.area && r.section === parsed.section && r.anchor === parsed.anchor ? r : { area: parsed.area, section: parsed.section, anchor: parsed.anchor }));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [area]);
  return route;
}

// A section loads: its outline (heading, groups of settings).
export function AdminLoading() {
  return (
    <div className="settings-loading">
      <SettingsSkeleton />
    </div>
  );
}

type DetailProps = {
  area: SettingsArea;
  // The screen's name ("Einstellungen"): back button and breadcrumb.
  title: string;
  // The section's group in the breadcrumb ("Instanz › Personen").
  groupName: string;
  section: SectionDef;
  anchor: string | null;
  // Buttons next to a section's title (e.g. "Aktualisieren").
  detailActions?: ReactNode;
  // Wraps the section content (providers that only sections need).
  Wrap?: ComponentType<{ children: ReactNode }>;
  // Settings levels (#294, lib/settings-level.ts), only for the personal
  // settings: the person's level and how to change it. A section opened
  // above it says so.
  level?: { value: SettingsLevel; onChange: (level: SettingsLevel) => void };
};

function useText() {
  const t = useT();
  return (text: Text) => t(text.de, text.en);
}

export function Tile({ section, summary, title, anchor, level }: { section: SectionDef; summary?: TileSummary; title: string; anchor?: string; level?: SettingsLevel }) {
  const area = section.area;
  const tx = useText();
  const { Icon } = section;
  const tone = summary?.tone;
  const visual =
    summary?.spark && summary.spark.filter((v) => typeof v === "number").length >= 2 ? (
      <Sparkline values={summary.spark} label={summary.sparkLabel || ""} tone={summary.sparkTone} />
    ) : summary?.meter !== undefined ? (
      <span
        className={`settings-tile-meter${summary.meter >= 0.95 ? " full" : summary.meter >= 0.8 ? " high" : ""}`}
        role="meter"
        aria-label={summary.meterLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, summary.meter) * 100)}
      >
        <span style={{ width: `${Math.max(2, Math.min(1, summary.meter) * 100)}%` }} />
      </span>
    ) : null;
  if (summary?.bars?.length)
    return (
      <a className="settings-tile rich bars" href={settingsHash({ area, section: section.id, anchor })} data-section={section.id} onClick={() => (openedFromHome = true)}>
        <span className="settings-tile-icon" aria-hidden>
          <Icon size={20} />
        </span>
        <span className="settings-tile-text">
          <strong>
            {title}
            {level && <LevelDot level={level} decorative />}
          </strong>
          <small>{summary.line || tx(section.description)}</small>
        </span>
        <CaretRight size={16} className="settings-tile-caret" aria-hidden />
        <span className="settings-tile-bars">
          {summary.bars.map((b) => (
            <span key={b.label} className={`settings-tile-bar${b.share === null ? "" : b.share >= 1 ? " full" : b.share >= 0.8 ? " high" : ""}`}>
              <span className="settings-tile-bar-text">
                <span>{b.label}</span>
                <strong>{b.text}</strong>
              </span>
              {b.share !== null && <progress max={1000} value={Math.round(Math.min(1, b.share) * 1000)} aria-label={`${b.label}: ${b.text}`} />}
            </span>
          ))}
        </span>
      </a>
    );
  if (visual || summary?.valueLabel)
    return (
      <a className={`settings-tile rich${tone === "error" ? " alert" : ""}`} href={settingsHash({ area, section: section.id, anchor })} data-section={section.id} onClick={() => (openedFromHome = true)}>
        <span className="settings-tile-icon" aria-hidden>
          <Icon size={20} />
        </span>
        <span className="settings-tile-text">
          <strong>{title}</strong>
          <small>{summary?.line || tx(section.description)}</small>
        </span>
        <CaretRight size={16} className="settings-tile-caret" aria-hidden />
        <span className="settings-tile-foot">
          {(summary?.value || summary?.badge) && (
            <span className="settings-tile-figure">
              {summary.value && <strong>{summary.value}</strong>}
              {summary.value && summary.valueLabel && <small>{summary.valueLabel}</small>}
              {summary.badge && <StatusBadge tone={summary.tone || "off"}>{summary.badge}</StatusBadge>}
            </span>
          )}
          {visual && <span className="settings-tile-visual">{visual}</span>}
        </span>
      </a>
    );
  return (
    <a
      className={`settings-tile${tone === "error" ? " alert" : ""}`}
      href={settingsHash({ area, section: section.id, anchor })}
      data-section={section.id}
      onClick={() => {
        openedFromHome = true;
      }}
    >
      <span className="settings-tile-icon" aria-hidden>
        <Icon size={20} />
      </span>
      <span className="settings-tile-text">
        <strong>
          {title}
          {level && <LevelDot level={level} decorative />}
        </strong>
        <small>{summary?.line || tx(section.description)}</small>
      </span>
      {summary?.value && <span className="settings-tile-value">{summary.value}</span>}
      {summary?.badge && (
        <span className="settings-tile-meta">
          <StatusBadge tone={summary.tone || "off"}>{summary.badge}</StatusBadge>
        </span>
      )}
      <CaretRight size={16} className="settings-tile-caret" aria-hidden />
    </a>
  );
}

export function SettingsDetail({ title, groupName, detailActions, section, anchor, Wrap, level }: DetailProps) {
  const t = useT();
  const tx = useText();
  const heading = useRef<HTMLHeadingElement>(null);
  // Levels (#294): "Trotzdem zeigen" shows this section up to a higher
  // level for now; another section starts at the person's level again.
  const [reveal, setReveal] = useState<{ section: string; level: SettingsLevel } | null>(null);
  const revealed = level && reveal?.section === section.id ? reveal.level : null;
  const viewLevel = level ? (revealed ? higherLevel(revealed, level.value) : level.value) : null;
  const lowest = sectionMinLevel(section);
  const whole = !!level && !withinLevel(lowest, level.value);
  // What the address points to, when above the person's level: the
  // setting of the anchor, else the section.
  const pointed = anchorLevel(section, anchor);
  const target = !level ? null : pointed && !withinLevel(pointed, level.value) ? higherLevel(pointed, lowest) : whole ? lowest : null;
  const showBody = !viewLevel || withinLevel(lowest, viewLevel);
  const { Component, Icon } = section;
  useEffect(() => {
    if (!anchor) {
      heading.current?.focus({ preventScroll: true });
      return;
    }
    // The anchor may appear once the section has loaded its data.
    let tries = 0;
    const find = () => {
      const target = document.getElementById(anchor);
      if (target) target.scrollIntoView({ block: "start" });
      else if (tries++ < 20) timer = setTimeout(find, 150);
    };
    let timer = setTimeout(find, 0);
    return () => clearTimeout(timer);
  }, [section.id, anchor, viewLevel]);
  const back = () => {
    if (openedFromHome && history.length > 1) {
      openedFromHome = false;
      history.back();
    } else location.hash = settingsHash({ area: "settings" });
  };
  const body = viewLevel ? (
    <LevelViewProvider level={viewLevel} section={section}>
      {showBody && <Component />}
      {showBody && <LevelMore count={hiddenEntries(section, viewLevel)} onReveal={() => setReveal({ section: section.id, level: "expert" })} />}
    </LevelViewProvider>
  ) : (
    <Component />
  );
  return (
    <div className="settings-detail" data-detail={section.id}>
      <div className="settings-detail-bar">
        <button type="button" className="settings-back" onClick={back}>
          <ArrowLeft size={18} aria-hidden />
          <span>{title}</span>
        </button>
      </div>
      <nav className="settings-breadcrumb" aria-label={t("Pfad", "Path")}>
        <a href={settingsHash({ area: "settings" })}>{title}</a>
        <CaretRight size={12} aria-hidden />
        <span>{groupName}</span>
        <CaretRight size={12} aria-hidden />
        <span aria-current="page">{tx(section.title)}</span>
      </nav>
      <div className="settings-detail-layout">
        <div className="settings-detail-main">
          <header className="settings-detail-head">
            <span className="settings-head-icon" aria-hidden>
              <Icon size={22} />
            </span>
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {tx(section.title)}
              </h1>
              {level && <LevelDot level={lowest} />}
              <p>{tx(section.description)}</p>
            </div>
            {detailActions && <div className="settings-detail-actions">{detailActions}</div>}
          </header>
          {target && (
            <LevelNotice
              target={target}
              whole={whole}
              revealed={!!revealed && withinLevel(target, revealed)}
              onSwitch={() => level?.onChange(target)}
              onReveal={() => setReveal({ section: section.id, level: target })}
            />
          )}
          <div className="settings-body">{Wrap ? <Wrap>{body}</Wrap> : body}</div>
        </div>
      </div>
    </div>
  );
}
