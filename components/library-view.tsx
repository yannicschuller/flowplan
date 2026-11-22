"use client";
// A space as a library (#329, #library/<space>[/<book>[/<chapter>]]): the
// books – the space's top-level pages – as cards; a book's overview with
// its own text, its chapters (sub-pages) and their pages; a chapter's
// overview with its text and its pages. Books and chapters are directories
// ("books are like shelves"), the editor comes with the pages
// (lib/library.ts opensAsOverview). Everything comes from the pages the
// person may see (the bootstrap's); the search is the workspace's, limited
// to the space. Loaded when a library opens.
import { useEffect, useId, useMemo, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, BookOpen, Books, CaretRight, GearSix, MagnifyingGlass, PencilSimple, Plus, UsersThree } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { PageIcon } from "./ui";
import { CoverFrame } from "./cover-frame";
import { SpaceIcon } from "./space-appearance";
import { ReadOnlyDocument } from "./read-only-document";
import { LibraryCreateDialog, type LibraryCreate } from "./library-create-dialog";
import { relativeTime } from "./home/format";
import { shownPageIcon } from "@/lib/page-link-icons";
import { imageFileId } from "@/lib/page-appearance";
import { pageLocationHash } from "@/lib/page-location";
import { settingsHash } from "@/lib/settings-sections";
import {
  LIBRARY_HOME,
  continueReading,
  firstPage,
  libraryBooks,
  libraryHash,
  opensAsOverview,
  type LibraryBook,
  type LibraryChapter,
  type LibraryEntry,
} from "@/lib/library";
import type { Page, Space } from "@/lib/types";

type Hit = { id: string; rowId?: string; title: string; pageTitle?: string; icon: string; kind: string; snippet: string };
type T = ReturnType<typeof useT>;

const pageHref = (id: string) => pageLocationHash({ pageId: id });
// A book's or chapter's own text in the editor.
const editHref = (id: string) => pageLocationHash({ pageId: id, edit: true });
const untitled = (t: T, title: string) => title || t("Ohne Titel", "Untitled");
const pagesLabel = (t: T, n: number) => (n === 1 ? t("1 Seite", "1 page") : t(`${n} Seiten`, `${n} pages`));
// Where a chapter of the contents leads: its overview, or the page itself
// when it is not a document (a database as a chapter).
const chapterHref = (spaceId: string, bookId: string, chapter: LibraryChapter<Page>) =>
  opensAsOverview(chapter.page, 1) ? `#${libraryHash(spaceId, bookId, chapter.page.id)}` : pageHref(chapter.page.id);

export default function LibraryView({
  space,
  pages,
  bookId,
  chapterId = null,
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
  onRename,
}: {
  space: Space;
  // The workspace's live pages the person may see (titles decrypted).
  pages: Page[];
  bookId: string | null;
  chapterId?: string | null;
  workspaceId: string;
  visits: { pageId: string; seenAt: number }[];
  clock: number | null;
  canEdit: boolean;
  // A book (parent null), a chapter (parent: the book) or a page (parent:
  // its chapter), a document with this name; its id, null when it failed.
  onCreate: (parentId: string | null, title: string) => Promise<string | null>;
  userId?: string;
  // May change who sees the shelf (space and workspace owners).
  manage?: boolean;
  workspaceOwner?: boolean;
  onManageShelf?: () => void;
  // "Wer sieht dieses Buch?": the book page's sharing.
  onShareBook?: (pageId: string) => void;
  // Renames a book or chapter (#421): its page's title.
  onRename?: (pageId: string, title: string) => Promise<unknown>;
}) {
  const t = useT();
  const books = useMemo(() => libraryBooks(pages, space.id), [pages, space.id]);
  const book = bookId ? books.find((b) => b.page.id === bookId) : undefined;
  const chapter = book && chapterId ? book.chapters.find((c) => c.page.id === chapterId) : undefined;
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState<LibraryCreate | null>(null);
  // A new book or chapter shows the search no more.
  useEffect(() => setQuery(""), [bookId, chapterId]);
  // Created: a book or chapter shows its overview, a page opens to write.
  const created = async (parentId: string | null, title: string) => {
    const kind = create?.kind;
    const id = await onCreate(parentId, title);
    if (!id) return null;
    setCreate(null);
    location.hash =
      kind === "book" ? libraryHash(space.id, id) : kind === "chapter" && book ? libraryHash(space.id, book.page.id, id) : pageLocationHash({ pageId: id }).slice(1);
    return id;
  };
  const newPageIn = (c: LibraryChapter<Page>): LibraryCreate => ({ kind: "page", parentId: c.page.id, place: untitled(t, c.page.title) });
  // Chapters a page can go into from the book's overview: those that are directories.
  const chapterChoices = book ? book.chapters.filter((c) => opensAsOverview(c.page, 1)).map((c) => ({ id: c.page.id, title: c.page.title })) : [];
  const missing = (bookId && !book) || (chapterId && !chapter);
  return (
    <div className="utility-content library-view">
      {missing ? (
        <div className="empty-state">
          <Books size={38} />
          <h3>{chapterId && book ? t("Kapitel nicht gefunden", "Chapter not found") : t("Buch nicht gefunden", "Book not found")}</h3>
          <p>{t("Es wurde verschoben, gelöscht oder ist nicht mehr mit dir geteilt.", "It was moved, deleted or is no longer shared with you.")}</p>
          <a className="button" href={`#${book ? libraryHash(space.id, book.page.id) : libraryHash(space.id)}`}>
            {book ? t("Zum Buch", "To the book") : t("Zur Bibliothek", "To the library")}
          </a>
        </div>
      ) : (
        <>
          {book && chapter ? (
            <ChapterHeader book={book} chapter={chapter} space={space} pages={pages} onRename={canEdit ? onRename : undefined} />
          ) : book ? (
            <BookHeader
              book={book}
              space={space}
              pages={pages}
              visits={visits}
              clock={clock}
              onShare={onShareBook && (manage || (!!userId && book.page.created_by === userId)) ? () => onShareBook(book.page.id) : undefined}
              onRename={canEdit ? onRename : undefined}
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
          {book && (chapter ? opensAsOverview(chapter.page, 1) : opensAsOverview(book.page, 0)) && (
            <OwnText page={chapter ? chapter.page : book.page} chapter={!!chapter} canEdit={canEdit} />
          )}
          <div className="library-toolbar">
            <LibrarySearch spaceName={space.name} query={query} onQuery={setQuery} />
            {canEdit && !book && (
              <button type="button" className="button primary compact" onClick={() => setCreate({ kind: "book" })}>
                <Plus size={15} aria-hidden /> {t("Neues Buch", "New book")}
              </button>
            )}
            {canEdit && book && !chapter && (
              <button
                type="button"
                className={`button compact${chapterChoices.length ? "" : " primary"}`}
                onClick={() => setCreate({ kind: "chapter", parentId: book.page.id, bookTitle: untitled(t, book.page.title) })}
              >
                <Plus size={15} aria-hidden /> {t("Neues Kapitel", "New chapter")}
              </button>
            )}
            {canEdit && book && !chapter && chapterChoices.length > 0 && (
              <button type="button" className="button primary compact" onClick={() => setCreate({ kind: "page", parentId: "", chapters: chapterChoices })}>
                <Plus size={15} aria-hidden /> {t("Neue Seite", "New page")}
              </button>
            )}
            {canEdit && chapter && opensAsOverview(chapter.page, 1) && (
              <button type="button" className="button primary compact" onClick={() => setCreate(newPageIn(chapter))}>
                <Plus size={15} aria-hidden /> {t("Neue Seite", "New page")}
              </button>
            )}
          </div>
          {query.trim() ? (
            <SearchResults workspaceId={workspaceId} spaceId={space.id} query={query} />
          ) : book && chapter ? (
            <ChapterPages chapter={chapter} />
          ) : book ? (
            <Contents book={book} spaceId={space.id} canEdit={canEdit} onAdd={(c) => setCreate(newPageIn(c))} />
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
      <LibraryCreateDialog create={create} shelf={space.name} onClose={() => setCreate(null)} onCreate={created} />
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
  onRename,
}: {
  book: LibraryBook<Page>;
  space: Space;
  pages: Page[];
  visits: { pageId: string; seenAt: number }[];
  clock: number | null;
  onShare?: () => void;
  onRename?: (pageId: string, title: string) => Promise<unknown>;
}) {
  const t = useT();
  const locale = useLocale();
  const resume = useMemo(() => continueReading(pages, space.id, book.page.id, visits), [pages, space.id, book.page.id, visits]);
  const start = useMemo(() => firstPage(pages, space.id, book.page.id), [pages, space.id, book.page.id]);
  const cover = book.page.cover || "";
  return (
    <div className="utility-title library-title library-book-header">
      <a className="text-button library-back" href={`#${libraryHash(space.id)}`}>
        <ArrowLeft size={14} aria-hidden /> {t(`Bibliothek ${space.name}`, `Library ${space.name}`)}
      </a>
      {cover && <CoverFrame className="library-overview-cover" cover={cover} image={!!imageFileId(cover)} />}
      <span className="library-title-icon" aria-hidden>
        <PageIcon name={shownPageIcon(book.page.icon, book.page.kind)} size={34} />
      </span>
      <LibraryTitle page={book.page} onRename={onRename} label={t("Titel des Buchs", "Title of the book")} />
      <p>
        {pagesLabel(t, book.pages)}
        {book.chapters.length > 0 && ` · ${book.chapters.length === 1 ? t("1 Kapitel", "1 chapter") : t(`${book.chapters.length} Kapitel`, `${book.chapters.length} chapters`)}`}
        {book.updatedAt && ` · ${t(`Bearbeitet ${relativeTime(book.updatedAt, clock, locale)}`, `Edited ${relativeTime(book.updatedAt, clock, locale)}`)}`}
      </p>
      <div className="library-read">
        {resume && start && resume.id !== start.id ? (
          <>
            <a className="button primary compact" href={pageHref(resume.id)}>
              <BookOpen size={15} aria-hidden /> {t(`Weiterlesen: ${untitled(t, resume.title)}`, `Continue reading: ${untitled(t, resume.title)}`)}
            </a>
            <a className="button compact" href={pageHref(start.id)}>
              {t("Von vorn beginnen", "Start from the beginning")}
            </a>
          </>
        ) : (
          start && (
            <a className="button primary compact" href={pageHref(start.id)}>
              <BookOpen size={15} aria-hidden /> {t("Lesen beginnen", "Start reading")}
            </a>
          )
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

function ChapterHeader({
  book,
  chapter,
  space,
  pages,
  onRename,
}: {
  book: LibraryBook<Page>;
  chapter: LibraryChapter<Page>;
  space: Space;
  pages: Page[];
  onRename?: (pageId: string, title: string) => Promise<unknown>;
}) {
  const t = useT();
  const start = useMemo(() => firstPage(pages, space.id, chapter.page.id), [pages, space.id, chapter.page.id]);
  const number = book.chapters.indexOf(chapter) + 1;
  return (
    <div className="utility-title library-title library-book-header">
      <a className="text-button library-back" href={`#${libraryHash(space.id, book.page.id)}`}>
        <ArrowLeft size={14} aria-hidden /> {untitled(t, book.page.title)}
      </a>
      <span className="library-title-icon" aria-hidden>
        <PageIcon name={shownPageIcon(chapter.page.icon, chapter.page.kind)} size={34} />
      </span>
      <LibraryTitle page={chapter.page} onRename={onRename} label={t("Titel des Kapitels", "Title of the chapter")} />
      <p>
        {t(`Kapitel ${number}`, `Chapter ${number}`)}
        {" · "}
        {pagesLabel(t, chapter.below)}
      </p>
      {start && (
        <div className="library-read">
          <a className="button primary compact" href={pageHref(start.id)}>
            <BookOpen size={15} aria-hidden /> {t("Lesen beginnen", "Start reading")}
          </a>
        </div>
      )}
    </div>
  );
}

// The title of a book or chapter, renamed in place (#421): the pencil (for
// those who may edit) turns it into a field; Enter or leaving it saves, Esc
// keeps the old title. An empty title is not saved.
function LibraryTitle({ page, onRename, label }: { page: Page; onRename?: (pageId: string, title: string) => Promise<unknown>; label: string }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const title = untitled(t, page.title);
  const save = async () => {
    const next = (draft ?? "").trim();
    setDraft(null);
    if (!onRename || !next || next === page.title) return;
    setSaving(true);
    try {
      await onRename(page.id, next);
    } finally {
      setSaving(false);
    }
  };
  if (draft !== null)
    return (
      <h1 className="library-title-edit">
        <input
          className="library-title-input"
          aria-label={label}
          value={draft}
          maxLength={500}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
            }
          }}
        />
      </h1>
    );
  return (
    <div className="library-title-text">
      <h1>{title}</h1>
      {onRename && (
        <button
          type="button"
          className="icon-button library-rename"
          disabled={saving}
          title={t("Umbenennen", "Rename")}
          aria-label={t(`${title} umbenennen`, `Rename ${title}`)}
          onClick={() => setDraft(page.title)}
        >
          <PencilSimple size={18} aria-hidden />
        </button>
      )}
    </div>
  );
}

// What makes a text worth showing: words, or a picture, table, diagram …
function hasContent(html: string) {
  if (!html.trim()) return false;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return !!body.textContent?.trim() || !!body.querySelector("img, table, figure, iframe, video, audio, [data-mermaid], [data-drawio], [data-flow-diagram], [data-math]");
}
// Texts fetched in this visit, by page: back on an overview the last one
// shows at once while the current one loads.
const texts = new Map<string, { html: string; encrypted: boolean }>();

// A book's or chapter's own text (written before, or a BookStack book's
// description) read-only above the contents, with "Beschreibung
// bearbeiten" opening it in the editor (#page=…&edit=1). Without text,
// "Beschreibung hinzufügen" for those who may write.
function OwnText({ page, chapter, canEdit }: { page: Page; chapter: boolean; canEdit: boolean }) {
  const t = useT();
  const key = page.id;
  const [text, setText] = useState(() => texts.get(key) ?? null);
  // The kept one at once, the current one (edited meanwhile?) after it.
  useEffect(() => {
    setText(texts.get(key) ?? null);
    const controller = new AbortController();
    fetch(`/api/pages/${key}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { html?: string; encrypted?: unknown } | null) => {
        if (!data) return;
        const value = { html: typeof data.html === "string" ? data.html : "", encrypted: !!data.encrypted };
        texts.set(key, value);
        setText(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [key]);
  if (!text) return null;
  const label = chapter ? t("Über dieses Kapitel", "About this chapter") : t("Über dieses Buch", "About this book");
  // Encrypted text is read in the editor (the keys are there).
  if (text.encrypted)
    return (
      <p className="library-intro-empty">
        <a className="text-button" href={editHref(page.id)}>
          <PencilSimple size={14} aria-hidden /> {t("Beschreibung öffnen", "Open the description")}
        </a>
      </p>
    );
  if (!hasContent(text.html))
    return canEdit ? (
      <p className="library-intro-empty">
        <a className="text-button" href={editHref(page.id)}>
          <PencilSimple size={14} aria-hidden /> {t("Beschreibung hinzufügen", "Add a description")}
        </a>
      </p>
    ) : null;
  return (
    <section className="library-intro" aria-label={label}>
      <ReadOnlyDocument html={text.html} pageId={page.id} title={page.title} className="library-intro-text" />
      {canEdit && (
        <a className="text-button library-intro-edit" href={editHref(page.id)}>
          <PencilSimple size={14} aria-hidden /> {t("Beschreibung bearbeiten", "Edit description")}
        </a>
      )}
    </section>
  );
}

// The table of contents: chapters with their pages, each chapter folds.
function Contents({ book, spaceId, canEdit, onAdd }: { book: LibraryBook<Page>; spaceId: string; canEdit: boolean; onAdd: (chapter: LibraryChapter<Page>) => void }) {
  const t = useT();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const baseId = useId();
  if (!book.chapters.length)
    return (
      <div className="empty-state library-empty">
        <BookOpen size={34} />
        <h3>{t("Noch keine Kapitel", "No chapters yet")}</h3>
        <p>{t("Kapitel ordnen die Seiten des Buchs – lege das erste an.", "Chapters hold the book's pages – create the first one.")}</p>
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
                <a className="library-chapter-link" href={chapterHref(spaceId, book.page.id, chapter)} data-prefetch-page={chapter.page.id}>
                  <PageIcon name={shownPageIcon(chapter.page.icon, chapter.page.kind)} size={16} />
                  <span>{untitled(t, chapter.page.title)}</span>
                </a>
                <span className="library-count">{pagesLabel(t, chapter.below)}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="icon-button library-add"
                    title={t(`Seite in ${untitled(t, chapter.page.title)} hinzufügen`, `Add page in ${untitled(t, chapter.page.title)}`)}
                    aria-label={t(`Seite in ${untitled(t, chapter.page.title)} hinzufügen`, `Add page in ${untitled(t, chapter.page.title)}`)}
                    onClick={() => onAdd(chapter)}
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

// A chapter's pages, as in the book's contents.
function ChapterPages({ chapter }: { chapter: LibraryChapter<Page> }) {
  const t = useT();
  if (!chapter.pages.length)
    return (
      <div className="empty-state library-empty">
        <BookOpen size={34} />
        <h3>{t("Noch keine Seiten", "No pages yet")}</h3>
        <p>{t("Die Seiten des Kapitels erscheinen hier.", "The chapter's pages appear here.")}</p>
      </div>
    );
  return (
    <nav aria-label={t("Seiten des Kapitels", "Pages of the chapter")}>
      <h2 className="library-contents-heading">{t("Seiten", "Pages")}</h2>
      <ul className="library-pages library-chapter-pages">
        {chapter.pages.map((entry) => (
          <ContentsPage key={entry.page.id} entry={entry} />
        ))}
      </ul>
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
