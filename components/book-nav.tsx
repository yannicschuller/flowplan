"use client";
// Reading a page of a library (#329): where it sits in its book (library ›
// book › chapter …) and the previous and next page in reading order
// (lib/library.ts bookNavigation). Kept small: one line above the page.
import { useMemo } from "react";
import { Books, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { bookNavigation, libraryHash, opensAsOverview } from "@/lib/library";
import { pageLocationHash } from "@/lib/page-location";
import type { Page, Space } from "@/lib/types";

export function BookNav({ space, pages, pageId }: { space: Space; pages: Page[]; pageId: string }) {
  const t = useT();
  const nav = useMemo(() => bookNavigation(pages, space.id, pageId), [pages, space.id, pageId]);
  if (!nav) return null;
  const title = (p: Page) => p.title || t("Ohne Titel", "Untitled");
  // The page itself is the title below; the way there: book, chapter, …
  const above = nav.path.slice(0, -1);
  return (
    <nav className="book-nav" aria-label={t("Im Buch", "In the book")}>
      <ol className="book-nav-path">
        <li>
          <a href={`#${libraryHash(space.id)}`} title={t(`Bibliothek ${space.name}`, `Library ${space.name}`)}>
            <Books size={14} aria-hidden />
            <span className="book-nav-library">{space.name}</span>
          </a>
        </li>
        <li>
          <a href={`#${libraryHash(space.id, nav.book.id)}`} title={t("Inhaltsverzeichnis", "Table of contents")}>
            {title(nav.book)}
          </a>
        </li>
        {above.slice(1).map((p, i) => (
          <li key={p.id}>
            {/* A chapter leads to its overview. */}
            <a href={!i && opensAsOverview(p, 1) ? `#${libraryHash(space.id, nav.book.id, p.id)}` : pageLocationHash({ pageId: p.id })}>{title(p)}</a>
          </li>
        ))}
      </ol>
      {/* A book's or chapter's own text in the editor: no place in the reading order. */}
      {nav.position > 0 && (
      <span className="book-nav-steps">
        <span className="book-nav-position">{t(`Seite ${nav.position} von ${nav.total}`, `Page ${nav.position} of ${nav.total}`)}</span>
        {nav.previous ? (
          <a className="book-nav-step" href={pageLocationHash({ pageId: nav.previous.id })} rel="prev" aria-label={t(`Vorherige Seite: ${title(nav.previous)}`, `Previous page: ${title(nav.previous)}`)} title={title(nav.previous)}>
            <CaretLeft size={15} aria-hidden />
          </a>
        ) : (
          <span className="book-nav-step" aria-hidden>
            <CaretLeft size={15} />
          </span>
        )}
        {nav.next ? (
          <a className="book-nav-step" href={pageLocationHash({ pageId: nav.next.id })} rel="next" aria-label={t(`Nächste Seite: ${title(nav.next)}`, `Next page: ${title(nav.next)}`)} title={title(nav.next)}>
            <CaretRight size={15} aria-hidden />
          </a>
        ) : (
          <span className="book-nav-step" aria-hidden>
            <CaretRight size={15} />
          </span>
        )}
      </span>
      )}
    </nav>
  );
}

// At the end of a page of a library: the next page to read, by name.
export function BookNext({ space, pages, pageId }: { space: Space; pages: Page[]; pageId: string }) {
  const t = useT();
  const nav = useMemo(() => bookNavigation(pages, space.id, pageId), [pages, space.id, pageId]);
  if (!nav || !nav.position || (!nav.next && !nav.previous)) return null;
  const title = (p: Page) => p.title || t("Ohne Titel", "Untitled");
  return (
    <nav className="book-next" aria-label={t("Weiterlesen", "Continue reading")}>
      {nav.previous ? (
        <a className="book-next-link previous" href={pageLocationHash({ pageId: nav.previous.id })}>
          <span className="book-next-label">
            <CaretLeft size={13} aria-hidden /> {t("Zurück", "Previous")}
          </span>
          <span className="book-next-title">{title(nav.previous)}</span>
        </a>
      ) : (
        <span />
      )}
      {nav.next ? (
        <a className="book-next-link next" href={pageLocationHash({ pageId: nav.next.id })}>
          <span className="book-next-label">
            {t("Weiter", "Next")} <CaretRight size={13} aria-hidden />
          </span>
          <span className="book-next-title">{title(nav.next)}</span>
        </a>
      ) : (
        <a className="book-next-link next" href={`#${libraryHash(space.id, nav.book.id)}`}>
          <span className="book-next-label">{t("Ende des Buchs", "End of the book")}</span>
          <span className="book-next-title">{t("Zum Inhaltsverzeichnis", "To the contents")}</span>
        </a>
      )}
    </nav>
  );
}
