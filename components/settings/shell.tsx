"use client";
// The frame of the settings and the administration
// (docs/settings-architecture.md): a landing page of grouped tiles with a
// search, and a detail page per section with breadcrumb, title, one line of
// description and the section's content. The address is the hash
// (#settings, #settings/<section>[/<anchor>], #admin/…), so reload, back and
// forward work and every section can be linked.
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, CaretRight, MagnifyingGlass, type Icon } from "@phosphor-icons/react";
import { parseSettingsHash, settingsHash, matchesQuery, type GroupMeta, type SettingsArea, type SettingsRoute, type Text } from "@/lib/settings-sections";
import { useT } from "../i18n";
import { StatusBadge, type Tone } from "../settings-ui";
import type { SectionDef } from "./registry";

// What a tile says about its section besides the title.
export type TileSummary = { line?: string; tone?: Tone; badge?: string; value?: string };

// Set when a tile (or a search result) opened the section: "back" can then
// go back in the history instead of adding an entry.
let openedFromHome = false;
// The section a person came back from, to focus its tile again.
let lastSection: string | null = null;

export function useSettingsRoute(area: SettingsArea): SettingsRoute {
  const read = (): SettingsRoute => {
    const parsed = typeof location === "undefined" ? null : parseSettingsHash(location.hash);
    return parsed && parsed.area === area ? { area, section: parsed.section, anchor: parsed.anchor } : { area, section: null, anchor: null };
  };
  const [route, setRoute] = useState<SettingsRoute>(read);
  useEffect(() => {
    const sync = () => {
      const parsed = parseSettingsHash(location.hash);
      if (!parsed || parsed.area !== area) return;
      // Old tab ids and unknown sections: the address is corrected in place.
      if (parsed.redirected) history.replaceState(history.state, "", `${location.pathname}${location.search}${settingsHash(parsed)}`);
      setRoute({ area, section: parsed.section, anchor: parsed.anchor });
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [area]);
  return route;
}

export function AdminLoading() {
  const t = useT();
  return (
    <p className="settings-loading" role="status">
      {t("Wird geladen …", "Loading …")}
    </p>
  );
}

type ShellProps = {
  area: SettingsArea;
  title: string;
  description: ReactNode;
  HeaderIcon: Icon;
  sections: SectionDef[];
  groups: GroupMeta[];
  // The group's title (the workspace group names the workspace).
  groupTitle?: (group: GroupMeta) => string;
  summaries: Record<string, TileSummary>;
  // Above the tiles, e.g. the state of the instance.
  status?: ReactNode;
  // Buttons next to a section's title (e.g. "Aktualisieren").
  detailActions?: ReactNode;
  // Wraps the section content (providers that only sections need).
  Wrap?: ComponentType<{ children: ReactNode }>;
};

export function SettingsShell(props: ShellProps) {
  const route = useSettingsRoute(props.area);
  const section = props.sections.find((s) => s.id === route.section) || null;
  const root = useRef<HTMLDivElement>(null);
  // A new page starts at the top (the app scrolls an inner container).
  useEffect(() => {
    if (!route.anchor) root.current?.scrollIntoView({ block: "start" });
  }, [route.section, route.anchor]);
  return (
    <div ref={root} className={`utility-content settings-shell ${props.area === "admin" ? "admin-page" : "settings-page"}`} data-area={props.area}>
      {section ? <SettingsDetail {...props} section={section} anchor={route.anchor} /> : <SettingsHome {...props} />}
    </div>
  );
}

function useText() {
  const t = useT();
  return (text: Text) => t(text.de, text.en);
}

function SettingsHome({ area, title, description, HeaderIcon, sections, groups, groupTitle, summaries, status }: ShellProps) {
  const t = useT();
  const tx = useText();
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  // Back from a section: its tile gets the focus again.
  useEffect(() => {
    if (!lastSection) return;
    list.current?.querySelector<HTMLElement>(`[data-section="${lastSection}"]`)?.focus({ preventScroll: false });
    lastSection = null;
  }, []);
  // Every text of a section in the reader's language and in German and
  // English, so a search in any of them finds it.
  const results = useMemo(() => {
    if (!query.trim()) return null;
    const out: { section: SectionDef; entry?: string; anchor?: string }[] = [];
    for (const s of sections) {
      const own = [tx(s.title), s.title.de, s.title.en, tx(s.description), s.keywords.de, s.keywords.en, tx(s.keywords)];
      if (matchesQuery(own, query)) out.push({ section: s });
      for (const e of s.entries || []) {
        const texts = [tx(e.title), e.title.de, e.title.en, ...(e.keywords ? [e.keywords.de, e.keywords.en, tx(e.keywords)] : [])];
        if (matchesQuery(texts, query)) out.push({ section: s, entry: tx(e.title), anchor: e.anchor });
      }
    }
    return out;
  }, [query, sections, tx]);
  const groupName = (g: GroupMeta) => (groupTitle ? groupTitle(g) : tx(g.title));
  return (
    <div className="settings-home">
      <header className="settings-home-head">
        <span className="settings-head-icon" aria-hidden>
          <HeaderIcon size={26} />
        </span>
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      {status}
      <div className="settings-search" role="search">
        <MagnifyingGlass size={17} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Einstellung suchen …", "Search settings …")}
          aria-label={t("Einstellung suchen", "Search settings")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results?.[0]) {
              openedFromHome = true;
              location.hash = settingsHash({ area, section: results[0].section.id, anchor: results[0].anchor });
            }
          }}
        />
      </div>
      <div ref={list}>
        {results ? (
          <section className="settings-results" aria-label={t("Suchergebnisse", "Search results")}>
            <p className="settings-results-count" role="status">
              {results.length ? t(`${results.length} Treffer`, `${results.length} results`) : t("Nichts gefunden. Versuche ein anderes Wort.", "Nothing found. Try another word.")}
            </p>
            <ul className="settings-tiles list">
              {results.map((r, i) => (
                <li key={`${r.section.id}-${i}`}>
                  <Tile area={area} section={r.section} summary={r.entry ? { line: t(`in ${tx(r.section.title)}`, `in ${tx(r.section.title)}`) } : summaries[r.section.id]} title={r.entry || tx(r.section.title)} anchor={r.anchor} />
                </li>
              ))}
            </ul>
          </section>
        ) : (
          groups
            .map((g) => ({ g, items: sections.filter((s) => s.group === g.id) }))
            .filter(({ items }) => items.length)
            .map(({ g, items }) => (
              <section className="settings-tile-group" key={g.id} aria-labelledby={`settings-group-${g.id}`}>
                <h2 id={`settings-group-${g.id}`}>{groupName(g)}</h2>
                <ul className="settings-tiles">
                  {items.map((s) => (
                    <li key={s.id}>
                      <Tile area={area} section={s} summary={summaries[s.id]} title={tx(s.title)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))
        )}
      </div>
    </div>
  );
}

function Tile({ area, section, summary, title, anchor }: { area: SettingsArea; section: SectionDef; summary?: TileSummary; title: string; anchor?: string }) {
  const tx = useText();
  const { Icon } = section;
  const tone = summary?.tone;
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
        <strong>{title}</strong>
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

function SettingsDetail({ area, title, sections, groups, groupTitle, detailActions, section, anchor, Wrap }: ShellProps & { section: SectionDef; anchor: string | null }) {
  const t = useT();
  const tx = useText();
  const heading = useRef<HTMLHeadingElement>(null);
  const group = groups.find((g) => g.id === section.group);
  const groupName = group ? (groupTitle ? groupTitle(group) : tx(group.title)) : "";
  const siblings = sections.filter((s) => s.group === section.group);
  const { Component, Icon } = section;
  useEffect(() => {
    lastSection = section.id;
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
  }, [section.id, anchor]);
  const back = () => {
    if (openedFromHome && history.length > 1) {
      openedFromHome = false;
      history.back();
    } else location.hash = settingsHash({ area });
  };
  const body = <Component />;
  return (
    <div className="settings-detail">
      <div className="settings-detail-bar">
        <button type="button" className="settings-back" onClick={back}>
          <ArrowLeft size={18} aria-hidden />
          <span>{title}</span>
        </button>
      </div>
      <nav className="settings-breadcrumb" aria-label={t("Pfad", "Path")}>
        <a href={settingsHash({ area })}>{title}</a>
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
              <p>{tx(section.description)}</p>
            </div>
            {detailActions && <div className="settings-detail-actions">{detailActions}</div>}
          </header>
          <div className="settings-body">{Wrap ? <Wrap>{body}</Wrap> : body}</div>
        </div>
        {siblings.length > 1 && (
          <nav className="settings-rail" aria-label={t(`Auch in ${groupName}`, `Also in ${groupName}`)}>
            <h2>{groupName}</h2>
            <ul>
              {siblings.map((s) => (
                <li key={s.id}>
                  <a href={settingsHash({ area, section: s.id })} aria-current={s.id === section.id ? "page" : undefined}>
                    <s.Icon size={16} aria-hidden />
                    {tx(s.title)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </div>
  );
}
