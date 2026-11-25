"use client";
// "Verwandte Seiten" beside a page or record (GET /api/related) and the
// hint "Ähnliche Einträge gibt es schon" while naming a new page or record
// (GET /api/related?title=…). Both only show what the person may read
// (lib/related-pages.ts).
//
// Below a record's properties the list folds like them (a chevron, "Verwandte
// Seiten · 3"): folded unless the person opened it, one choice per database
// kept in the account (lib/page-view-prefs.ts, command
// database.collapseRelated).
import { shownPageIcon } from "@/lib/page-link-icons";
import { useEffect, useId, useState } from "react";
import { CaretRight, Sparkle, Warning } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, PageIcon } from "./ui";
import { appCache, pageKey } from "@/lib/swr-cache";
import { pageLocationHash } from "@/lib/page-location";
import type { RelatedItem, RelatedReason, SimilarItem } from "@/lib/related-pages";
import { recordPart } from "@/lib/record-context-client";

const go = (pageId: string, rowId?: string) => {
  location.hash = pageLocationHash({ pageId, rowId });
};

// Choices made in this tab, per database, ahead of database data that may
// still be cached from before.
const foldChoices = new Map<string, boolean>();

export function RelatedPages({
  pageId,
  rowId,
  onOpen = go,
  fold,
}: {
  pageId: string;
  rowId?: string;
  onOpen?: (pageId: string, rowId?: string) => void;
  // Below a record: foldable, with the person's stored choice for the
  // database (null or undefined: none – folded).
  fold?: { choice: boolean | null | undefined };
}) {
  const t = useT();
  const bodyId = useId();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const collapsed = !!fold && (toggled ?? foldChoices.get(pageId) ?? fold.choice ?? true);
  const [data, setData] = useState<{ items: RelatedItem[]; semantic: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    const params = new URLSearchParams({ page: pageId, ...(rowId ? { row: rowId } : {}) });
    const own = () => fetch(`/api/related?${params}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    (rowId ? recordPart<{ items: RelatedItem[]; semantic: boolean } | null>(pageId, rowId, "related", own) : own())
      .then((d) => live && setData(d && Array.isArray(d.items) ? d : { items: [], semantic: false }))
      .catch(() => live && setData({ items: [], semantic: false }));
    return () => {
      live = false;
    };
  }, [pageId, rowId]);
  if (!data?.items.length) return null;
  const reason = (r: RelatedReason) =>
    ({
      meaning: t("ähnlicher Inhalt", "similar content"),
      link: t("verlinkt", "linked"),
      backlink: t("verlinkt hierher", "links here"),
      "shared-links": t("gleiche Verweise", "shared links"),
      tags: t("gleiche Tags", "same tags"),
      title: t("ähnlicher Titel", "similar title"),
    })[r];
  const toggle = () => {
    const next = !collapsed;
    foldChoices.set(pageId, next);
    setToggled(next);
    // The kept copy of the database opens records the same way next time.
    const cache = appCache();
    const kept = cache.get<Record<string, unknown>>(pageKey(pageId));
    if (kept)
      cache.set(pageKey(pageId), { ...kept.value, recordRelatedCollapsed: next }, { version: kept.version, policy: kept.persist ? "persist" : "memory" });
    // Stored in the account; a failure (offline) keeps it for this tab.
    void api("/api/command", { action: "database.collapseRelated", pageId, collapsed: next }).catch(() => {});
  };
  const heading = t("Verwandte Seiten", "Related pages");
  if (fold)
    return (
      <section className={`related-pages foldable${collapsed ? " collapsed" : ""}`} aria-label={heading}>
        <h3>
          <button
            type="button"
            className="related-pages-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? t("Verwandte Seiten ausklappen", "Expand related pages") : t("Verwandte Seiten einklappen", "Collapse related pages")}
            onClick={toggle}
          >
            <CaretRight size={13} weight="bold" className="page-properties-caret" aria-hidden />
            <span className="related-pages-label">{heading}</span>{" "}
            <span className="related-pages-count">· {data.items.length}</span>
          </button>
          {!collapsed && data.semantic && (
            <small className="muted" title={t("Gefunden über die Suche nach Bedeutung", "Found through meaning search")}>
              <Sparkle size={12} aria-hidden /> {t("nach Bedeutung", "by meaning")}
            </small>
          )}
        </h3>
        <ul id={bodyId} hidden={collapsed}>
          {data.items.map((item) => (
            <li key={`${item.pageId}/${item.rowId || ""}`}>
              <button type="button" className="related-page" onClick={() => onOpen(item.pageId, item.rowId)}>
                <PageIcon name={shownPageIcon(item.icon, item.kind)} />
                <span className="related-title">{item.title || t("Ohne Titel", "Untitled")}</span>
                {item.pageTitle && <small>{item.pageTitle}</small>}
                <small className="muted">{item.reasons.slice(0, 2).map(reason).join(" · ")}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <section className="related-pages" aria-label={t("Verwandte Seiten", "Related pages")}>
      <h3>
        {t("Verwandte Seiten", "Related pages")}
        {data.semantic && (
          <small className="muted" title={t("Gefunden über die Suche nach Bedeutung", "Found through meaning search")}>
            {" "}
            <Sparkle size={12} aria-hidden /> {t("nach Bedeutung", "by meaning")}
          </small>
        )}
      </h3>
      <ul>
        {data.items.map((item) => (
          <li key={`${item.pageId}/${item.rowId || ""}`}>
            <button type="button" className="related-page" onClick={() => onOpen(item.pageId, item.rowId)}>
              <PageIcon name={shownPageIcon(item.icon, item.kind)} />
              <span className="related-title">{item.title || t("Ohne Titel", "Untitled")}</span>
              {item.pageTitle && <small>{item.pageTitle}</small>}
              <small className="muted">{item.reasons.slice(0, 2).map(reason).join(" · ")}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// While a title is typed: existing pages (or records of `databaseId`) with
// a similar title, debounced.
export function DuplicateHint({
  workspaceId,
  title,
  databaseId,
  excludePageId,
  excludeRowId,
  onOpen = go,
}: {
  workspaceId: string;
  title: string;
  databaseId?: string;
  excludePageId?: string;
  excludeRowId?: string;
  onOpen?: (pageId: string, rowId?: string) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<SimilarItem[]>([]);
  useEffect(() => {
    const text = title.trim();
    if (text.length < 4) return setItems([]);
    let live = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        workspace: workspaceId,
        title: text.slice(0, 300),
        ...(databaseId ? { database: databaseId } : {}),
        ...(excludePageId ? { exclude: excludePageId } : {}),
        ...(excludeRowId ? { excludeRow: excludeRowId } : {}),
      });
      fetch(`/api/related?${params}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && setItems(Array.isArray(d?.items) ? d.items : []))
        .catch(() => live && setItems([]));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, title, databaseId, excludePageId, excludeRowId]);
  if (!items.length) return null;
  return (
    <div className="duplicate-hint" role="status">
      <Warning size={14} aria-hidden /> {t("Ähnliche Einträge gibt es schon:", "Similar entries already exist:")}{" "}
      {items.map((item, i) => (
        <span key={`${item.pageId}/${item.rowId || ""}`}>
          {i > 0 && ", "}
          <button type="button" className="text-button" onClick={() => onOpen(item.pageId, item.rowId)}>
            {item.title}
          </button>
          {item.pageTitle && !databaseId && <small className="muted"> ({item.pageTitle})</small>}
        </span>
      ))}
    </div>
  );
}
