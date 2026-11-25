"use client";
// The sidebar of the settings (#532): "Übersicht" (the start page), the
// personal groups – Persönlich, Verbindungen, Arbeitsbereich, Hilfe & Info –
// and, for admins only, the instance's groups under the heading "Instanz".
// Wide screens: a sticky column next to the section, with a search while a
// section is open (the start page has its own). Phones: the list under the
// start page, one line of facts per section; a section opens full screen.
import { useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, MagnifyingGlass, ShieldCheck, SquaresFour } from "@phosphor-icons/react";
import { searchSettings, settingsHash, type GroupMeta, type Text } from "@/lib/settings-sections";
import { useT } from "../i18n";
import { Sparkline } from "../sparkline";
import type { TileSummary } from "./shell";
import type { SectionDef } from "./registry";

// A small picture of a section's facts on phones: a trend or a meter.
function MiniVisual({ summary }: { summary?: TileSummary }) {
  if (!summary) return null;
  if (summary.spark && summary.spark.filter((v) => typeof v === "number").length >= 2)
    return (
      <span className="sv-mini spark">
        <Sparkline values={summary.spark} label={summary.sparkLabel || ""} tone={summary.sparkTone} height={22} />
      </span>
    );
  const meter = summary.meter ?? summary.bars?.find((b) => b.share !== null)?.share ?? undefined;
  if (meter === undefined || meter === null) return null;
  return (
    <span className="sv-mini meter">
      <progress max={1000} value={Math.round(Math.min(1, meter) * 1000)} aria-label={summary.meterLabel || summary.line || ""} />
    </span>
  );
}

export function SettingsNav({
  sections,
  searchable,
  groups,
  groupName,
  current,
  home,
  summaryOf,
  tx,
  searchOn,
}: {
  // What the list shows (personal sections up to the person's level, the
  // instance's for admins) and what the search finds (every level).
  sections: SectionDef[];
  searchable: SectionDef[];
  groups: GroupMeta[];
  groupName: (g: GroupMeta) => string;
  current: SectionDef | null;
  home: boolean;
  summaryOf: (s: SectionDef) => TileSummary | undefined;
  tx: (text: Text) => string;
  // The search in the sidebar (wide screens, a section open).
  searchOn: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const results = useMemo(() => (searchOn && query.trim() ? searchSettings(searchable, query, tx) : null), [searchOn, query, searchable, tx]);
  const nav = useRef<HTMLElement>(null);
  // The current section stays in sight in a long sidebar.
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !nav.current || nav.current.scrollHeight <= nav.current.clientHeight) return;
    const box = nav.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) nav.current.scrollTop += r.top - box.top - box.height / 3;
  }, [current?.id, current?.area]);
  let instanceHeading = false;
  return (
    <nav ref={nav} className="sv-side" aria-label={t("Bereiche der Einstellungen", "Settings sections")} data-search={searchOn ? "true" : "false"}>
      {searchOn && (
        <div className="settings-search sv-side-search" role="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Suchen …", "Search …")} aria-label={t("Einstellung suchen", "Search settings")} />
        </div>
      )}
      {results ? (
        <ul className="sv-side-list">
          {results.length === 0 && <li className="sv-side-empty">{t("Nichts gefunden.", "Nothing found.")}</li>}
          {results.map((r, i) => (
            <li key={`${r.section.area}-${r.section.id}-${i}`}>
              <a href={settingsHash({ area: r.section.area, section: r.section.id, anchor: r.anchor })} onClick={() => setQuery("")}>
                <r.section.Icon size={17} aria-hidden />
                <span className="sv-side-text">
                  <span>{r.entry ? tx(r.entry.title) : tx(r.section.title)}</span>
                  <small className="sv-side-place">
                    {r.section.area === "admin" ? `${t("Instanz", "Instance")} › ` : ""}
                    {r.entry ? tx(r.section.title) : tx(r.section.description)}
                  </small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <ul className="sv-side-list sv-side-home">
            <li>
              <a href={settingsHash({ area: "settings" })} aria-current={home ? "page" : undefined}>
                <SquaresFour size={17} aria-hidden />
                <span className="sv-side-text">
                  <span>{t("Übersicht", "Overview")}</span>
                </span>
              </a>
            </li>
          </ul>
          {groups.map((g) => {
            const items = sections.filter((s) => s.group === g.id && s.area === g.area);
            if (!items.length) return null;
            const showInstance = g.area === "admin" && !instanceHeading;
            if (showInstance) instanceHeading = true;
            return (
              <div key={`${g.area}-${g.id}`} className="sv-side-group" data-area={g.area}>
                {showInstance && (
                  <h2 className="sv-side-scope" id="settings-nav-instance">
                    <ShieldCheck size={14} aria-hidden />
                    {t("Instanz", "Instance")}
                    <span>{t("nur für Admins", "admins only")}</span>
                  </h2>
                )}
                <h3 id={`settings-nav-${g.area}-${g.id}`}>{groupName(g)}</h3>
                <ul className="sv-side-list" aria-labelledby={`settings-nav-${g.area}-${g.id}`}>
                  {items.map((s) => {
                    const summary = summaryOf(s);
                    return (
                      <li key={`${s.area}-${s.id}`}>
                        <a href={settingsHash({ area: s.area, section: s.id })} data-section={s.id} data-area={s.area} aria-current={current && current.id === s.id && current.area === s.area ? "page" : undefined}>
                          <s.Icon size={17} aria-hidden />
                          <span className="sv-side-text">
                            <span>{tx(s.title)}</span>
                            <small>{summary?.line || tx(s.description)}</small>
                          </span>
                          {summary?.badge && summary.tone && summary.tone !== "off" && summary.tone !== "info" && (
                            <span className={`sv-side-dot tone-${summary.tone}`} role="img" aria-label={summary.badge} />
                          )}
                          <MiniVisual summary={summary} />
                          <CaretRight size={14} className="sv-side-caret" aria-hidden />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </>
      )}
    </nav>
  );
}
