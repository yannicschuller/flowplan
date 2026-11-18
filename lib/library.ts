// A space shown as a library (#329, "Als Bibliothek anzeigen"): the pages
// at the top of the space are its books, their sub-pages the chapters and
// the pages below a chapter its pages. No second structure – the page tree
// is the library, in the tree's order. Pure functions over the pages a
// person may see (the bootstrap's, or lib/library-server.ts on the server),
// tested in tests/library.test.ts.

export type LibraryPage = {
  id: string;
  parent_id: string | null;
  space_id: string;
  title: string;
  icon: string;
  cover?: string | null;
  kind: string;
  position: number;
  updated_at?: string | null;
  deleted_at?: string | null;
  journal_date?: string | null;
};
// A page of the table of contents with the number of pages below it.
export type LibraryEntry<P extends LibraryPage = LibraryPage> = {
  page: P;
  // Pages below this one (not counting itself).
  below: number;
};
export type LibraryChapter<P extends LibraryPage = LibraryPage> = LibraryEntry<P> & {
  pages: LibraryEntry<P>[];
};
export type LibraryBook<P extends LibraryPage = LibraryPage> = {
  page: P;
  // The pages of the book, the book's own page included.
  pages: number;
  chapters: LibraryChapter<P>[];
  // The latest change of a page of the book (as stored, UTC text).
  updatedAt: string | null;
};

const MAX_DEPTH = 64;

// Children per parent ("" for the top of the space), in the tree's order:
// by position, pages with the same position in the order given (the
// bootstrap's). A page whose parent is not visible sits at the top, as in
// the sidebar. Journal days (journal_date) are a journal's own way of
// reading (lib/journal-nav.ts) and stay out.
function childrenOf<P extends LibraryPage>(pages: readonly P[], spaceId: string) {
  const live = pages.filter((p) => p.space_id === spaceId && !p.deleted_at && !p.journal_date);
  const ids = new Set(live.map((p) => p.id));
  const index = new Map<string, P[]>();
  for (const p of [...live].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const key = p.parent_id && ids.has(p.parent_id) ? p.parent_id : "";
    const list = index.get(key);
    if (list) list.push(p);
    else index.set(key, [p]);
  }
  return index;
}

// The pages below `id` in reading order: depth first, each page before its
// sub-pages (the order the sidebar lists them unfolded).
function walk<P extends LibraryPage>(index: Map<string, P[]>, id: string, out: P[] = [], seen = new Set<string>(), depth = 0): P[] {
  if (depth > MAX_DEPTH) return out;
  for (const child of index.get(id) || []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    out.push(child);
    walk(index, child.id, out, seen, depth + 1);
  }
  return out;
}

const latest = (values: (string | null | undefined)[]) =>
  values.reduce<string | null>((max, v) => (v && (!max || v > max) ? v : max), null);

// The books of a library with their chapters and pages.
export function libraryBooks<P extends LibraryPage>(pages: readonly P[], spaceId: string, index = childrenOf(pages, spaceId)): LibraryBook<P>[] {
  const entry = (page: P): LibraryEntry<P> => ({ page, below: walk(index, page.id).length });
  return (index.get("") || []).map((book) => {
    const inside = walk(index, book.id);
    return {
      page: book,
      pages: inside.length + 1,
      updatedAt: latest([book.updated_at, ...inside.map((p) => p.updated_at)]),
      chapters: (index.get(book.id) || []).map((chapter) => ({
        ...entry(chapter),
        pages: (index.get(chapter.id) || []).map(entry),
      })),
    };
  });
}

// The book (top-level page) a page belongs to, or null outside the space.
export function bookOf<P extends LibraryPage>(pages: readonly P[], spaceId: string, pageId: string): P | null {
  return topOf(childrenOf(pages, spaceId), pageId);
}
function topOf<P extends LibraryPage>(index: Map<string, P[]>, pageId: string): P | null {
  const byId = new Map([...index.values()].flat().map((p) => [p.id, p]));
  const parentOf = new Map<string, string>();
  for (const [parent, list] of index) for (const p of list) parentOf.set(p.id, parent);
  if (!parentOf.has(pageId)) return null;
  // Up to the top of the space; a page in a cycle of parents is in no book.
  const seen = new Set([pageId]);
  let id = pageId;
  while (parentOf.get(id)) {
    id = parentOf.get(id)!;
    if (seen.has(id) || seen.size > MAX_DEPTH) return null;
    seen.add(id);
  }
  return byId.get(id) || null;
}

// Reading a page of a library: the way from the book down to it (book,
// chapter, …, the page) and the previous and next page of the book in
// reading order – the book's own page first, then its pages depth first.
// null when the page is not in the library (another space, a journal day).
export function bookNavigation<P extends LibraryPage>(pages: readonly P[], spaceId: string, pageId: string) {
  const index = childrenOf(pages, spaceId);
  const book = topOf(index, pageId);
  if (!book) return null;
  const order = [book, ...walk(index, book.id)];
  const at = order.findIndex((p) => p.id === pageId);
  if (at < 0) return null;
  const byId = new Map(order.map((p) => [p.id, p]));
  const path: P[] = [];
  for (let p: P | undefined = byId.get(pageId); p && path.length < MAX_DEPTH; p = p.parent_id ? byId.get(p.parent_id) : undefined) {
    path.unshift(p);
    if (p.id === book.id) break;
  }
  return {
    book,
    path,
    position: at + 1,
    total: order.length,
    previous: at > 0 ? order[at - 1] : null,
    next: at < order.length - 1 ? order[at + 1] : null,
  };
}

// "Weiterlesen": the page of the book visited last (the bootstrap's recent
// visits), null when none of the book's pages was opened yet.
export function continueReading<P extends LibraryPage>(
  pages: readonly P[],
  spaceId: string,
  bookId: string,
  visits: readonly { pageId: string; seenAt: number }[],
): P | null {
  const index = childrenOf(pages, spaceId);
  const book = pages.find((p) => p.id === bookId && p.space_id === spaceId && !p.deleted_at);
  if (!book) return null;
  const inBook = new Map([book, ...walk(index, book.id)].map((p) => [p.id, p]));
  let best: { page: P; seenAt: number } | null = null;
  for (const v of visits) {
    const page = inBook.get(v.pageId);
    if (page && (!best || v.seenAt > best.seenAt)) best = { page, seenAt: v.seenAt };
  }
  return best?.page ?? null;
}

// ---- The libraries of a workspace (#329 follow-up: "Bibliothek") ----

// Where a page stands in its library: the book (level 0), a chapter
// (level 1) or a page further down (2, 3, …), the way from the book down to
// it and its place in the book's reading order.
export type LibraryPlace<P extends LibraryPage = LibraryPage> = {
  spaceId: string;
  level: number;
  book: P;
  chapter: P | null;
  path: P[];
  position: number;
  total: number;
};

// The books of a space and the place of every page in them, in one walk
// over the tree (no lookups per page: a library of a thousand pages is
// indexed in linear time).
export function libraryIndex<P extends LibraryPage>(pages: readonly P[], spaceId: string) {
  const index = childrenOf(pages, spaceId);
  const books = libraryBooks(pages, spaceId, index);
  const places = new Map<string, LibraryPlace<P>>();
  for (const book of index.get("") || []) {
    const order = [book, ...walk(index, book.id)];
    const byId = new Map(order.map((p) => [p.id, p]));
    order.forEach((page, at) => {
      const path: P[] = [];
      for (let p: P | undefined = page; p && path.length <= MAX_DEPTH; p = p.parent_id ? byId.get(p.parent_id) : undefined) {
        path.unshift(p);
        if (p.id === book.id) break;
      }
      places.set(page.id, { spaceId, level: path.length - 1, book, chapter: path[1] ?? null, path, position: at + 1, total: order.length });
    });
  }
  return { books, places };
}

export type LibrarySpace = { id: string; name: string; visibility: "team" | "private"; owner_id: string; library?: number | boolean | null; deleted_at?: string | null };
export type LibraryShelf<S extends LibrarySpace = LibrarySpace, P extends LibraryPage = LibraryPage> = {
  space: S;
  books: LibraryBook<P>[];
  // Pages of all its books.
  pages: number;
};

// The pages per space, each list in the order given.
function bySpace<P extends LibraryPage>(pages: readonly P[]) {
  const grouped = new Map<string, P[]>();
  for (const p of pages) {
    const list = grouped.get(p.space_id);
    if (list) list.push(p);
    else grouped.set(p.space_id, [p]);
  }
  return grouped;
}

// The workspace's library: every space shown as a library is a shelf, its
// books on it. "Meine Regale" are the person's own private spaces, "Geteilt"
// the team's spaces and private ones shared with them – in the order the
// spaces are given (the sidebar's). Only the pages given count (those the
// person may see); a shelf without a visible page is listed when its space
// is given (the person may open it).
export function libraryShelves<S extends LibrarySpace, P extends LibraryPage>(spaces: readonly S[], pages: readonly P[], userId: string) {
  const grouped = bySpace(pages);
  const personal: LibraryShelf<S, P>[] = [],
    shared: LibraryShelf<S, P>[] = [];
  for (const space of spaces) {
    if (!space.library || space.deleted_at) continue;
    const books = libraryBooks(grouped.get(space.id) || [], space.id);
    const shelf = { space, books, pages: books.reduce((n, b) => n + b.pages, 0) };
    (space.visibility === "private" && space.owner_id === userId ? personal : shared).push(shelf);
  }
  return { personal, shared };
}

// "Weiterlesen" on the library's start: per book the page visited last,
// the books read most recently first, at most `limit`.
export function readingNow<P extends LibraryPage>(
  pages: readonly P[],
  spaceIds: readonly string[],
  visits: readonly { pageId: string; seenAt: number }[],
  limit = 6,
) {
  const grouped = bySpace(pages);
  const places = new Map<string, LibraryPlace<P>>();
  for (const spaceId of spaceIds) for (const [id, place] of libraryIndex(grouped.get(spaceId) || [], spaceId).places) places.set(id, place);
  const out: (LibraryPlace<P> & { page: P; seenAt: number })[] = [];
  const books = new Set<string>();
  for (const v of [...visits].sort((a, b) => b.seenAt - a.seenAt)) {
    const place = places.get(v.pageId);
    if (!place || books.has(place.book.id)) continue;
    books.add(place.book.id);
    out.push({ ...place, page: place.path[place.path.length - 1], seenAt: v.seenAt });
    if (out.length >= limit) break;
  }
  return out;
}

// The library's start (#library) – all shelves – and the address of a
// shelf and of a book's table of contents
// (#library/<space>, #library/<space>/<book>).
export const LIBRARY_HOME = "library";
export const libraryHash = (spaceId: string, bookId?: string | null) => `library/${spaceId}${bookId ? `/${bookId}` : ""}`;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HASH = new RegExp(`^library/(${UUID})(?:/(${UUID}))?$`, "i");
export function parseLibraryHash(fragment: string): { spaceId: string; bookId: string | null } | null {
  const m = HASH.exec(fragment);
  return m ? { spaceId: m[1].toLowerCase(), bookId: m[2]?.toLowerCase() ?? null } : null;
}
