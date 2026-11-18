"use client";
// A space shown as a library (#329, #library/<space>[/<book>]): the books
// – the space's top-level pages – as cards, and a book's table of contents
// with its chapters (sub-pages) and their pages. Everything comes from the
// pages the person may see (the bootstrap's, lib/library.ts); the search
// is the workspace's, limited to the space. Loaded when a library opens.
import { useEffect, useId, useMemo, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, BookOpen, Books, CaretRight, GearSix, MagnifyingGlass, PencilSimple, Plus, UsersThree } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { PageIcon } from "./ui";
import { CoverFrame } from "./cover-frame";
import { SpaceIcon } from "./space-appearance";
import { relativeTime } from "./home/format";
import { shownPageIcon } from "@/lib/page-link-icons";
import { imageFileId } from "@/lib/page-appearance";
import { pageLocationHash } from "@/lib/page-location";
import { settingsHash } from "@/lib/settings-sections";
import { LIBRARY_HOME, continueReading, libraryBooks, libraryHash, type LibraryBook, type LibraryEntry } from "@/lib/library";
import type { Page, Space } from "@/lib/types";

type Hit = { id: string; rowId?: string; title: string; pageTitle?: string; icon: string; kind: string; snippet: string };
type T = ReturnType<typeof useT>;

const pageHref = (id: string) => pageLocationHash({ pageId: id });
const untitled = (t: T, title: string) => title || t("Ohne Titel", "Untitled");
const pagesLabel = (t: T, n: number) => (n === 1 ? t("1 Seite", "1 page") : t(`${n} Seiten`, `${n} pages`));

export default function LibraryView({
  space,
  pages,
  bookId,
  workspaceId,
  visits,
  clock,
  canEdit,
  onCreate,
  userId,
  manage = false,
  workspaceOwner = false,
  onManageShelf,
  onShareBook,
}: {
  space: Space;
  // The workspace's live pages the person may see (titles decrypted).
  pages: Page[];
  bookId: string | null;
  workspaceId: string;
  visits: { pageId: string; seenAt: number }[];
  clock: number | null;
  canEdit: boolean;
  // "Neues Buch" (parent null) and "Neues Kapitel" / a page in a chapter.
  onCreate: (parentId: string | null) => void;
  userId?: string;
  // May change who sees the shelf (space and workspace owners).
  manage?: boolean;
  workspaceOwner?: boolean;
  onManageShelf?: () => void;
  // "Wer sieht dieses Buch?": the book page's sharing.
  onShareBook?: (pageId: string) => void;
}) {
  const t = useT();
  const books = useMemo(() => libraryBooks(pages, space.id), [pages, space.id]);
  const book = bookId ? books.find((b) => b.page.id === bookId) : undefined;
  const [query, setQuery] = useState("");
  // A new book or chapter shows the search no more.
  useEffect(() => setQuery(""), [bookId]);
  return (
    <div className="utility-content library-view">
      {bookId && !book ? (
        <div className="empty-state">
          <Books size={38} />
          <h3>{t("Buch nicht gefunden", "Book not found")}</h3>
          <p>{t("Es wurde verschoben, gelöscht oder ist nicht mehr mit dir geteilt.", "It was moved, deleted or is no longer shared with you.")}</p>
          <a className="button" href={`#${libraryHash(space.id)}`}>
            {t("Zur Bibliothek", "To the library")}
          </a>
        </div>
      ) : (
        <>
          {book ? (
            <BookHeader
              book={book}
              space={space}
              pages={pages}
              visits={visits}
              clock={clock}
              onShare={onShareBook && (manage || (!!userId && book.page.created_by === userId)) ? () => onShareBook(book.page.id) : undefined}
            />
          ) : (
            <div className="utility-title library-title">
              <a className="text-button library-back" href={`#${LIBRARY_HOME}`}>
                <ArrowLeft size={14} aria-hidden /> {t("Alle Regale", "All shelves")}
              </a>
              <span className="library-title-icon" aria-hidden>
                <SpaceIcon icon={space.icon} color={space.icon_color} />
              </span>
              <h1>{space.name}</h1>
              <p>
                {books.length === 1 ? t("1 Buch", "1 book") : t(`${books.length} Bücher`, `${books.length} books`)}
                {" · "}
                {pagesLabel(t, books.reduce((n, b) => n + b.pages, 0))}
              </p>
              {manage && onManageShelf && <WhoCanSee space={space} workspaceOwner={workspaceOwner} onManage={onManageShelf} />}
            </div>
          )}
          <div className="library-toolbar">
            <LibrarySearch spaceName={space.name} query={query} onQuery={setQuery} />
            {canEdit && !book && (
              <button type="button" className="button primary compact" onClick={() => onCreate(null)}>
                <Plus size={15} aria-hidden /> {t("Neues Buch", "New book")}
              </button>
            )}
            {canEdit && book && (
              <button type="button" className="button compact" onClick={() => onCreate(book.page.id)}>
                <Plus size={15} aria-hidden /> {t("Neues Kapitel", "New chapter")}
              </button>
            )}
          </div>
          {query.trim() ? (
            <SearchResults workspaceId={workspaceId} spaceId={space.id} query={query} />
          ) : book ? (
            <Contents book={book} canEdit={canEdit} onCreate={onCreate} />
          ) : books.length ? (
            <ul className="library-books" aria-label={t("Bücher", "Books")}>
              {books.map((b) => (
                <li key={b.page.id}>
                  <BookCard book={b} spaceId={space.id} clock={clock} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <Books size={38} />
              <h3>{t("Noch keine Bücher", "No books yet")}</h3>
              <p>
                {t(
                  "Jede Seite oben im Bereich ist ein Buch, ihre Unterseiten sind die Kapitel.",
                  "Every page at the top of the space is a book, its sub-pages are the chapters.",
                )}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function BookCard({ book, spaceId, clock }: { book: LibraryBook<Page>; spaceId: string; clock: number | null }) {
  const t = useT();
  const locale = useLocale();
  const cover = book.page.cover || "";
  return (
    <a className="library-book" href={`#${libraryHash(spaceId, book.page.id)}`} data-prefetch-page={book.page.id}>
      {cover ? (
        <CoverFrame className="library-book-cover" cover={cover} image={!!imageFileId(cover)} />
      ) : (
        <span className="library-book-cover plain" aria-hidden />
      )}
      <span className="library-book-icon" aria-hidden>
        <PageIcon name={shownPageIcon(book.page.icon, book.page.kind)} size={26} />
      </span>
      <span className="library-book-title">{untitled(t, book.page.title)}</span>
      <span className="library-book-meta">
        <span>{pagesLabel(t, book.pages)}</span>
        {book.chapters.length > 0 && (
          <span>{book.chapters.length === 1 ? t("1 Kapitel", "1 chapter") : t(`${book.chapters.length} Kapitel`, `${book.chapters.length} chapters`)}</span>
        )}
        {book.updatedAt && <span>{t(`Bearbeitet ${relativeTime(book.updatedAt, clock, locale)}`, `Edited ${relativeTime(book.updatedAt, clock, locale)}`)}</span>}
      </span>
    </a>
  );
}

function BookHeader({
  book,
  space,
  pages,
  visits,
  clock,
  onShare,
}: {
  book: LibraryBook<Page>;
  space: Space;
  pages: Page[];
  visits: { pageId: string; seenAt: number }[];
  clock: number | null;
  onShare?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const resume = useMemo(() => continueReading(pages, space.id, book.page.id, visits), [pages, space.id, book.page.id, visits]);
  return (
    <div className="utility-title library-title library-book-header">
      <a className="text-button library-back" href={`#${libraryHash(space.id)}`}>
        <ArrowLeft size={14} aria-hidden /> {t(`Bibliothek ${space.name}`, `Library ${space.name}`)}
      </a>
      <span className="library-title-icon" aria-hidden>
        <PageIcon name={shownPageIcon(book.page.icon, book.page.kind)} size={34} />
      </span>
      <h1>{untitled(t, book.page.title)}</h1>
      <p>
        {pagesLabel(t, book.pages)}
        {book.updatedAt && ` · ${t(`Bearbeitet ${relativeTime(book.updatedAt, clock, locale)}`, `Edited ${relativeTime(book.updatedAt, clock, locale)}`)}`}
      </p>
      <div className="library-read">
        {resume && resume.id !== book.page.id ? (
          <>
            <a className="button primary compact" href={pageHref(resume.id)}>
              <BookOpen size={15} aria-hidden /> {t(`Weiterlesen: ${untitled(t, resume.title)}`, `Continue reading: ${untitled(t, resume.title)}`)}
            </a>
            <a className="button compact" href={pageHref(book.page.id)}>
              {t("Von vorn beginnen", "Start from the beginning")}
            </a>
          </>
        ) : (
          <a className="button primary compact" href={pageHref(book.page.id)}>
            <BookOpen size={15} aria-hidden /> {t("Lesen beginnen", "Start reading")}
          </a>
        )}
        {onShare && (
          <button type="button" className="button compact" onClick={onShare}>
            <UsersThree size={15} aria-hidden /> {t("Wer sieht dieses Buch?", "Who can see this book?")}
          </button>
        )}
      </div>
    </div>
  );
}

// The table of contents: chapters with their pages, each chapter folds.
function Contents({ book, canEdit, onCreate }: { book: LibraryBook<Page>; canEdit: boolean; onCreate: (parentId: string | null) => void }) {
  const t = useT();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const baseId = useId();
  if (!book.chapters.length)
    return (
      <div className="empty-state library-empty">
        <BookOpen size={34} />
        <h3>{t("Noch keine Kapitel", "No chapters yet")}</h3>
        <p>{t("Die Unterseiten des Buchs sind seine Kapitel.", "The book's sub-pages are its chapters.")}</p>
      </div>
    );
  return (
    <nav aria-label={t("Inhaltsverzeichnis", "Table of contents")}>
      <h2 className="library-contents-heading">{t("Inhalt", "Contents")}</h2>
      <ol className="library-contents">
        {book.chapters.map((chapter, i) => {
          const open = !closed.has(chapter.page.id);
          const listId = `${baseId}-${i}`;
          return (
            <li key={chapter.page.id} className="library-chapter">
              <div className="library-chapter-row">
                {chapter.pages.length > 0 ? (
                  <button
                    type="button"
                    className="icon-button library-fold"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={open ? t(`${untitled(t, chapter.page.title)} zuklappen`, `Collapse ${untitled(t, chapter.page.title)}`) : t(`${untitled(t, chapter.page.title)} aufklappen`, `Expand ${untitled(t, chapter.page.title)}`)}
                    onClick={() =>
                      setClosed((prev) => {
                        const next = new Set(prev);
                        if (open) next.add(chapter.page.id);
                        else next.delete(chapter.page.id);
                        return next;
                      })
                    }
                  >
                    <CaretRight size={12} className={open ? "open" : undefined} aria-hidden />
                  </button>
                ) : (
                  <span className="library-fold" aria-hidden />
                )}
                <span className="library-chapter-number" aria-hidden>
                  {i + 1}
                </span>
                <a className="library-chapter-link" href={pageHref(chapter.page.id)} data-prefetch-page={chapter.page.id}>
                  <PageIcon name={shownPageIcon(chapter.page.icon, chapter.page.kind)} size={16} />
                  <span>{untitled(t, chapter.page.title)}</span>
                </a>
                {chapter.below > 0 && <span className="library-count">{pagesLabel(t, chapter.below)}</span>}
                {canEdit && (
                  <button
                    type="button"
                    className="icon-button library-add"
                    title={t(`Seite in ${untitled(t, chapter.page.title)} hinzufügen`, `Add page in ${untitled(t, chapter.page.title)}`)}
                    aria-label={t(`Seite in ${untitled(t, chapter.page.title)} hinzufügen`, `Add page in ${untitled(t, chapter.page.title)}`)}
                    onClick={() => onCreate(chapter.page.id)}
                  >
                    <Plus size={14} />
                  </button>
                )}
              </div>
              {chapter.pages.length > 0 && open && (
                <ul id={listId} className="library-pages">
                  {chapter.pages.map((entry) => (
                    <ContentsPage key={entry.page.id} entry={entry} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ContentsPage({ entry }: { entry: LibraryEntry<Page> }) {
  const t = useT();
  return (
    <li>
      <a href={pageHref(entry.page.id)} data-prefetch-page={entry.page.id}>
        <PageIcon name={shownPageIcon(entry.page.icon, entry.page.kind)} size={15} />
        <span>{untitled(t, entry.page.title)}</span>
      </a>
      {entry.below > 0 && <span className="library-count">+{entry.below}</span>}
    </li>
  );
}

// The workspace's search (GET /api/search), only in this space.
function LibrarySearch({
  spaceName,
  query,
  onQuery,
}: {
  spaceName: string;
  query: string;
  onQuery: (query: string) => void;
}) {
  const t = useT();
  return (
    <label className="library-search">
      <MagnifyingGlass size={15} aria-hidden />
      <span className="sr-only">{t(`In ${spaceName} suchen`, `Search in ${spaceName}`)}</span>
      <input
        type="search"
        value={query}
        maxLength={200}
        placeholder={t("In der Bibliothek suchen …", "Search the library …")}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            onQuery("");
          }
        }}
      />
    </label>
  );
}

function SearchResults({ workspaceId, spaceId, query }: { workspaceId: string; spaceId: string; query: string }) {
  const t = useT();
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setHits(null);
    const timer = setTimeout(() => {
      fetch(`/api/search?${new URLSearchParams({ workspace: workspaceId, q: query.trim(), space: spaceId, days: "0" })}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then((list: Hit[]) => setHits(Array.isArray(list) ? list : []))
        .catch(() => {
          if (!controller.signal.aborted) setHits([]);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, spaceId, query]);
  return (
    <section className="library-results" aria-label={t("Suchergebnisse", "Search results")} aria-busy={hits === null}>
      <p className="sr-only" role="status">
        {hits === null ? "" : hits.length === 1 ? t("1 Treffer", "1 match") : t(`${hits.length} Treffer`, `${hits.length} matches`)}
      </p>
      {hits === null ? (
        <p className="muted">{t("Wird gesucht …", "Searching …")}</p>
      ) : !hits.length ? (
        <p className="muted">{t("Nichts gefunden.", "Nothing found.")}</p>
      ) : (
        <ul>
          {hits.map((hit) => (
            <li key={`${hit.id}:${hit.rowId || ""}:${hit.kind}`}>
              <a href={pageLocationHash({ pageId: hit.id, rowId: hit.rowId })}>
                <PageIcon name={shownPageIcon(hit.icon, hit.kind === "row" || hit.kind === "comment" || hit.kind === "file" ? "document" : hit.kind)} size={16} />
                <span className="library-result-title">{untitled(t, hit.title)}</span>
                {hit.pageTitle && hit.pageTitle !== hit.title && <span className="library-result-page">{hit.pageTitle}</span>}
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
    </section>
  );
}

// The server marks hits with \u0002…\u0003; rendered as text only.
export function Snippet({ text }: { text: string }) {
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

// "Wer sieht dieses Regal?": who sees the space now, and the places that
// change it – the space's visibility, the access of groups (with their SSO,
// SCIM or LDAP mappings) for workspace owners. Books are shared one by one.
export function WhoCanSee({ space, workspaceOwner, onManage }: { space: Space; workspaceOwner: boolean; onManage: () => void }) {
  const t = useT();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="text-button library-who">
        <UsersThree size={15} aria-hidden /> {t("Wer sieht dieses Regal?", "Who can see this shelf?")}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown library-who-menu" align="end" sideOffset={4} collisionPadding={12}>
          <p className="library-who-note">
            {space.visibility === "team"
              ? t("Alle Mitglieder des Arbeitsbereichs sehen dieses Regal.", "Every member of the workspace sees this shelf.")
              : t("Nur Personen und Gruppen mit Zugriff auf den Bereich sehen dieses Regal.", "Only people and groups with access to the space see this shelf.")}{" "}
            {t("Einzelne Bücher teilst du über „Teilen“ der Seite.", "Single books are shared with “Share” on their page.")}
          </p>
          <Dropdown.Item className="dropdown-item" onSelect={onManage}>
            <PencilSimple /> {t("Sichtbarkeit des Bereichs …", "Visibility of the space …")}
          </Dropdown.Item>
          {workspaceOwner && (
            <Dropdown.Item className="dropdown-item" onSelect={() => (location.hash = settingsHash({ area: "settings", section: "groups", anchor: "access" }))}>
              <GearSix /> {t("Zugriff für Gruppen …", "Access for groups …")}
            </Dropdown.Item>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
