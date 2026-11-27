"use client";
// The quick search and command palette (⌘K / Ctrl+K): hits, recently viewed
// pages and records, and the commands ("> …"). Its state lives here, not in
// the workspace (components/workspace-app.tsx): opening it and typing in it
// re-render only this dialog, never the sidebar tree or the open page
// (#610). The workspace opens it through a handle (`open`, `close`, `hide`)
// and hands in what the palette shows and does: the commands of the moment
// as a function of the query, and what choosing a hit or command means.
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  BookmarkSimple,
  CalendarX,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  Sparkle,
  SquareSplitHorizontal,
  X,
} from "@phosphor-icons/react";
import type { FeatureModule } from "@/lib/feature-modules";
import type { WorkspacePlace } from "@/lib/workspace-navigation";
import type { Page, Space } from "@/lib/types";
import type { RecentVisit, SearchKind, SearchResult, SearchSort } from "@/lib/search-index";
import type { WorkspaceTaxonomy } from "@/lib/page-properties";
import { contextOf, parseSearchTokens, tagToken } from "@/lib/page-properties";
import { groupByDay, hitPath } from "@/lib/search-palette";
import { indexById, type PathRecordParent } from "@/lib/page-path";
import { openModeOf, type OpenMode } from "@/lib/open-place";
import { shownPageIcon } from "@/lib/page-link-icons";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useLocale, useT } from "./i18n";
import { Modal, PageIcon, api, deviceOffline } from "./ui";
import { ago } from "./page-activity";
import { Select } from "./select";
import { SearchTagFilter, useTagSuggest } from "./tag-suggestions";
import { isPdfName, openPdfPanel } from "./pdf-viewer";
import { prefetchPage, prefetchRecord, INTENT_DELAY } from "./prefetch";
import { ListSkeleton } from "./skeleton";

export type CommandAction = {
  label: string;
  keywords: string;
  icon: import("@phosphor-icons/react").Icon;
  run: () => void;
  // The feature it belongs to: left out while that is switched off (#378).
  module?: FeatureModule;
  // The place of the sidebar it leads to: left out while the workspace
  // hides it (#564).
  place?: WorkspacePlace;
};
// "Lernen: <Stapel>": a deck with cards left today.
export type PaletteDeck = { pageId: string; title: string; left: number };
// Where a chosen page goes: the split view, a new tab of a frame (#444),
// or – neither – the usual way.
export type PaletteTarget = { split: boolean; tab: number | null };
export type PaletteOpenOptions = { split?: boolean; tab?: number | null; query?: string };
export type PaletteHandle = {
  // Opens (or keeps open) the palette; given options replace the current ones.
  open: (options?: PaletteOpenOptions) => void;
  // Closes and forgets the query and where a hit would go.
  close: () => void;
  // Closes and keeps the query (the shortcut while open, "Präsentieren").
  hide: () => void;
  isOpen: () => boolean;
};
// One row of the command palette: a search hit, a recently viewed page or a
// command. The id names the option for aria-activedescendant.
type PaletteItem =
  | { kind: "result"; id: string; result: SearchResult }
  | { kind: "recent"; id: string; result: RecentVisit }
  | { kind: "command"; id: string; action: CommandAction };

export type CommandPaletteProps = {
  handle: Ref<PaletteHandle>;
  workspaceId: string;
  // The pages the person may read, under the titles the workspace knows
  // (decrypted), without deleted ones and template drafts.
  pages: readonly Page[];
  spaces: readonly Space[];
  recordParents: readonly PathRecordParent[];
  taxonomy?: WorkspaceTaxonomy;
  recentVisits?: readonly { pageId: string; seenAt: number }[];
  // "Ohne Journaltage" is offered while the workspace has a journal.
  hasJournal: boolean;
  phone: boolean;
  canAsk: boolean;
  clock: number | null;
  // The commands for this query, already without switched-off features and
  // hidden places. Called only while the palette is open.
  commands: (query: string, decks: readonly PaletteDeck[]) => CommandAction[];
  // A command was chosen (the palette is closed already); `tab`: the frame
  // of a new tab it was asked for (#444).
  onCommand: (action: CommandAction, tab: number | null) => void;
  // A hit or recent visit was chosen (the palette is closed already).
  onOpen: (item: { kind: "recent"; result: RecentVisit } | { kind: "result"; result: SearchResult }, mode: OpenMode, target: PaletteTarget) => void;
  onAsk: (question: string) => void;
  // "Als Sammlung speichern": the query with kind and space as tokens, and the name.
  onSaveCollection: (query: string, name: string) => void;
  // Each time it opens ("Erste Schritte" ticks the search).
  onOpened?: () => void;
};

const normalizeCommand = (value: string) =>
  value
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

export function CommandPalette(props: CommandPaletteProps) {
  const { handle, workspaceId, onOpened } = props;
  const [open, setOpen] = useState(false),
    [split, setSplit] = useState(false),
    [tab, setTab] = useState<number | null>(null),
    [query, setQuery] = useState(""),
    // Best match, last edited or created first (#243).
    [sort, setSort] = useState<SearchSort>("relevance"),
    [kind, setKind] = useState<SearchKind>("all"),
    [space, setSpace] = useState(""),
    // "Ohne Journaltage": hits on journal days left out (remembered here).
    [noDays, setNoDays] = useState(false),
    // Nothing typed (#243): the person's recently visited pages and
    // records, kept for the next opening.
    [recentHits, setRecentHits] = useState<RecentVisit[] | null>(null),
    [decks, setDecks] = useState<PaletteDeck[]>([]);
  // The element that opened the quick search gets the focus back when it
  // closes (the search button, a tree item or the editor).
  const opener = useRef<HTMLElement | null>(null),
    openRef = useRef(false);
  openRef.current = open;
  useImperativeHandle(
    handle,
    () => ({
      open: (options = {}) => {
        if (!openRef.current) opener.current = document.activeElement as HTMLElement | null;
        openRef.current = true;
        if (options.split !== undefined) setSplit(options.split);
        if (options.tab !== undefined) setTab(options.tab);
        if (options.query !== undefined) setQuery(options.query);
        setOpen(true);
      },
      close: () => {
        openRef.current = false;
        setOpen(false);
        setSplit(false);
        setTab(null);
        setQuery("");
      },
      hide: () => {
        openRef.current = false;
        setOpen(false);
      },
      isOpen: () => openRef.current,
    }),
    [],
  );
  useEffect(() => {
    try {
      setNoDays(localStorage.getItem("flowplan:search-no-days") === "1");
    } catch {}
  }, []);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  useEffect(() => {
    if (open) onOpenedRef.current?.();
  }, [open]);
  // "Lernen: <Stapel>": the decks of the workspace with cards left today,
  // once per opening of the palette (the deck list is not in the bootstrap).
  useEffect(() => {
    if (!open || deviceOffline()) return;
    let live = true;
    void api<{ decks: { pageId: string; title: string; new: number; learning: number; review: number }[] }>(
      `/api/study/due?${new URLSearchParams({ workspace: workspaceId, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })}`,
    )
      .then((due) => live && setDecks(due.decks.map((d) => ({ pageId: d.pageId, title: d.title, left: d.new + d.learning + d.review })).filter((d) => d.left > 0).slice(0, 30)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, workspaceId]);
  // Nothing typed: the recently visited list (refreshed with each opening
  // and filter change).
  const typed = !!query.trim();
  useEffect(() => {
    if (!open || typed) return;
    const controller = new AbortController();
    fetch(
      `/api/search/recent?${new URLSearchParams({
        workspace: workspaceId,
        kind,
        ...(space ? { space } : {}),
        limit: "20",
      })}`,
      { signal: controller.signal },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => list && setRecentHits(list))
      .catch(() => {});
    return () => controller.abort();
  }, [typed, open, workspaceId, kind, space]);
  const close = () => {
    openRef.current = false;
    setOpen(false);
    setSplit(false);
    setTab(null);
    setQuery("");
  };
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={close}
      title={t("Schnellsuche", "Quick search")}
      className="command-palette"
      onCloseAutoFocus={(e) => {
        // Back to where the search was opened from, not to <body>.
        e.preventDefault();
        // "KI fragen" from the palette has taken focus into its panel.
        if (document.querySelector(".ask-panel")?.contains(document.activeElement)) return;
        const from = opener.current;
        if (from && document.contains(from)) from.focus();
      }}
    >
      {open && (
        <PaletteBody
          {...props}
          query={query}
          setQuery={setQuery}
          split={split}
          tab={tab}
          kind={kind}
          setKind={setKind}
          space={space}
          setSpace={setSpace}
          sort={sort}
          setSort={setSort}
          noDays={noDays}
          toggleNoDays={() =>
            setNoDays((on) => {
              try {
                localStorage.setItem("flowplan:search-no-days", on ? "0" : "1");
              } catch {}
              return !on;
            })
          }
          recentHits={recentHits}
          decks={decks}
          close={close}
          hide={() => {
            openRef.current = false;
            setOpen(false);
          }}
        />
      )}
    </Modal>
  );
}

function PaletteBody({
  pages,
  spaces,
  recordParents,
  taxonomy,
  recentVisits,
  hasJournal,
  phone,
  canAsk,
  clock,
  workspaceId,
  commands,
  onCommand,
  onOpen,
  onAsk,
  onSaveCollection,
  query,
  setQuery,
  split,
  tab,
  kind,
  setKind,
  space,
  setSpace,
  sort,
  setSort,
  noDays,
  toggleNoDays,
  recentHits,
  decks,
  close,
  hide,
}: CommandPaletteProps & {
  query: string;
  setQuery: (value: string | ((q: string) => string)) => void;
  split: boolean;
  tab: number | null;
  kind: SearchKind;
  setKind: (kind: SearchKind) => void;
  space: string;
  setSpace: (space: string) => void;
  sort: SearchSort;
  setSort: (sort: SearchSort) => void;
  noDays: boolean;
  toggleNoDays: () => void;
  recentHits: RecentVisit[] | null;
  decks: readonly PaletteDeck[];
  close: () => void;
  hide: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  // A search is on its way: placeholders instead of "Nothing found".
  const [searching, setSearching] = useState(false);
  // The highlighted row (aria-activedescendant).
  const [active, setActive] = useState(0);
  // The tags the search offers (#328): the chosen space's and the
  // workspace's, or all with the space's name as a hint (#136).
  const tagChoices = useMemo(() => (space ? contextOf(taxonomy?.tags ?? [], space) : (taxonomy?.tags ?? [])), [taxonomy, space]);
  const spaceById = indexById(spaces);
  const tagHint = (tag: { spaceId?: string | null }) => (!space && tag.spaceId ? spaceById.get(tag.spaceId)?.name : undefined);
  // Typing `#` in the search input suggests tags; not in command mode.
  const hashTags = useTagSuggest({ value: query, onChange: setQuery, tags: tagChoices, disabled: query.startsWith(">"), hint: tagHint });
  // `#tag` and `name:value` in the search (lib/page-properties.ts), shown
  // as chips under the input.
  const searchTokens = useMemo(
    () => parseSearchTokens(query.startsWith(">") ? "" : query, { tags: taxonomy?.tags ?? [], properties: taxonomy?.properties ?? [] }),
    [query, taxonomy],
  );
  useEffect(() => {
    // Nothing typed: the recently visited list, no search.
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(
        `/api/search?${new URLSearchParams({
          workspace: workspaceId,
          q: query,
          kind,
          ...(space ? { space } : {}),
          ...(noDays ? { days: "0" } : {}),
          ...(sort !== "relevance" ? { sort } : {}),
          // For created:today and the like (#86).
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        })}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? r.json() : []))
        .then((results) => {
          setSearchResults(results);
          setSearching(false);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspaceId, kind, space, noDays, sort]);
  // Commands ("> …" or matching words).
  const commandQuery = normalizeCommand(query.replace(/^>\s*/, ""));
  const commandsOnly = query.startsWith(">");
  const shownActions =
    commandsOnly || commandQuery.length >= 2
      ? commands(query, decks)
          .filter((a) => !commandQuery || normalizeCommand(`${a.label} ${a.keywords}`).includes(commandQuery))
          .slice(0, commandsOnly ? 20 : 4)
      : [];
  // Nothing typed: the recently visited pages and records (#243), until
  // they arrive the start page's list. Pages under the titles the
  // workspace knows (decrypted, readable); records as the server names them.
  const pageById = indexById(pages);
  const recentPages: RecentVisit[] =
    commandsOnly || query.trim()
      ? []
      : (recentHits ??
          (recentVisits || []).flatMap((visit): RecentVisit[] => {
            const page = pageById.get(visit.pageId);
            return page ? [{ id: page.id, title: page.title, icon: page.icon, space_id: page.space_id, kind: page.kind === "database" || page.kind === "whiteboard" ? page.kind : "document", snippet: "", updatedAt: page.updated_at, visitedAt: visit.seenAt }] : [];
          }))
          .flatMap((hit) => {
            if (hit.rowId) return [hit];
            const page = pageById.get(hit.id);
            return page ? [{ ...hit, title: page.title, icon: page.icon }] : [];
          })
          .slice(0, 20);
  const recentGroups = groupByDay(recentPages);
  const paletteResults = commandsOnly || !query.trim() ? [] : searchResults;
  const resultPath = (hit: { id: string; rowId?: string; space_id: string }) => hitPath(hit, pages, spaces, recordParents, phone ? 3 : 4);
  const edited = (value?: string) => {
    if (!value) return "";
    const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? t(`Bearbeitet ${ago(ms, clock ?? Date.now(), locale)}`, `Edited ${ago(ms, clock ?? Date.now(), locale)}`) : "";
  };
  const items: PaletteItem[] = [
    ...recentGroups.flatMap((group) => group.items).map((result): PaletteItem => ({ kind: "recent", id: `recent-${result.id}-${result.rowId || ""}`, result })),
    ...paletteResults.map((result): PaletteItem => ({ kind: "result", id: `result-${result.kind}-${result.id}-${result.rowId || ""}`, result })),
    ...shownActions.map((action, i): PaletteItem => ({ kind: "command", id: `command-${i}`, action })),
  ];
  const activeIndex = Math.min(active, Math.max(0, items.length - 1)),
    activeItem = items[activeIndex];
  // The highlight starts at the top whenever the rows change.
  useEffect(() => {
    setActive(0);
  }, [query, searchResults, kind, space, noDays]);
  // The highlighted row stays in view. Only the list scrolls, and only once
  // the highlight has moved: scrollIntoView() on every render laid out the
  // whole page behind the dialog while it opened and with every key typed
  // (#610) – the first row of a fresh list is in view anyway.
  const list = useRef<HTMLDivElement>(null),
    scrolled = useRef(false);
  const activeId = activeItem?.id;
  useEffect(() => {
    const box = list.current;
    if (!box || !activeId || (activeIndex === 0 && !scrolled.current)) return;
    const row = document.getElementById(`palette-${activeId}`);
    if (!row) return;
    scrolled.current = true;
    // As the list's scroll-padding (app/globals.css, .palette-list).
    const pad = 8,
      view = box.getBoundingClientRect(),
      at = row.getBoundingClientRect();
    if (at.top < view.top + pad) box.scrollTop -= view.top + pad - at.top;
    else if (at.bottom > view.bottom - pad) box.scrollTop += at.bottom - (view.bottom - pad);
  }, [activeId, activeIndex]);
  const runItem = (item: PaletteItem, mode: OpenMode = "here") => {
    const target = { split, tab };
    close();
    if (item.kind === "command") onCommand(item.action, target.tab);
    else onOpen(item, mode, target);
  };
  // Hovering or highlighting a hit loads its page ahead (components/prefetch.ts).
  const prefetchOf = (item: PaletteItem) =>
    item.kind === "command"
      ? {}
      : { "data-prefetch-page": item.result.id, ...(item.result.rowId ? { "data-prefetch-row": item.result.rowId } : {}) };
  useEffect(() => {
    if (!activeItem || activeItem.kind === "command") return;
    const timer = setTimeout(() => {
      const target = { id: activeItem.result.id, row: activeItem.result.rowId };
      if (target.row) prefetchRecord(target.id, target.row);
      else prefetchPage(target.id);
    }, INTENT_DELAY);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem?.id]);
  // A PDF among the files found: also into the side panel (#392).
  const pdfHit = (p: SearchResult) => (p.kind === "file" && p.fileId && isPdfName(p.title) ? `/api/files/${p.fileId}` : null);
  const option = (item: PaletteItem, index: number, content: ReactNode) => (
    <div
      key={item.id}
      {...prefetchOf(item)}
      id={`palette-${item.id}`}
      role="option"
      aria-selected={index === activeIndex}
      className={`palette-option${index === activeIndex ? " active" : ""}`}
      onClick={(e) => runItem(item, openModeOf(e))}
      onMouseMove={() => index !== active && setActive(index)}
    >
      {content}
      {index === activeIndex && <kbd aria-hidden="true">↵</kbd>}
    </div>
  );
  return (
    <>
      <div className="command-search">
        <MagnifyingGlass size={22} />
        <input
          autoFocus
          role="combobox"
          aria-label={t("Suchen oder Befehl", "Search or command")}
          aria-expanded="true"
          // While tags are suggested after `#` (#328), they are the list.
          aria-controls={hashTags.open ? hashTags.listId : "palette-list"}
          aria-autocomplete="list"
          aria-activedescendant={hashTags.open ? hashTags.activeId : activeItem ? `palette-${activeItem.id}` : undefined}
          placeholder={
            split
              ? t("Seite für die geteilte Ansicht suchen …", "Find a page for the split view …")
              : tab !== null
                ? t("Seite für den neuen Tab suchen …", "Find a page for the new tab …")
                : t("Suchen … oder > für Befehle", "Search … or > for commands")
          }
          value={query}
          {...hashTags.fieldProps}
          onChange={(e) => {
            setQuery(e.target.value);
            hashTags.changed(e.target);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (hashTags.keyDown(e)) return;
            // The arrows move over the rows while the focus stays here;
            // Tab reaches the filters as before.
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const count = items.length;
              if (count) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (activeItem) runItem(activeItem, openModeOf(e));
            }
          }}
        />
        <kbd>esc</kbd>
        {hashTags.list}
      </div>
      {searchTokens.tokens.length > 0 && (
        <div className="search-tokens" role="group" aria-label={t("Aktive Filter", "Active filters")}>
          {searchTokens.tokens.map((token) => (
            <span key={token} className="chip active search-token">
              {token}
              <button
                type="button"
                className="search-token-remove"
                aria-label={t(`Filter ${token} entfernen`, `Remove filter ${token}`)}
                onClick={() => setQuery((q) => q.replace(token, " ").replace(/\s+/g, " ").trimStart())}
              >
                <X size={11} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}
      {tab !== null && !split && (
        <p className="palette-split-hint" role="note">
          <Plus size={15} aria-hidden="true" />
          {t("Die gewählte Seite öffnet sich in einem neuen Tab.", "The chosen page opens in a new tab.")}
        </p>
      )}
      {split && (
        <p className="palette-split-hint" role="note">
          <SquareSplitHorizontal size={15} aria-hidden="true" />
          {t("Die gewählte Seite öffnet sich in der geteilten Ansicht rechts.", "The chosen page opens in the split view on the right.")}
        </p>
      )}
      <div className="search-filters">
        <div role="radiogroup" aria-label={t("Suchergebnisse filtern", "Filter search results")}>
          {(
            [
              ["all", t("Alles", "Everything")],
              ["document", t("Dokumente", "Documents")],
              ["database", t("Datenbanken", "Databases")],
              ["whiteboard", t("Whiteboards", "Whiteboards")],
              ["row", t("Einträge", "Records")],
              ["comment", t("Kommentare", "Comments")],
              ["file", t("Dateien", "Files")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={kind === value}
              className={`chip${kind === value ? " active" : ""}`}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {hasJournal && (
          <button type="button" className={`chip${noDays ? " active" : ""}`} aria-pressed={noDays} onClick={toggleNoDays}>
            <CalendarX size={13} /> {t("Ohne Journaltage", "Without journal days")}
          </button>
        )}
        <Select aria-label={t("Bereich", "Space")} value={space} onChange={(e) => setSpace(e.target.value)}>
          <option value="">{t("Alle Bereiche", "All spaces")}</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {/* Tags (#70): adds #tag to the search; recognised tokens show
            below. Found by typing (#328); with a space chosen its tags and
            the workspace's, for all spaces every tag, a space's with its
            name as a hint (#136). */}
        {tagChoices.length > 0 && (
          <SearchTagFilter tags={tagChoices} hint={tagHint} onPick={(tag) => setQuery((q) => `${q.trim()} ${tagToken(tag.name)} `.trimStart())} />
        )}
        {canAsk && query.trim() && !query.startsWith(">") && (
          <button
            className="button compact"
            onClick={() => {
              onAsk(query.trim());
              hide();
              setQuery("");
            }}
          >
            <Sparkle size={15} /> {t("KI fragen", "Ask AI")}
          </button>
        )}
        {query.trim() && !query.startsWith(">") && (
          <button
            className="button compact"
            onClick={() => {
              // The kind and space chosen above become part of the query.
              const chosen = spaceById.get(space);
              const kinds: Record<string, string> = { document: "document", database: "database", whiteboard: "whiteboard", row: "record" };
              const extra = [kinds[kind] ? `type:${kinds[kind]}` : "", chosen ? `in:"${chosen.name.replace(/"/g, "")}"` : ""].filter(Boolean).join(" ");
              onSaveCollection(extra ? `${/\bOR\b|\|/.test(query) ? `(${query.trim()})` : query.trim()} ${extra}` : query.trim(), query.trim().slice(0, 120));
              close();
            }}
          >
            <BookmarkSimple size={15} /> {t("Als Sammlung speichern", "Save as collection")}
          </button>
        )}
      </div>
      {/* One list for hits, recent pages and commands: the input keeps the
          focus and names the highlighted row (aria-activedescendant). */}
      <div ref={list} className="palette-list" id="palette-list" role="listbox" aria-label={t("Ergebnisse und Befehle", "Results and commands")}>
        {recentGroups.map((group, g) => {
          const offset = recentGroups.slice(0, g).reduce((n, x) => n + x.items.length, 0);
          return (
            <div key={group.day} className="search-results palette-group" role="group" aria-labelledby={g === 0 ? "palette-recent-title" : `palette-recent-${group.day}`}>
              <small className="palette-group-title" id={g === 0 ? "palette-recent-title" : `palette-recent-${group.day}`}>
                {g === 0 && <>{t("Zuletzt angesehen", "Recently viewed")} · </>}
                {group.label === "today"
                  ? t("Heute", "Today")
                  : group.label === "yesterday"
                    ? t("Gestern", "Yesterday")
                    : new Date(`${group.day}T12:00:00`).toLocaleDateString(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long" })}
              </small>
              {group.items.map((p, i) => {
                const path = resultPath(p);
                return option(
                  items[offset + i],
                  offset + i,
                  <>
                    <PageIcon name={shownPageIcon(p.icon, p.kind === "row" ? "row" : p.kind)} />
                    <span>
                      {p.title || t("Ohne Titel", "Untitled")}
                      {(path.length > 0 || p.updatedAt) && (
                        <small className="palette-path">
                          {path.join(" / ")}
                          {p.updatedAt && (
                            <span className="palette-date-inline">
                              {path.length ? " · " : ""}
                              {edited(p.updatedAt)}
                            </span>
                          )}
                        </small>
                      )}
                    </span>
                    <small className="palette-date">{edited(p.updatedAt)}</small>
                  </>,
                );
              })}
            </div>
          );
        })}
        {paletteResults.length > 0 && (
          <div className="palette-results-head">
            <small className="palette-group-title" role="status">
              {paletteResults.length >= 50
                ? t("Mehr als 50 Treffer", "More than 50 hits")
                : paletteResults.length === 1
                  ? t("1 Treffer", "1 hit")
                  : t(`${paletteResults.length} Treffer`, `${paletteResults.length} hits`)}
            </small>
            <Select aria-label={t("Sortierung", "Sort order")} className="palette-sort" value={sort} onChange={(e) => setSort(e.target.value as SearchSort)}>
              <option value="relevance">{t("Beste Treffer", "Best match")}</option>
              <option value="edited">{t("Zuletzt bearbeitet", "Last edited")}</option>
              <option value="created">{t("Zuletzt erstellt", "Recently created")}</option>
            </Select>
          </div>
        )}
        {paletteResults.length > 0 && (
          <div className="search-results palette-group" role="group" aria-label={t("Treffer", "Hits")}>
            {paletteResults.map((p, i) => {
              const path = resultPath(p);
              const pdf = pdfHit(p);
              return option(
                items[recentPages.length + i],
                recentPages.length + i,
                <>
                  <PageIcon name={shownPageIcon(p.icon, p.kind === "comment" || p.kind === "file" ? "document" : p.kind)} />
                  <span {...(pdf ? { "data-pdf-src": pdf, "data-pdf": p.title } : {})}>
                    {p.kind === "comment" ? commentHitTitle(p.title, t) : p.title}
                    {p.alias && <span className="alias-hit"> · {p.alias}</span>}
                    {p.pageTitle && (p.kind === "comment" || p.kind === "file") && (
                      <small className="search-context">
                        {p.kind === "comment" ? t(`Kommentar in ${p.pageTitle}`, `Comment in ${p.pageTitle}`) : t(`Datei in ${p.pageTitle}`, `File in ${p.pageTitle}`)}
                      </small>
                    )}
                    {(path.length > 0 || p.updatedAt) && (
                      <small className="palette-path">
                        {path.join(" / ")}
                        {p.updatedAt && (
                          <span className="palette-date-inline">
                            {path.length ? " · " : ""}
                            {edited(p.updatedAt)}
                          </span>
                        )}
                      </small>
                    )}
                    {p.snippet && (
                      <small className="search-snippet">
                        <SearchSnippet text={p.snippet} />
                      </small>
                    )}
                  </span>
                  <small className="palette-date">{edited(p.updatedAt)}</small>
                  {pdf && (
                    <button
                      type="button"
                      className="icon-button palette-side-panel"
                      aria-label={t(`„${p.title}“ im Seitenfenster öffnen`, `Open “${p.title}” in the side panel`)}
                      title={t("Im Seitenfenster öffnen", "Open in side panel")}
                      onClick={(e) => {
                        e.stopPropagation();
                        close();
                        openPdfPanel(pdf, p.title);
                      }}
                    >
                      <SidebarSimple size={16} />
                    </button>
                  )}
                </>,
              );
            })}
          </div>
        )}
        {shownActions.length > 0 && (
          <div className="command-actions palette-group" role="group" aria-labelledby="palette-actions-title">
            <small className="palette-group-title" id="palette-actions-title">
              {t("Aktionen", "Actions")}
            </small>
            {shownActions.map((action, i) =>
              option(
                items[recentPages.length + paletteResults.length + i],
                recentPages.length + paletteResults.length + i,
                <>
                  <action.icon size={17} />
                  <span>{action.label}</span>
                </>,
              ),
            )}
          </div>
        )}
        {searching && !paletteResults.length && !commandsOnly && <ListSkeleton rows={4} label={t("Suche läuft …", "Searching …")} />}
        {!items.length && !searching && (
          <div className="empty-state small">
            {query.trim()
              ? t("Nichts gefunden.", "Nothing found.")
              : t("Suche nach Seiten, Einträgen, Kommentaren und Dateien – oder tippe > für Befehle.", "Search for pages, records, comments and files – or type > for commands.")}
          </div>
        )}
      </div>
    </>
  );
}

// Comment hits are indexed with a German title (lib/search-index.ts).
function commentHitTitle(title: string, t: (de: string, en: string) => string) {
  const comment = title.match(/^Kommentar von (.+)$/);
  if (comment) return t(`Kommentar von ${comment[1]}`, `Comment by ${comment[1]}`);
  const inline = title.match(/^Textkommentar von (.+)$/);
  if (inline) return t(`Textkommentar von ${inline[1]}`, `Text comment by ${inline[1]}`);
  return title;
}
function SearchSnippet({ text }: { text: string }) {
  // Server marks hits with \u0002…\u0003; everything is rendered as text.
  return (
    <>
      {text.split("\u0002").map((part, i) => {
        if (!i) return <span key={i}>{part}</span>;
        const [hit, rest = ""] = part.split("\u0003");
        return (
          <span key={i}>
            <mark>{hit}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}
