"use client";
// "Verwandte Seiten" beside a page or record (GET /api/related) and the
// hint "Ähnliche Einträge gibt es schon" while naming a new page or record
// (GET /api/related?title=…). Both only show what the person may read
// (lib/related-pages.ts).
import { useEffect, useState } from "react";
import { Sparkle, Warning } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { PageIcon } from "./ui";
import { pageLocationHash } from "@/lib/page-location";
import type { RelatedItem, RelatedReason, SimilarItem } from "@/lib/related-pages";

const go = (pageId: string, rowId?: string) => {
  location.hash = pageLocationHash({ pageId, rowId });
};

export function RelatedPages({ pageId, rowId, onOpen = go }: { pageId: string; rowId?: string; onOpen?: (pageId: string, rowId?: string) => void }) {
  const t = useT();
  const [data, setData] = useState<{ items: RelatedItem[]; semantic: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    const params = new URLSearchParams({ page: pageId, ...(rowId ? { row: rowId } : {}) });
    fetch(`/api/related?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
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
              <PageIcon name={item.icon || "file"} />
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
