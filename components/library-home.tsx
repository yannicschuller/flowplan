"use client";
// The workspace's library (#329 follow-up, #library): every space shown as
// a library is a shelf – the person's own private ones and the shared ones
// side by side – each with its books as tiles, "Weiterlesen" for the books
// read last, and a search over all shelves with its hits grouped by level
// (GET /api/library/search). Shelves and books come from the pages the
// person may see (the bootstrap's, lib/library.ts); no permissions of its
// own: "Wer sieht dieses Regal?" leads to the space's access, a book's to
// its page sharing. Loaded when the library opens.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, Books, CaretRight, MagnifyingGlass } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { PageIcon } from "./ui";
import { SpaceIcon } from "./space-appearance";
import { relativeTime } from "./home/format";
import { BookCard, Snippet, WhoCanSee } from "./library-view";
import { shownPageIcon } from "@/lib/page-link-icons";
import { pageLocationHash } from "@/lib/page-location";
import { libraryHash, libraryShelves, readingNow, type LibraryShelf } from "@/lib/library";
import type { Page, Space } from "@/lib/types";

type T = ReturnType<typeof useT>;
type Hit = { id: string; rowId?: string; title: string; icon: string; kind: string; spaceId: string; level?: number; path: { id: string; title: string }[]; snippet?: string };
type Found = { query: string; shelves: Hit[]; books: Hit[]; chapters: Hit[]; pages: Hit[]; total: Record<"shelves" | "books" | "chapters" | "pages", number> };
type Reading = { spaceId: string; book: { id: string; title: string; icon: string; kind: string }; page: { id: string; title: string; icon: string; kind: string }; position: number; total: number; seenAt: number };

// Books shown per shelf on the start; the shelf itself lists them all.
const SHELF_BOOKS = 12;
const untitled = (t: T, title: string) => title || t("Ohne Titel", "Untitled");
const booksLabel = (t: T, n: number) => (n === 1 ? t("1 Buch", "1 book") : t(`${n} Bücher`, `${n} books`));
const pagesLabel = (t: T, n: number) => (n === 1 ? t("1 Seite", "1 page") : t(`${n} Seiten`, `${n} pages`));
const shelvesLabel = (t: T, n: number) => (n === 1 ? t("1 Regal", "1 shelf") : t(`${n} Regale`, `${n} shelves`));

export default function LibraryHome({
  spaces,
  pages,
  userId,
  workspaceId,
  visits,
  clock,
  manageable,
  workspaceOwner,
  onManageShelf,
}: {
  // The spaces the person sees, in the sidebar's order.
  spaces: Space[];
  // The workspace's live pages the person may see (titles decrypted).
  pages: Page[];
  userId: string;
  workspaceId: string;
  visits: { pageId: string; seenAt: number }[];
  clock: number | null;
  // Spaces whose access the person may change (space and workspace owners).
  manageable: ReadonlySet<string>;
  workspaceOwner: boolean;
  onManageShelf: (space: Space) => void;
}) {
  const t = useT();
  const { personal, shared } = useMemo(() => libraryShelves(spaces, pages, userId), [spaces, pages, userId]);
  const shelfIds = useMemo(() => [...personal, ...shared].map((s) => s.space.id), [personal, shared]);
  const [query, setQuery] = useState("");
  const books = [...personal, ...shared].reduce((n, s) => n + s.books.length, 0);
  const total = [...personal, ...shared].reduce((n, s) => n + s.pages, 0);
  const shelves = personal.length + shared.length;
  return (
    <div className="utility-content library-view library-home">
      <div className="utility-title library-title">
        <span className="library-title-icon" aria-hidden>
          <Books size={32} />
        </span>
        <h1>{t("Bibliothek", "Library")}</h1>
        <p>
          {shelvesLabel(t, shelves)}
          {" · "}
          {booksLabel(t, books)}
          {" · "}
          {pagesLabel(t, total)}
        </p>
      </div>
      <LibrarySearchBox workspaceId={workspaceId} query={query} onQuery={setQuery} />
      {query.trim() ? null : shelves ? (
        <>
          <ContinueReading pages={pages} shelfIds={shelfIds} visits={visits} workspaceId={workspaceId} clock={clock} />
          <div className={`library-groups${personal.length && shared.length ? " two" : ""}`}>
            {personal.length > 0 && (
              <ShelfGroup
                title={t("Meine Regale", "My shelves")}
                hint={t("Deine privaten Bereiche, die als Bibliothek angezeigt werden.", "Your private spaces shown as a library.")}
                shelves={personal}
                clock={clock}
                manageable={manageable}
                workspaceOwner={workspaceOwner}
                onManageShelf={onManageShelf}
              />
            )}
            {shared.length > 0 && (
              <ShelfGroup
                title={t("Geteilte Regale", "Shared shelves")}
                hint={t("Bereiche des Teams und mit dir geteilte.", "Team spaces and ones shared with you.")}
                shelves={shared}
                clock={clock}
                manageable={manageable}
                workspaceOwner={workspaceOwner}
                onManageShelf={onManageShelf}
              />
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <Books size={38} />
          <h3>{t("Noch keine Regale", "No shelves yet")}</h3>
          <p>
            {t(
              "Stelle einen Bereich unter „Bereich bearbeiten …“ auf „Als Bibliothek anzeigen“: Er wird hier ein Regal, seine Seiten oben im Bereich sind die Bücher.",
              "Switch a space to “Show as library” in “Edit space …”: it becomes a shelf here, the pages at the top of the space are its books.",
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function ShelfGroup({
  title,
  hint,
  shelves,
  clock,
  manageable,
  workspaceOwner,
  onManageShelf,
}: {
  title: string;
  hint: string;
  shelves: LibraryShelf<Space, Page>[];
  clock: number | null;
  manageable: ReadonlySet<string>;
  workspaceOwner: boolean;
  onManageShelf: (space: Space) => void;
}) {
  const id = useId();
  return (
    <section className="library-group" aria-labelledby={id}>
      <h2 id={id} className="library-group-title">
        {title}
      </h2>
      <p className="library-group-hint">{hint}</p>
      {shelves.map((shelf) => (
        <Shelf key={shelf.space.id} shelf={shelf} clock={clock} manage={manageable.has(shelf.space.id)} workspaceOwner={workspaceOwner} onManage={() => onManageShelf(shelf.space)} />
      ))}
    </section>
  );
}

function Shelf({ shelf, clock, manage, workspaceOwner, onManage }: { shelf: LibraryShelf<Space, Page>; clock: number | null; manage: boolean; workspaceOwner: boolean; onManage: () => void }) {
  const t = useT();
  const id = useId();
  const { space, books } = shelf;
  const shown = books.slice(0, SHELF_BOOKS);
  return (
    <section className="library-shelf" aria-labelledby={id}>
      <div className="library-shelf-head">
        <a className="library-shelf-name" href={`#${libraryHash(space.id)}`}>
          <SpaceIcon icon={space.icon} color={space.icon_color} />
          <h3 id={id}>{space.name}</h3>
        </a>
        <span className="library-count">
          {booksLabel(t, books.length)} · {pagesLabel(t, shelf.pages)}
        </span>
        {manage && <WhoCanSee space={space} workspaceOwner={workspaceOwner} onManage={onManage} />}
      </div>
      {shown.length ? (
        <ul className="library-shelf-books" aria-label={t(`Bücher in ${space.name}`, `Books in ${space.name}`)}>
          {shown.map((b) => (
            <li key={b.page.id}>
              <BookCard book={b} spaceId={space.id} clock={clock} />
            </li>
          ))}
          {books.length > shown.length && (
            <li>
              <a className="library-book library-more" href={`#${libraryHash(space.id)}`}>
                <Books size={22} aria-hidden />
                <span>{t(`Alle ${books.length} Bücher`, `All ${books.length} books`)}</span>
              </a>
            </li>
          )}
        </ul>
      ) : (
        <p className="library-group-hint">{t("Noch keine Bücher in diesem Regal.", "No books on this shelf yet.")}</p>
      )}
    </section>
  );
}

// "Weiterlesen": per book the page visited last – at once from the
// bootstrap's recent visits, then from the server's longer list.
function ContinueReading({ pages, shelfIds, visits, workspaceId, clock }: { pages: Page[]; shelfIds: string[]; visits: { pageId: string; seenAt: number }[]; workspaceId: string; clock: number | null }) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const local = useMemo<Reading[]>(
    () => readingNow(pages, shelfIds, visits).map((r) => ({ spaceId: r.spaceId, book: r.book, page: r.page, position: r.position, total: r.total, seenAt: r.seenAt })),
    [pages, shelfIds, visits],
  );
  const [remote, setRemote] = useState<Reading[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/library?${new URLSearchParams({ workspace: workspaceId })}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { continueReading?: (Omit<Reading, "seenAt"> & { visitedAt: string })[] } | null) => {
        if (Array.isArray(data?.continueReading)) setRemote(data.continueReading.map((r) => ({ ...r, seenAt: Date.parse(r.visitedAt) })));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [workspaceId]);
  // Titles from the pages here (renamed since, decrypted); gone ones drop.
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const list = (remote ?? local).filter((r) => byId.has(r.page.id) && byId.has(r.book.id));
  if (!list.length) return null;
  return (
    <section className="library-reading" aria-labelledby={id}>
      <h2 id={id} className="library-group-title">
        {t("Weiterlesen", "Continue reading")}
      </h2>
      <ul>
        {list.map((r) => {
          const book = byId.get(r.book.id)!,
            page = byId.get(r.page.id)!;
          return (
            <li key={r.book.id}>
              <a href={pageLocationHash({ pageId: page.id })} data-prefetch-page={page.id}>
                <span className="library-reading-icon" aria-hidden>
                  <PageIcon name={shownPageIcon(book.icon, book.kind)} size={20} />
                </span>
                <span className="library-reading-text">
                  <span className="library-reading-book">{untitled(t, book.title)}</span>
                  <span className="library-reading-page">
                    {page.id === book.id ? t("Anfang", "Beginning") : untitled(t, page.title)}
                  </span>
                  <span className="library-reading-meta">
                    {t(`Seite ${r.position} von ${r.total}`, `Page ${r.position} of ${r.total}`)}
                    {Number.isFinite(r.seenAt) && ` · ${relativeTime(new Date(r.seenAt).toISOString(), clock, locale)}`}
                  </span>
                </span>
                <BookOpen size={16} aria-hidden className="library-reading-go" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- Search over all shelves ----

const GROUPS = ["shelves", "books", "chapters", "pages"] as const;
type Group = (typeof GROUPS)[number];
const groupTitle = (t: T, group: Group) =>
  group === "shelves" ? t("Regale", "Shelves") : group === "books" ? t("Bücher", "Books") : group === "chapters" ? t("Kapitel", "Chapters") : t("Seiten und Inhalte", "Pages and content");
// Where a hit leads: a shelf to its books, a book to its contents, a
// chapter or page to reading it (a record opens in its database).
const hitHref = (group: Group, hit: Hit) =>
  group === "shelves" ? `#${libraryHash(hit.id)}` : group === "books" ? `#${libraryHash(hit.spaceId, hit.id)}` : pageLocationHash({ pageId: hit.id, rowId: hit.rowId });
const NAV = "[data-library-nav]";

function LibrarySearchBox({ workspaceId, query, onQuery }: { workspaceId: string; query: string; onQuery: (query: string) => void }) {
  const t = useT();
  const results = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  // Arrow keys walk through the group headings and hits, Escape goes back
  // to the field (and a second Escape clears it).
  const move = (from: Element | null, step: 1 | -1 | "first" | "last") => {
    const items = [...(results.current?.querySelectorAll<HTMLElement>(NAV) ?? [])];
    if (!items.length) return;
    const at = from ? items.indexOf(from as HTMLElement) : -1;
    const next = step === "first" ? 0 : step === "last" ? items.length - 1 : at + step;
    if (next < 0) input.current?.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  };
  const onResultsKey = (e: KeyboardEvent) => {
    const target = (e.target as HTMLElement).closest(NAV);
    if (!target) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(target, e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : "last");
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.current?.focus();
    }
  };
  return (
    <>
      <div className="library-toolbar">
        <label className="library-search">
          <MagnifyingGlass size={15} aria-hidden />
          <span className="sr-only">{t("In allen Regalen suchen", "Search all shelves")}</span>
          <input
            ref={input}
            type="search"
            value={query}
            maxLength={200}
            aria-controls={query.trim() ? resultsId : undefined}
            aria-describedby={query.trim() ? undefined : `${resultsId}-hint`}
            placeholder={t("In allen Regalen suchen …", "Search all shelves …")}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
              } else if (e.key === "ArrowDown" && query.trim()) {
                e.preventDefault();
                move(null, "first");
              }
            }}
          />
        </label>
        <span id={`${resultsId}-hint`} className="sr-only">
          {t("Mit den Pfeiltasten durch die Treffer.", "Use the arrow keys to move through the results.")}
        </span>
      </div>
      {query.trim() && (
        <div id={resultsId} ref={results} onKeyDown={onResultsKey}>
          <GroupedResults workspaceId={workspaceId} query={query.trim()} />
        </div>
      )}
    </>
  );
}

function GroupedResults({ workspaceId, query }: { workspaceId: string; query: string }) {
  const t = useT();
  const [found, setFound] = useState<Found | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<Group>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    setFound(null);
    const timer = setTimeout(() => {
      fetch(`/api/library/search?${new URLSearchParams({ workspace: workspaceId, q: query, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: Found | null) => setFound(data && Array.isArray(data.books) ? data : { query, shelves: [], books: [], chapters: [], pages: [], total: { shelves: 0, books: 0, chapters: 0, pages: 0 } }))
        .catch(() => {
          if (!controller.signal.aborted) setFound({ query, shelves: [], books: [], chapters: [], pages: [], total: { shelves: 0, books: 0, chapters: 0, pages: 0 } });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, query]);
  const all = found ? GROUPS.reduce((n, g) => n + found.total[g], 0) : 0;
  return (
    <section className="library-results library-grouped" aria-label={t("Suchergebnisse", "Search results")} aria-busy={found === null}>
      <p className="sr-only" role="status">
        {found === null ? "" : all === 1 ? t("1 Treffer", "1 match") : t(`${all} Treffer`, `${all} matches`)}
      </p>
      {found === null ? (
        <p className="muted">{t("Wird gesucht …", "Searching …")}</p>
      ) : !all ? (
        <p className="muted">{t("Nichts gefunden.", "Nothing found.")}</p>
      ) : (
        GROUPS.filter((g) => found[g].length).map((group) => {
          const open = !closed.has(group);
          const listId = `library-group-${group}`;
          return (
            <div key={group} className="library-result-group">
              <h2 className="library-result-heading">
                <button
                  type="button"
                  data-library-nav=""
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() =>
                    setClosed((prev) => {
                      const next = new Set(prev);
                      if (open) next.add(group);
                      else next.delete(group);
                      return next;
                    })
                  }
                >
                  <CaretRight size={12} className={open ? "open" : undefined} aria-hidden />
                  <span>{groupTitle(t, group)}</span>
                  <span className="library-count">{found.total[group] > found[group].length ? `${found[group].length}+` : found[group].length}</span>
                </button>
              </h2>
              {open && (
                <ul id={listId}>
                  {found[group].map((hit) => (
                    <li key={`${hit.id}:${hit.rowId || ""}:${hit.kind}:${hit.snippet ? 1 : 0}`}>
                      <a href={hitHref(group, hit)} data-library-nav="" data-prefetch-page={group === "shelves" ? undefined : hit.id}>
                        {group === "shelves" ? (
                          <Books size={16} aria-hidden />
                        ) : (
                          <PageIcon name={shownPageIcon(hit.icon, hit.kind === "row" || hit.kind === "comment" || hit.kind === "file" ? "document" : hit.kind)} size={16} />
                        )}
                        <span className="library-result-title">{untitled(t, hit.title)}</span>
                        {hit.path.length > 0 && <span className="library-result-page">{hit.path.map((p) => untitled(t, p.title)).join(" › ")}</span>}
                      </a>
                      {hit.snippet && (
                        <p className="library-result-snippet">
                          <Snippet text={hit.snippet} />
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
