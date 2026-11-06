"use client";
// "Tags" (#tags, issue #70): the workspace's tags with how many pages carry
// each, and – for a tag (#tags/<id>, a click on a tag chip) – the pages with
// it, newest change first, narrowed by further tags or a few words. Only
// pages one may read appear (the bootstrap's page list and tag links).
// Records of databases whose multi-select has the tags as options (#79)
// come from GET /api/tags (the server applies the record permissions).
import { useEffect, useMemo, useState } from "react";
import { GearSix, MagnifyingGlass, Rows, Tag as TagIcon } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api, PageIcon } from "./ui";
import { pageLocationHash } from "@/lib/page-location";
import { TagChip } from "./page-properties";
import { ScopeBadge } from "./meta-scope";
import { foldName, type PageTag } from "@/lib/page-properties";
import type { Bootstrap, Page } from "@/lib/types";

const tagOfHash = () => /^#tags\/([0-9a-f-]{36})$/.exec(location.hash)?.[1] ?? null;

type TaggedRecord = { page_id: string; row_id: string; title: string; icon: string; database: string; space_id: string; updated_at: string; tags: string[] };
type Listing = { tags: { id: string; records?: number }[]; records?: TaggedRecord[] };

export function TagView({ boot, pages, onOpen }: { boot: Bootstrap; pages: Page[]; onOpen: (pageId: string) => void; onError?: (e: unknown) => void }) {
  const t = useT();
  const taxonomy = boot.taxonomy;
  const [selected, setSelected] = useState<string | null>(null),
    [also, setAlso] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    // A tag is one id (#136); on request also the same-named tags of the
    // other spaces.
    [sameName, setSameName] = useState(false);
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
  // Records with tags: counts for the cloud, the records of the chosen tag.
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    let live = true;
    const path = selected ? `/api/tags/${selected}` : "/api/tags";
    api<Listing>(`${path}?workspace=${boot.workspace.id}${selected && sameName ? "&sameName=1" : ""}`)
      .then((result) => live && setListing(result))
      .catch(() => live && setListing(null));
    return () => {
      live = false;
    };
  }, [selected, boot.workspace.id, taxonomy, sameName]);
  const recordCounts = useMemo(() => new Map((listing?.tags ?? []).map((x) => [x.id, x.records ?? 0])), [listing]);
  const counts = useMemo(() => {
    const live = new Set(pages.map((p) => p.id));
    const map = new Map<string, number>();
    for (const [pageId, ids] of Object.entries(links)) if (live.has(pageId)) for (const id of ids) map.set(id, (map.get(id) || 0) + 1);
    return map;
  }, [links, pages]);
  const tags = taxonomy?.tags ?? [];
  const tag = tags.find((x) => x.id === selected);
  const namesakes = tag ? tags.filter((x) => x.id !== tag.id && foldName(x.name) === foldName(tag.name)) : [];
  const tagIds = useMemo(
    () => (tag ? [tag.id, ...(sameName ? tags.filter((x) => x.id !== tag.id && foldName(x.name) === foldName(tag.name)).map((x) => x.id) : [])] : []),
    [tag, tags, sameName],
  );
  const spaceName = (id: string) => boot.spaces.find((s) => s.id === id)?.name ?? "";
  const tagged = useMemo(() => {
    if (!tag) return [];
    const words = foldName(filter);
    return pages
      .filter((p) => tagIds.some((id) => links[p.id]?.includes(id)) && also.every((id) => links[p.id]?.includes(id)))
      .filter((p) => !words || foldName(p.title).includes(words))
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }, [tag, tagIds, also, filter, pages, links]);
  const records = useMemo(() => {
    if (!tag || !listing?.records) return [];
    const words = foldName(filter);
    return listing.records
      .filter((r) => also.every((id) => r.tags.includes(id)))
      .filter((r) => !words || foldName(`${r.title} ${r.database}`).includes(words));
  }, [tag, listing, also, filter]);
  // Further tags that occur on these pages and records narrow the list.
  const related = useMemo(() => {
    if (!tag) return [];
    const ids = new Set([...tagged.flatMap((p) => links[p.id] || []), ...records.flatMap((r) => r.tags)]);
    return tags.filter((x) => ids.has(x.id) && x.id !== tag.id && !also.includes(x.id));
  }, [tag, tagged, records, tags, links, also]);
  const open = (id: string | null) => {
    location.hash = id ? `tags/${id}` : "tags";
  };
  return (
    <div className="utility-content tag-view">
      <div className="utility-title">
        <TagIcon size={30} />
        <h1>
          {tag ? `#${tag.name}` : t("Tags", "Tags")}
          {tag && <ScopeBadge spaceId={tag.spaceId} spaces={boot.spaces} />}
        </h1>
        <p>
          {tag
            ? (tagged.length === 1
                ? t("1 Seite mit diesem Tag.", "1 page with this tag.")
                : tagged.length || !records.length
                  ? t(`${tagged.length} Seiten mit diesem Tag.`, `${tagged.length} pages with this tag.`)
                  : "") +
              (records.length && tagged.length
                ? " " +
                  (records.length === 1
                    ? t("1 Eintrag aus Datenbanken.", "1 record from databases.")
                    : t(`${records.length} Einträge aus Datenbanken.`, `${records.length} records from databases.`))
                : records.length
                  ? records.length === 1
                    ? t("1 Eintrag mit diesem Tag.", "1 record with this tag.")
                    : t(`${records.length} Einträge mit diesem Tag.`, `${records.length} records with this tag.`)
                  : "")
            : t("Seiten und Einträge nach Tags. In der Suche findet #Tag dasselbe.", "Pages and records by tag. In the search, #tag finds the same.")}
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
              title={x.spaceId ? t(`Nur im Bereich „${spaceName(x.spaceId)}“`, `Only in the space “${spaceName(x.spaceId)}”`) : undefined}
            >
              <span className="page-tag-name">{x.name}</span>
              {x.spaceId && <span className="tag-view-space">{spaceName(x.spaceId)}</span>}
              <span className="tag-view-count">{(counts.get(x.id) || 0) + (recordCounts.get(x.id) || 0)}</span>
            </button>
          </span>
        ))}
        {(taxonomy?.manage || !!taxonomy?.manageSpaces?.length) && (
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
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Filtern", "Filter")} aria-label={t("Seiten und Einträge filtern", "Filter pages and records")} />
            </label>
            {namesakes.length > 0 && (
              <label className="checkbox-label tag-view-same-name">
                <input type="checkbox" checked={sameName} onChange={(e) => setSameName(e.target.checked)} />
                {namesakes.length === 1
                  ? t("Auch den gleichnamigen Tag eines anderen Bereichs", "Also the tag of the same name in another space")
                  : t(`Auch ${namesakes.length} gleichnamige Tags anderer Bereiche`, `Also ${namesakes.length} tags of the same name in other spaces`)}
              </label>
            )}
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
          {records.length > 0 && (
            <>
              <h2 className="tag-view-heading">{t("Einträge", "Records")}</h2>
              <ul className="tag-view-pages tag-view-records" aria-label={t("Einträge", "Records")}>
                {records.map((r) => (
                  <li key={r.row_id}>
                    <a className="utility-row tag-view-page" href={pageLocationHash({ pageId: r.page_id, rowId: r.row_id })}>
                      {r.icon ? <PageIcon name={r.icon} /> : <Rows size={18} aria-hidden />}
                      <strong>
                        {r.title || t("Ohne Titel", "Untitled")}
                        <small>
                          {r.database}
                          {spaceName(r.space_id) ? ` · ${spaceName(r.space_id)}` : ""}
                        </small>
                      </strong>
                      <span className="tag-view-page-tags">
                        {r.tags
                          .filter((id) => id !== tag.id)
                          .map((id) => tags.find((x) => x.id === id))
                          .filter((x): x is PageTag => !!x)
                          .slice(0, 4)
                          .map((x) => (
                            <TagChip key={x.id} tag={x} />
                          ))}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!tagged.length && !records.length && <p className="muted">{t("Keine Seiten oder Einträge gefunden.", "No pages or records found.")}</p>}
        </>
      )}
    </div>
  );
}
