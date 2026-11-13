"use client";
// A collection's results (#86, #collection/<id>): the pages and records
// that match its query now, as a list or a table (title, type, space, tags,
// updated, creator – sortable). Worked out again on opening and whenever
// the workspace changes (the shell's refresh hands over a new bootstrap).
// 500 at a time; "Load more" appends the next page (#270).
import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CaretUp, Copy, FunnelSimple, ListBullets, PencilSimple, Rows, ShareNetwork, Table, Trash } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, PageIcon } from "./ui";
import { TagChip } from "./page-properties";
import { pageLocationHash } from "@/lib/page-location";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { PageTag } from "@/lib/page-properties";
import type { CollectionInfo, CollectionItem } from "@/lib/collections";
import type { Bootstrap } from "@/lib/types";

type Results = { collection: CollectionInfo; items: CollectionItem[]; total: number; truncated: boolean; nextOffset?: number | null; encryptedLeftOut: boolean };
type SortKey = "title" | "type" | "space" | "tags" | "updated" | "creator";
type T = Awaited<ReturnType<typeof useT>>;

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const VIEW_KEY = "flowplan:collection-view";
// One page of results; a refresh fetches everything loaded so far at once
// (up to the server's maximum per request).
const PAGE = 500,
  REFRESH_MAX = 5000;
const itemKey = (i: CollectionItem) => (i.rowId ? `${i.pageId}:${i.rowId}` : i.pageId);
const resultsUrl = (collectionId: string, offset: number, limit: number) =>
  `/api/collections/${collectionId}?${new URLSearchParams({ tz: zone(), offset: String(offset), limit: String(limit) })}`;
// Later pages after the first, without repeating one already there (the
// workspace may change between two pages).
function appendPage(prev: Results, next: Results): Results {
  const seen = new Set(prev.items.map(itemKey));
  return { ...next, items: [...prev.items, ...next.items.filter((i) => !seen.has(itemKey(i)))] };
}
function readView(): "list" | "table" {
  try {
    return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "list";
  } catch {
    return "list";
  }
}
const when = (value: string | null) => {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value.replace(" ", "T") : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
};
export function typeName(type: string, t: T) {
  return (
    {
      document: t("Dokument", "Document"),
      database: t("Datenbank", "Database"),
      whiteboard: t("Whiteboard", "Whiteboard"),
      record: t("Eintrag", "Record"),
      notebook: t("Notizbuch", "Notebook"),
      journal: t("Journal", "Journal"),
      dashboard: t("Dashboard", "Dashboard"),
    } as Record<string, string>
  )[type] ?? type;
}

export function CollectionView({
  boot,
  collectionId,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  boot: Bootstrap;
  collectionId: string;
  onOpen: (pageId: string) => void;
  onEdit: (c: CollectionInfo) => void;
  onDuplicate: (c: CollectionInfo) => void;
  onDelete: (c: CollectionInfo) => void;
}) {
  const t = useT();
  const collection = boot.collections?.find((c) => c.id === collectionId);
  const [results, setResults] = useState<Results | null>(null),
    [failed, setFailed] = useState(false),
    [view, setView] = useState<"list" | "table">("list"),
    [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "updated", desc: true }),
    [loadingMore, setLoadingMore] = useState(false),
    [moreFailed, setMoreFailed] = useState(false);
  // How many results are shown (a refresh keeps them all), and which
  // request is current (a page answered after a refresh is dropped).
  const loaded = useRef(PAGE),
    generation = useRef(0);
  useEffect(() => setView(readView()), []);
  // A collection opened anew starts without the old one's results.
  useEffect(() => {
    loaded.current = PAGE;
    setResults(null);
  }, [collectionId]);
  // Again whenever the bootstrap changes (a change in the workspace, the
  // regular refresh) or the query does.
  useEffect(() => {
    let live = true;
    const run = ++generation.current;
    (async () => {
      const want = Math.max(PAGE, Math.ceil(loaded.current / PAGE) * PAGE);
      let r = await api<Results>(resultsUrl(collectionId, 0, Math.min(want, REFRESH_MAX)));
      while (live && r.nextOffset && r.items.length < want) r = appendPage(r, await api<Results>(resultsUrl(collectionId, r.nextOffset, Math.min(want - r.items.length, REFRESH_MAX))));
      return r;
    })()
      .then((r) => {
        if (!live || run !== generation.current) return;
        setResults(r);
        setFailed(false);
        setLoadingMore(false);
      })
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setLoadingMore(false);
      });
    return () => {
      live = false;
    };
  }, [collectionId, boot, collection?.query]);
  const loadMore = () => {
    if (!results?.nextOffset || loadingMore) return;
    const run = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    api<Results>(resultsUrl(collectionId, results.nextOffset, PAGE))
      .then((next) => {
        if (run !== generation.current) return;
        setResults((prev) => {
          const merged = prev ? appendPage(prev, next) : next;
          loaded.current = merged.items.length;
          return merged;
        });
      })
      .catch(() => run === generation.current && setMoreFailed(true))
      .finally(() => run === generation.current && setLoadingMore(false));
  };
  const tags = useMemo(() => new Map((boot.taxonomy?.tags ?? []).map((x) => [x.id, x])), [boot.taxonomy]);
  const spaceName = (id: string) => boot.spaces.find((s) => s.id === id)?.name ?? "";
  const items = useMemo(() => {
    const list = [...(results?.items ?? [])];
    const key = (i: CollectionItem): string => {
      switch (sort.key) {
        case "title":
          return i.title.toLocaleLowerCase();
        case "type":
          return typeName(i.type, t);
        case "space":
          return spaceName(i.spaceId).toLocaleLowerCase();
        case "tags":
          return i.tags.map((id) => tags.get(id)?.name ?? "").join(" ").toLocaleLowerCase();
        case "creator":
          return i.creatorName.toLocaleLowerCase();
        default:
          return i.updatedAt ?? "";
      }
    };
    list.sort((a, b) => key(a).localeCompare(key(b), LOCALE_TAG) * (sort.desc ? -1 : 1));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, sort, tags]);
  const switchView = (next: "list" | "table") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {}
  };
  const href = (i: CollectionItem) => pageLocationHash({ pageId: i.pageId, ...(i.rowId ? { rowId: i.rowId } : {}) });
  const date = (value: string | null) => when(value)?.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric" }) ?? "";
  const chips = (i: CollectionItem) =>
    i.tags
      .map((id) => tags.get(id))
      .filter((x): x is PageTag => !!x)
      .slice(0, 4)
      .map((x) => <TagChip key={x.id} tag={x} />);
  if (!collection)
    return (
      <div className="utility-content collection-view">
        <div className="empty-state">
          <FunnelSimple size={38} />
          <h3>{t("Sammlung nicht gefunden", "Collection not found")}</h3>
          <p>{t("Sie wurde gelöscht oder nicht mehr mit dir geteilt.", "It was deleted or is no longer shared with you.")}</p>
        </div>
      </div>
    );
  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "updated" }))}>
        {label}
        {sort.key === key && (sort.desc ? <CaretDown size={11} aria-hidden /> : <CaretUp size={11} aria-hidden />)}
      </button>
    </th>
  );
  const total = results?.total ?? 0;
  return (
    <div className="utility-content collection-view">
      <div className="utility-title collection-title">
        <span className="collection-title-icon" aria-hidden>
          {collection.icon || <FunnelSimple size={30} />}
        </span>
        <h1>{collection.name}</h1>
        <p>
          {!results
            ? failed
              ? t("Die Ergebnisse konnten nicht geladen werden.", "The results could not be loaded.")
              : t("Wird geladen …", "Loading …")
            : total === 1
              ? t("1 Treffer", "1 match")
              : t(`${total} Treffer`, `${total} matches`)}
          {collection.shared &&
            (collection.mine
              ? ` · ${t("Mit dem Arbeitsbereich geteilt", "Shared with the workspace")}`
              : ` · ${t(`Geteilt von ${collection.ownerName}`, `Shared by ${collection.ownerName}`)}`)}
        </p>
        <code className="collection-query" title={t("Abfrage", "Query")}>
          {collection.query}
        </code>
      </div>
      <div className="collection-toolbar">
        <div className="segmented" role="group" aria-label={t("Darstellung", "Layout")}>
          <button type="button" aria-pressed={view === "list"} className={view === "list" ? "selected" : ""} onClick={() => switchView("list")}>
            <ListBullets size={15} aria-hidden /> {t("Liste", "List")}
          </button>
          <button type="button" aria-pressed={view === "table"} className={view === "table" ? "selected" : ""} onClick={() => switchView("table")}>
            <Table size={15} aria-hidden /> {t("Tabelle", "Table")}
          </button>
        </div>
        <span className="collection-toolbar-actions">
          {collection.canEdit && (
            <button type="button" className="button compact" onClick={() => onEdit(collection)}>
              <PencilSimple size={15} aria-hidden /> {t("Filter bearbeiten", "Edit filters")}
            </button>
          )}
          {!collection.mine && (
            <button type="button" className="button compact" onClick={() => onDuplicate(collection)}>
              <Copy size={15} aria-hidden /> {t("Als meine Sammlung duplizieren", "Duplicate as my collection")}
            </button>
          )}
          {collection.canEdit && (
            <button type="button" className="button compact" onClick={() => onDelete(collection)}>
              <Trash size={15} aria-hidden /> {t("Löschen", "Delete")}
            </button>
          )}
        </span>
      </div>
      {results?.encryptedLeftOut && (
        <p className="collection-note" role="note">
          {t(
            "Ende-zu-Ende-verschlüsselte Bereiche werden nicht durchsucht – der Server kann ihren Inhalt nicht lesen.",
            "End-to-end encrypted spaces are not searched – the server cannot read their content.",
          )}
        </p>
      )}
      {results && !items.length && (
        <div className="empty-state">
          <FunnelSimple size={38} />
          <h3>{t("Nichts gefunden", "Nothing found")}</h3>
          <p>{t("Neue und geänderte Seiten, die passen, erscheinen hier von selbst.", "New and changed pages that match appear here by themselves.")}</p>
        </div>
      )}
      {items.length > 0 && view === "list" && (
        <ul className="tag-view-pages collection-list" aria-label={t("Treffer", "Matches")}>
          {items.map((i) => (
            <li key={i.rowId ?? i.pageId}>
              <a
                className="utility-row tag-view-page"
                href={href(i)}
                onClick={(e) => {
                  if (i.rowId || e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  onOpen(i.pageId);
                }}
              >
                {i.type === "record" ? i.icon ? <PageIcon name={i.icon} /> : <Rows size={18} aria-hidden /> : <PageIcon name={i.type === "database" ? "table" : i.icon} />}
                <strong>
                  {i.title || t("Ohne Titel", "Untitled")}
                  <small>
                    {typeName(i.type, t)}
                    {i.database ? ` · ${i.database}` : ""}
                    {spaceName(i.spaceId) ? ` · ${spaceName(i.spaceId)}` : ""}
                    {i.updatedAt ? ` · ${date(i.updatedAt)}` : ""}
                  </small>
                </strong>
                <span className="tag-view-page-tags">{chips(i)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && view === "table" && (
        <div className="collection-table-wrap" tabIndex={0} role="region" aria-label={t("Treffer als Tabelle", "Matches as a table")}>
          <table className="collection-table">
            <thead>
              <tr>
                {header("title", t("Titel", "Title"))}
                {header("type", t("Art", "Type"))}
                {header("space", t("Bereich", "Space"))}
                {header("tags", t("Tags", "Tags"))}
                {header("updated", t("Geändert", "Updated"))}
                {header("creator", t("Erstellt von", "Created by"))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.rowId ?? i.pageId}>
                  <td>
                    <a
                      href={href(i)}
                      onClick={(e) => {
                        if (i.rowId || e.metaKey || e.ctrlKey) return;
                        e.preventDefault();
                        onOpen(i.pageId);
                      }}
                    >
                      {i.title || t("Ohne Titel", "Untitled")}
                    </a>
                    {i.database && <small> · {i.database}</small>}
                  </td>
                  <td>{typeName(i.type, t)}</td>
                  <td>{spaceName(i.spaceId)}</td>
                  <td>
                    <span className="collection-table-tags">{chips(i)}</span>
                  </td>
                  <td>
                    <time dateTime={when(i.updatedAt)?.toISOString()}>{date(i.updatedAt)}</time>
                  </td>
                  <td>{i.creatorName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results?.truncated && (
        <div className="collection-load-more">
          <p className="muted collection-more" aria-live="polite">
            {t(`${results.items.length} von ${results.total} Treffern`, `${results.items.length} of ${results.total} matches`)}
            {moreFailed && ` · ${t("Weitere Treffer konnten nicht geladen werden.", "More matches could not be loaded.")}`}
          </p>
          <button type="button" className="button compact" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
            {loadingMore ? t("Wird geladen …", "Loading …") : t("Mehr laden", "Load more")}
          </button>
        </div>
      )}
      {collection.shared && !collection.mine && (
        <p className="muted collection-more">
          <ShareNetwork size={13} aria-hidden /> {t("Du siehst nur die Treffer, die du lesen darfst.", "You only see the matches you may read.")}
        </p>
      )}
    </div>
  );
}
