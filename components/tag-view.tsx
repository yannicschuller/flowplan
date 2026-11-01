"use client";
// "Tags" (#tags, issue #70): the workspace's tags with how many pages carry
// each, and – for a tag (#tags/<id>, a click on a tag chip) – the pages with
// it, newest change first, narrowed by further tags or a few words. Only
// pages one may read appear (the bootstrap's page list and tag links).
import { useEffect, useMemo, useState } from "react";
import { GearSix, MagnifyingGlass, Tag as TagIcon } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { PageIcon } from "./ui";
import { TagChip } from "./page-properties";
import { foldName, type PageTag } from "@/lib/page-properties";
import type { Bootstrap, Page } from "@/lib/types";

const tagOfHash = () => /^#tags\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null;

export function TagView({ boot, pages, onOpen }: { boot: Bootstrap; pages: Page[]; onOpen: (pageId: string) => void; onError?: (e: unknown) => void }) {
  const t = useT();
  const taxonomy = boot.taxonomy;
  const [selected, setSelected] = useState<string | null>(null),
    [also, setAlso] = useState<string[]>([]),
    [filter, setFilter] = useState("");
  useEffect(() => {
    const follow = () => {
      setSelected(tagOfHash());
      setAlso([]);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const links = useMemo(() => taxonomy?.links ?? {}, [taxonomy]);
  const counts = useMemo(() => {
    const live = new Set(pages.map((p) => p.id));
    const map = new Map<string, number>();
    for (const [pageId, ids] of Object.entries(links)) if (live.has(pageId)) for (const id of ids) map.set(id, (map.get(id) || 0) + 1);
    return map;
  }, [links, pages]);
  const tags = taxonomy?.tags ?? [];
  const tag = tags.find((x) => x.id === selected);
  const spaceName = (id: string) => boot.spaces.find((s) => s.id === id)?.name ?? "";
  const tagged = useMemo(() => {
    if (!tag) return [];
    const wanted = [tag.id, ...also];
    const words = foldName(filter);
    return pages
      .filter((p) => wanted.every((id) => links[p.id]?.includes(id)))
      .filter((p) => !words || foldName(p.title).includes(words))
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }, [tag, also, filter, pages, links]);
  // Further tags that occur on these pages narrow the list.
  const related = useMemo(() => {
    if (!tag) return [];
    const ids = new Set(tagged.flatMap((p) => links[p.id] || []));
    return tags.filter((x) => ids.has(x.id) && x.id !== tag.id && !also.includes(x.id));
  }, [tag, tagged, tags, links, also]);
  const open = (id: string | null) => {
    location.hash = id ? `tags/${id}` : "tags";
  };
  return (
    <div className="utility-content tag-view">
      <div className="utility-title">
        <TagIcon size={30} />
        <h1>{tag ? `#${tag.name}` : t("Tags", "Tags")}</h1>
        <p>
          {tag
            ? tagged.length === 1
              ? t("1 Seite mit diesem Tag.", "1 page with this tag.")
              : t(`${tagged.length} Seiten mit diesem Tag.`, `${tagged.length} pages with this tag.`)
            : t("Seiten nach Tags. In der Suche findet #Tag dasselbe.", "Pages by tag. In the search, #tag finds the same.")}
        </p>
      </div>
      <div className="tag-view-cloud" role="list" aria-label={t("Alle Tags", "All tags")}>
        {tags.map((x) => (
          <span role="listitem" key={x.id} className={x.id === selected ? "current" : ""}>
            <button
              type="button"
              className={`page-tag page-tag-${x.color} tag-view-chip`}
              aria-current={x.id === selected ? "page" : undefined}
              onClick={() => open(x.id === selected ? null : x.id)}
            >
              <span className="page-tag-name">{x.name}</span>
              <span className="tag-view-count">{counts.get(x.id) || 0}</span>
            </button>
          </span>
        ))}
        {taxonomy?.manage && (
          <a className="text-button tag-view-manage" href="#settings/tags">
            <GearSix size={14} aria-hidden /> {t("Tags verwalten", "Manage tags")}
          </a>
        )}
      </div>
      {!tags.length && (
        <div className="empty-state">
          <TagIcon size={38} />
          <h3>{t("Noch keine Tags", "No tags yet")}</h3>
          <p>{t("Unter dem Titel einer Seite fügst du mit „+ Tag“ einen hinzu.", "Add one under a page's title with “+ Tag”.")}</p>
        </div>
      )}
      {tag && (
        <>
          <div className="tag-view-filters">
            {also.map((id) => {
              const x = tags.find((y) => y.id === id) as PageTag;
              return <TagChip key={id} tag={x} onRemove={() => setAlso((list) => list.filter((y) => y !== id))} />;
            })}
            <label className="tag-view-search">
              <MagnifyingGlass size={15} aria-hidden />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Seiten filtern", "Filter pages")} aria-label={t("Seiten filtern", "Filter pages")} />
            </label>
            {related.length > 0 && (
              <span className="tag-view-related">
                <span className="muted">{t("Und:", "And:")}</span>
                {related.slice(0, 12).map((x) => (
                  <button key={x.id} type="button" className={`page-tag page-tag-${x.color}`} onClick={() => setAlso((list) => [...list, x.id])} aria-label={t(`Auch #${x.name}`, `Also #${x.name}`)}>
                    <span className="page-tag-name">+ {x.name}</span>
                  </button>
                ))}
              </span>
            )}
          </div>
          <ul className="tag-view-pages" aria-label={t("Seiten", "Pages")}>
            {tagged.map((p) => (
              <li key={p.id}>
                <button type="button" className="utility-row tag-view-page" onClick={() => onOpen(p.id)}>
                  <PageIcon name={p.icon} />
                  <strong>
                    {p.title || t("Ohne Titel", "Untitled")}
                    <small>{spaceName(p.space_id)}</small>
                  </strong>
                  <span className="tag-view-page-tags">
                    {(links[p.id] || [])
                      .filter((id) => id !== tag.id)
                      .map((id) => tags.find((x) => x.id === id))
                      .filter((x): x is PageTag => !!x)
                      .slice(0, 4)
                      .map((x) => (
                        <TagChip key={x.id} tag={x} />
                      ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!tagged.length && <p className="muted">{t("Keine Seiten gefunden.", "No pages found.")}</p>}
        </>
      )}
    </div>
  );
}
