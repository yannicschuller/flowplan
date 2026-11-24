"use client";
// PROTOTYPE – settings and administration in one place (lib/settings-variant.ts).
// Variants a–c: one screen "Einstellungen" for both areas. The addresses
// stay as they are (#settings/<id>, #admin/<id>): both open this screen.
//   a – one sidebar: personal, connections, workspace, help, then the
//       instance groups under "Instanz" (admins only)
//   b – a scope switcher "Für mich | Arbeitsbereich | Instanz" above the
//       sidebar, which shows only that scope's groups
//   c – an overview of cards (icon, title, the first sections as links)
//       with the search on top; a section has the normal rail
// Phones (a, b): the sidebar is the start screen (a list), a section opens
// full screen with "back".
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Briefcase,
  CaretRight,
  Database,
  GearSix,
  Lifebuoy,
  MagnifyingGlass,
  PlugsConnected,
  Pulse,
  ShieldCheck,
  Storefront,
  UserCircle,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import type { AdminSummary } from "@/lib/admin-summary";
import { parseSettingsHash, searchSettings, settingsHash, type GroupMeta, type SettingsArea, type Text } from "@/lib/settings-sections";
import { sectionVisible } from "@/lib/settings-level";
import { setOwnSettingsLevel, useSettingsLevel } from "@/lib/settings-level-client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { quotaPossible } from "@/lib/limits-summary";
import type { SettingsVariant } from "@/lib/settings-variant";
import { useT } from "../i18n";
import { api } from "../ui";
import { useAiQuota } from "../ai-quota";
import { Sparkline } from "../sparkline";
import { SettingsDetail, Tile, type TileSummary } from "./shell";
import { groupsOf, sectionDefs, type SectionDef } from "./registry";
import { UserSettingsProvider, type UserSettingsProps } from "./user-context";
import { AdminProvider } from "./admin-context";
import { userTiles } from "./user/tiles";
import { adminTiles } from "./admin/tiles";

const USER = sectionDefs("settings");
const ADMIN = sectionDefs("admin");
const USER_GROUPS = groupsOf("settings");
const ADMIN_GROUPS = groupsOf("admin");

export const GROUP_ICONS: Record<string, Icon> = {
  personal: UserCircle,
  connections: PlugsConnected,
  workspace: Briefcase,
  help: Lifebuoy,
  people: UsersThree,
  data: Database,
  services: Storefront,
  security: ShieldCheck,
  operations: Pulse,
};

type Route = { area: SettingsArea; section: string | null; anchor: string | null };

// The route of either area (#settings/…, #admin/…).
function useAnyRoute(): Route {
  const read = (): Route => {
    const parsed = typeof location === "undefined" ? null : parseSettingsHash(location.hash);
    return parsed ? { area: parsed.area, section: parsed.section, anchor: parsed.anchor } : { area: "settings", section: null, anchor: null };
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const sync = () => {
      const parsed = parseSettingsHash(location.hash);
      if (!parsed) return;
      if (parsed.redirected) history.replaceState(history.state, "", `${location.pathname}${location.search}${settingsHash(parsed)}`);
      setRoute({ area: parsed.area, section: parsed.section, anchor: parsed.anchor });
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return route;
}

// The administration's tile facts (/api/admin/summary), for admins only.
export function useAdminTiles(enabled: boolean): Record<string, TileSummary> {
  const t = useT();
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api<AdminSummary>("/api/admin/summary")
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [enabled]);
  return useMemo(() => (summary ? adminTiles(summary, t) : {}), [summary, t]);
}

// A small picture of a tile's facts: a trend, a meter or the first bar.
export function MiniVisual({ summary, large }: { summary?: TileSummary; large?: boolean }) {
  if (!summary) return null;
  if (summary.spark && summary.spark.filter((v) => typeof v === "number").length >= 2)
    return (
      <span className="sv-mini spark">
        <Sparkline values={summary.spark} label={summary.sparkLabel || ""} tone={summary.sparkTone} height={large ? 36 : 22} />
      </span>
    );
  const bars = summary.bars?.filter((b) => b.share !== null) ?? [];
  const meter = summary.meter ?? bars[0]?.share ?? undefined;
  if (meter === undefined || meter === null) return null;
  if (large && bars.length)
    return (
      <span className="sv-mini bars">
        {bars.slice(0, 2).map((b) => (
          <span key={b.label} className="sv-mini-bar">
            <span>
              {b.label} <strong>{b.text}</strong>
            </span>
            <progress max={1000} value={Math.round(Math.min(1, b.share!) * 1000)} aria-label={`${b.label}: ${b.text}`} />
          </span>
        ))}
      </span>
    );
  return (
    <span className="sv-mini meter">
      <progress max={1000} value={Math.round(Math.min(1, meter) * 1000)} aria-label={summary.meterLabel || summary.line || ""} />
    </span>
  );
}

export default function CombinedSettings(props: UserSettingsProps & { variant: SettingsVariant }) {
  const admin = !!props.boot.user.isAdmin;
  const inner = <Combined {...props} />;
  return (
    <UserSettingsProvider {...props}>
      {admin ? (
        <AdminProvider mutate={props.mutate} onError={props.onError}>
          {inner}
        </AdminProvider>
      ) : (
        inner
      )}
    </UserSettingsProvider>
  );
}

type Scope = "me" | "workspace" | "instance";

function Combined(props: UserSettingsProps & { variant: SettingsVariant }) {
  const { boot, variant } = props;
  const t = useT();
  const tx = useCallback((text: Text) => t(text.de, text.en), [t]);
  const admin = !!boot.user.isAdmin;
  const owner = boot.workspace.role === "owner";
  const level = useSettingsLevel();
  const levelProp = { value: level, onChange: (next: typeof level) => void setOwnSettingsLevel(props.mutate, next).catch((e) => props.onError((e as Error).message)) };
  const quota = useAiQuota(quotaPossible(boot.ai, !!boot.user.demo));
  const userSummaries = userTiles(boot, props.theme, t, quota, LOCALE_TAG);
  const adminSummaries = useAdminTiles(admin);
  const summaryOf = (s: SectionDef) => (s.area === "admin" ? adminSummaries[s.id] : userSummaries[s.id]);
  const route = useAnyRoute();
  const userShown = USER.filter((s) => sectionVisible(s, level));
  const all = admin ? [...userShown, ...ADMIN] : userShown;
  const groups: GroupMeta[] = admin ? [...USER_GROUPS, ...ADMIN_GROUPS] : USER_GROUPS;
  const groupName = (g: GroupMeta) => (g.id === "workspace" ? t(`Arbeitsbereich „${boot.workspace.name}“`, `Workspace “${boot.workspace.name}”`) : tx(g.title));
  const found = route.section ? [...USER, ...(admin ? ADMIN : [])].find((s) => s.area === route.area && s.id === route.section) || null : null;

  // Variant b: the scopes and their groups.
  const scopes: { id: Scope; label: string; groups: string[] }[] = [
    { id: "me", label: t("Für mich", "For me"), groups: owner ? ["personal", "connections", "help"] : ["personal", "connections", "workspace", "help"] },
    ...(owner ? [{ id: "workspace" as Scope, label: t("Arbeitsbereich", "Workspace"), groups: ["workspace"] }] : []),
    ...(admin ? [{ id: "instance" as Scope, label: t("Instanz", "Instance"), groups: ADMIN_GROUPS.map((g) => g.id) }] : []),
  ];
  const scopeOf = (s: SectionDef): Scope => scopes.find((sc) => sc.groups.includes(s.group))?.id ?? "me";
  const [chosenScope, setChosenScope] = useState<Scope>(() => (found ? scopeOf(found) : "me"));
  const scope = found ? scopeOf(found) : chosenScope;
  useEffect(() => {
    if (found) setChosenScope(scopeOf(found));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found?.id, found?.area]);
  const sideGroups = variant === "b" ? groups.filter((g) => scopes.find((sc) => sc.id === scope)?.groups.includes(g.id)) : groups;

  const detail = (section: SectionDef, anchor: string | null, noRail: boolean) => (
    <SettingsDetail
      area={section.area}
      title={t("Einstellungen", "Settings")}
      description=""
      HeaderIcon={GearSix}
      sections={section.area === "admin" ? ADMIN : userShown}
      groups={groups}
      groupTitle={groupName}
      summaries={{}}
      section={section}
      anchor={anchor}
      level={section.area === "settings" ? levelProp : undefined}
      noRail={noRail}
    />
  );

  if (variant === "c")
    return (
      <div className="utility-content settings-shell settings-page sv" data-variant="c">
        {found ? (
          detail(found, route.anchor, false)
        ) : (
          <Overview
            boot={boot}
            sections={all}
            groups={groups}
            groupName={groupName}
            summaryOf={summaryOf}
            tx={tx}
          />
        )}
      </div>
    );

  // a and b: sidebar + section. Without a section: phones show the sidebar
  // as a list, wide screens the first section next to it.
  const firstOf = (gs: GroupMeta[]) => gs.flatMap((g) => all.filter((s) => s.group === g.id))[0] || null;
  const shown = found || firstOf(sideGroups);
  return (
    <div className="utility-content settings-shell settings-page sv" data-variant={variant}>
      <div className="sv-layout" data-home={found ? "false" : "true"}>
        <header className="settings-home-head sv-phone-head">
          <span className="settings-head-icon" aria-hidden>
            <GearSix size={26} />
          </span>
          <div>
            <h1>{t("Einstellungen", "Settings")}</h1>
            <p>{t(`${boot.user.name} · Arbeitsbereich „${boot.workspace.name}“`, `${boot.user.name} · workspace “${boot.workspace.name}”`)}</p>
          </div>
        </header>
        {variant === "b" && scopes.length > 1 && (
          <div className="sv-scope" role="tablist" aria-label={t("Bereich der Einstellungen", "Scope of the settings")}>
            {scopes.map((sc) => (
              <button
                key={sc.id}
                type="button"
                role="tab"
                aria-selected={scope === sc.id}
                onClick={() => {
                  setChosenScope(sc.id);
                  const wide = window.matchMedia("(min-width: 768px)").matches;
                  const first = firstOf(groups.filter((g) => sc.groups.includes(g.id)));
                  if (wide && first) location.hash = settingsHash({ area: first.area, section: first.id });
                  else if (found) location.hash = "#settings";
                }}
              >
                {sc.id === "instance" && <ShieldCheck size={15} aria-hidden />}
                {sc.label}
              </button>
            ))}
          </div>
        )}
        <SideNav
          variant={variant}
          sections={all}
          groups={sideGroups}
          groupName={groupName}
          current={shown}
          summaryOf={summaryOf}
          tx={tx}
        />
        <div className="sv-main">{shown && detail(shown, found ? route.anchor : null, true)}</div>
      </div>
    </div>
  );
}

function SideNav({
  variant,
  sections,
  groups,
  groupName,
  current,
  summaryOf,
  tx,
}: {
  variant: SettingsVariant;
  sections: SectionDef[];
  groups: GroupMeta[];
  groupName: (g: GroupMeta) => string;
  current: SectionDef | null;
  summaryOf: (s: SectionDef) => TileSummary | undefined;
  tx: (text: Text) => string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const results = useMemo(() => (query.trim() ? searchSettings(sections, query, tx) : null), [query, sections, tx]);
  const nav = useRef<HTMLElement>(null);
  // The current section stays in sight in a long sidebar.
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !nav.current) return;
    const box = nav.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) nav.current.scrollTop += r.top - box.top - box.height / 3;
  }, [current?.id, current?.area]);
  let instanceHeading = false;
  return (
    <nav ref={nav} className="sv-side" aria-label={t("Einstellungen", "Settings")}>
      <div className="settings-search sv-side-search" role="search">
        <MagnifyingGlass size={16} aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Suchen …", "Search …")} aria-label={t("Einstellung suchen", "Search settings")} />
      </div>
      {results ? (
        <ul className="sv-side-list">
          {results.length === 0 && <li className="sv-side-empty">{t("Nichts gefunden.", "Nothing found.")}</li>}
          {results.map((r, i) => (
            <li key={`${r.section.area}-${r.section.id}-${i}`}>
              <a href={settingsHash({ area: r.section.area, section: r.section.id, anchor: r.anchor })} onClick={() => setQuery("")}>
                <r.section.Icon size={17} aria-hidden />
                <span className="sv-side-text">
                  <span>{r.entry ? tx(r.entry.title) : tx(r.section.title)}</span>
                  <small>
                    {r.section.area === "admin" ? `${t("Instanz", "Instance")} › ` : ""}
                    {r.entry ? tx(r.section.title) : tx(r.section.description)}
                  </small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        groups.map((g) => {
          const items = sections.filter((s) => s.group === g.id);
          if (!items.length) return null;
          const showInstance = variant === "a" && g.area === "admin" && !instanceHeading;
          if (showInstance) instanceHeading = true;
          return (
            <div key={g.id} className="sv-side-group" data-area={g.area}>
              {showInstance && (
                <h2 className="sv-side-scope">
                  <ShieldCheck size={14} aria-hidden />
                  {t("Instanz", "Instance")}
                  <span>{t("nur für Admins", "admins only")}</span>
                </h2>
              )}
              <h3>{groupName(g)}</h3>
              <ul className="sv-side-list">
                {items.map((s) => (
                  <li key={`${s.area}-${s.id}`}>
                    <a href={settingsHash({ area: s.area, section: s.id })} aria-current={current && current.id === s.id && current.area === s.area ? "page" : undefined}>
                      <s.Icon size={17} aria-hidden />
                      <span className="sv-side-text">
                        <span>{tx(s.title)}</span>
                        <small>{summaryOf(s)?.line || tx(s.description)}</small>
                      </span>
                      <MiniVisual summary={summaryOf(s)} />
                      <CaretRight size={14} className="sv-side-caret" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </nav>
  );
}

function Overview({
  boot,
  sections,
  groups,
  groupName,
  summaryOf,
  tx,
}: {
  boot: UserSettingsProps["boot"];
  sections: SectionDef[];
  groups: GroupMeta[];
  groupName: (g: GroupMeta) => string;
  summaryOf: (s: SectionDef) => TileSummary | undefined;
  tx: (text: Text) => string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const results = useMemo(() => (query.trim() ? searchSettings(sections, query, tx) : null), [query, sections, tx]);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="settings-home sv-overview">
      <header className="settings-home-head">
        <span className="settings-head-icon" aria-hidden>
          <GearSix size={26} />
        </span>
        <div>
          <h1>{t("Einstellungen", "Settings")}</h1>
          <p>{t(`${boot.user.name} · Arbeitsbereich „${boot.workspace.name}“`, `${boot.user.name} · workspace “${boot.workspace.name}”`)}</p>
        </div>
      </header>
      <div className="settings-search sv-overview-search" role="search">
        <MagnifyingGlass size={17} aria-hidden />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Einstellung suchen – auch Instanz …", "Search settings – instance too …")}
          aria-label={t("Einstellung suchen", "Search settings")}
        />
      </div>
      {results ? (
        <ul className="settings-tiles list">
          {results.map((r, i) => (
            <li key={`${r.section.area}-${r.section.id}-${i}`}>
              <Tile
                area={r.section.area}
                section={r.section}
                title={r.entry ? tx(r.entry.title) : tx(r.section.title)}
                anchor={r.anchor}
                summary={{ line: `${r.section.area === "admin" ? `${t("Instanz", "Instance")} › ` : ""}${tx(r.section.title)}`, badge: r.section.area === "admin" ? t("Instanz", "Instance") : undefined, tone: "off" }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="sv-cards">
          {groups.map((g) => {
            const items = sections.filter((s) => s.group === g.id);
            if (!items.length) return null;
            const GroupIcon = GROUP_ICONS[g.id] ?? GearSix;
            const pictured = items.find((s) => {
              const sum = summaryOf(s);
              return sum && (sum.spark?.length || sum.meter !== undefined || sum.bars?.some((b) => b.share !== null));
            });
            return (
              <section key={g.id} className="sv-card" data-area={g.area} aria-labelledby={`sv-card-${g.id}`}>
                <header>
                  <span className="sv-card-icon" aria-hidden>
                    <GroupIcon size={20} />
                  </span>
                  <h2 id={`sv-card-${g.id}`}>{groupName(g)}</h2>
                  {g.area === "admin" && <span className="sv-instance-chip">{t("Instanz", "Instance")}</span>}
                </header>
                {pictured && (
                  <a className="sv-card-visual" href={settingsHash({ area: pictured.area, section: pictured.id })}>
                    <span className="sv-card-visual-label">
                      {tx(pictured.title)}
                      <small>{summaryOf(pictured)?.line}</small>
                    </span>
                    <MiniVisual summary={summaryOf(pictured)} large />
                  </a>
                )}
                <ul>
                  {items.slice(0, 4).map((s) => (
                    <li key={s.id}>
                      <a href={settingsHash({ area: s.area, section: s.id })}>
                        <s.Icon size={16} aria-hidden />
                        <span>{tx(s.title)}</span>
                        <CaretRight size={13} aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
                {items.length > 4 && (
                  <a className="sv-card-more" href={settingsHash({ area: items[4].area, section: items[4].id })}>
                    {t(`Alle ${items.length} anzeigen`, `Show all ${items.length}`)}
                    <ArrowRight size={13} aria-hidden />
                  </a>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Variant d: the bridge from Settings into Administration.
export function AdminBridge({ summary }: { summary?: TileSummary }): ReactNode {
  const t = useT();
  return (
    <section className="settings-tile-group" aria-labelledby="settings-group-instance">
      <h2 id="settings-group-instance">{t("Instanz", "Instance")}</h2>
      <ul className="settings-tiles">
        <li>
          <a className="settings-tile sv-bridge" href="#admin">
            <span className="settings-tile-icon" aria-hidden>
              <ShieldCheck size={20} />
            </span>
            <span className="settings-tile-text">
              <strong>{t("Administration öffnen", "Open Administration")}</strong>
              <small>{t("Benutzer, Anmeldung, Speicher, Dienste und Betrieb der Instanz – nur für Admins.", "Users, sign-in, storage, services and operations of the instance – admins only.")}</small>
            </span>
            <MiniVisual summary={summary} />
            <ArrowRight size={16} className="settings-tile-caret" aria-hidden />
          </a>
        </li>
      </ul>
    </section>
  );
}
