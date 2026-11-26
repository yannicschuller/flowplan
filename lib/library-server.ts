// A space as a library on the server (#329): the books, chapters and pages
// of one space as the asking person may see them – for the API
// (GET /api/spaces/{spaceId}/library) and MCP (get_library) – and the
// workspace's library: every library space a shelf (GET /api/library,
// MCP get_library without a space) with a search over all shelves, grouped
// by level (GET /api/library/search, MCP search_library). The browser works
// the shelves out from the bootstrap's pages (lib/library.ts).
//
// No permission model of its own: shelves are spaces, books are pages. A
// page is listed when pageRole() lets the person read it – the same check
// as the sidebar's (bootstrap) and the search's. With hundreds of pages per
// shelf the roles of all pages are computed at once (workspaceRoles()), not
// page by page.
import { all, one, sql } from "./db";
import { HttpError } from "./auth";
import { filterAsync } from "./each-async";
import { lockedPageIds } from "./journal-extras";
import { libraryBooks, libraryIndex, libraryShelves, readingNow, type LibraryBook, type LibraryPlace } from "./library";
import { isGuest, memberRole, pageRole, requireMember, spaceRole, workspaceRoles } from "./permissions";
import { SPACE_ORDER } from "./space-order";
import { MARK_START, searchWorkspace, type SearchResult } from "./search-index";
import { foldText } from "./search-store";
import type { Identity, Page, Space } from "./types";
import { spacesAsShown } from "./workspace-navigation";
import { workspaceNavigation } from "./workspace-navigation-server";

// The pages the person may read among `pages` (stored rows of one
// workspace): no titles of journals behind a PIN not entered or of
// encrypted spaces, no workflows for guests.
async function readable(user: Identity, workspaceId: string, pages: Page[]) {
  await workspaceRoles(user, workspaceId);
  const guest = await isGuest(user, workspaceId);
  const locked = await lockedPageIds(user, workspaceId);
  return await filterAsync(pages, async (p) => !locked.has(p.id) && !(guest && p.kind === "workflow") && !!(await pageRole(user, p)));
}

export async function spaceLibraryPages(user: Identity, space: Space) {
  const pages = await all<Page>("SELECT * FROM pages WHERE space_id=? AND deleted_at IS NULL AND synced=0 ORDER BY position", space.id);
  return await readable(user, space.workspace_id, pages);
}

const brief = (p: Page) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, updatedAt: p.updated_at });
// A book on a shelf (the start: the number of chapters) and with its
// table of contents (one library).
const bookBrief = (book: LibraryBook<Page>) => ({
  ...brief(book.page),
  cover: book.page.cover || "",
  pages: book.pages,
  updatedAt: book.updatedAt,
  chapters: book.chapters.length,
});
const bookFull = (book: LibraryBook<Page>) => ({
  ...bookBrief(book),
  chapters: book.chapters.map((chapter) => ({
    ...brief(chapter.page),
    below: chapter.below,
    pages: chapter.pages.map((entry) => ({ ...brief(entry.page), below: entry.below })),
  })),
});

export async function spaceLibrary(user: Identity, spaceId: string) {
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", spaceId);
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  await requireMember(user, space.workspace_id);
  const pages = await spaceLibraryPages(user, space);
  // A space one may not open, with no page shared from it: not there.
  if (!(await spaceRole(user, space)) && !pages.length) throw new HttpError(404, "Bereich nicht gefunden.");
  return {
    // As it shows: with the workspace as a library (#564) every space is one.
    space: { id: space.id, name: space.name, library: !!space.library || (await workspaceNavigation(space.workspace_id)).library },
    books: libraryBooks(pages, space.id).map((book) => bookFull(book)),
  };
}

// The spaces shown as a library that the person sees (they may open the
// space or a page of it is shared with them) and their readable pages: two
// queries for all shelves, whatever their size. With the workspace as a
// library (#564, lib/workspace-navigation.ts) every space is a shelf.
export async function libraryPages(user: Identity, workspaceId: string) {
  await requireMember(user, workspaceId);
  const nav = await workspaceNavigation(workspaceId);
  const spaces = spacesAsShown(
    await all<Space>(`SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL${nav.library ? "" : " AND library=1"} ORDER BY ${SPACE_ORDER}`, workspaceId),
    nav,
  );
  if (!spaces.length) return { spaces, pages: [] as Page[] };
  const pages = await readable(
    user,
    workspaceId,
    await all<Page>(
      `SELECT * FROM pages WHERE space_id IN ${sql.jsonValues()} AND deleted_at IS NULL AND synced=0 ORDER BY position`,
      JSON.stringify(spaces.map((s) => s.id)),
    ),
  );
  const withPages = new Set(pages.map((p) => p.space_id));
  const shown = await filterAsync(spaces, async (s) => withPages.has(s.id) || !!(await spaceRole(user, s)));
  const ids = new Set(shown.map((s) => s.id));
  return { spaces: shown, pages: pages.filter((p) => ids.has(p.space_id)) };
}

// Who may open a shelf's sharing (the space's settings with its access per
// person and group): space owners and workspace owners, as in the sidebar.
async function canManage(user: Identity, space: Space) {
  const role = await memberRole(user, space.workspace_id);
  return role === "owner" || (role === "editor" && space.owner_id === user.id);
}

// The library's start: the person's own shelves and the shared ones, each
// with its books, and "Weiterlesen" – the page visited last per book.
export async function libraryOverview(user: Identity, workspaceId: string) {
  const { spaces, pages } = await libraryPages(user, workspaceId);
  const { personal, shared } = libraryShelves(spaces, pages, user.id);
  const visits = spaces.length
    ? (await all<{ page_id: string; seen_at: number }>(
        `SELECT v.page_id,v.seen_at FROM page_visits v JOIN pages p ON p.id=v.page_id
         WHERE v.user_id=? AND p.space_id IN ${sql.jsonValues()} AND p.deleted_at IS NULL ORDER BY v.seen_at DESC LIMIT 300`,
        user.id,
        JSON.stringify(spaces.map((s) => s.id)),
      )).map((v) => ({ pageId: v.page_id, seenAt: Number(v.seen_at) }))
    : [];
  const shelf = async (s: (typeof personal)[number]) => ({
    id: s.space.id,
    name: s.space.name,
    icon: s.space.icon,
    iconColor: s.space.icon_color || "none",
    visibility: s.space.visibility,
    pages: s.pages,
    canManage: await canManage(user, s.space),
    books: s.books.map((book) => bookBrief(book)),
  });
  const out = async (list: typeof personal) => {
    const shelves = [];
    for (const s of list) shelves.push(await shelf(s));
    return shelves;
  };
  return {
    personal: await out(personal),
    shared: await out(shared),
    continueReading: readingNow(pages, spaces.map((s) => s.id), visits).map((r) => ({
      spaceId: r.spaceId,
      book: brief(r.book),
      page: brief(r.page),
      position: r.position,
      total: r.total,
      visitedAt: new Date(r.seenAt).toISOString(),
    })),
  };
}

// ---- Search over all shelves ----

export const LIBRARY_GROUP_LIMIT = 50;
export type LibraryHit = {
  id: string;
  rowId?: string;
  title: string;
  icon: string;
  kind: string;
  spaceId: string;
  // 0 book, 1 chapter, 2 … a page further down; the shelf's hits have none.
  level?: number;
  // From the book down to the page (titles and ids), the shelf first.
  path: { id: string; title: string }[];
  snippet?: string;
};

// Where the folded query stands in a title: 0 the whole title, 1 at its
// start, 2 at the start of a word, 3 inside; null: not in it.
function titleRank(title: string, folded: string) {
  const t = foldText(title);
  const at = t.indexOf(folded);
  if (at < 0) return null;
  return t === folded ? 0 : at === 0 ? 1 : /[\p{L}\p{N}]/u.test(t[at - 1]) ? 3 : 2;
}
const byRank = <T,>(list: { hit: T; rank: number; order: number }[]) =>
  list.sort((a, b) => a.rank - b.rank || a.order - b.order).map((x) => x.hit);

// The library search (#329): the hits grouped by level – shelves (space
// names), books and chapters (their titles), pages and content (titles
// further down, and text, records, comments and files of any page of a
// book, with a snippet). Titles are matched against the words typed, in
// the tree's order with whole and leading matches first; the content comes
// from the workspace's search (lib/search-index.ts) limited to the shelves,
// with its ranking and the same permission checks. Each group holds at most
// LIBRARY_GROUP_LIMIT hits; `total` counts them all.
export async function searchLibrary(user: Identity, workspaceId: string, rawQuery: string, options: { timeZone?: string } = {}) {
  const query = rawQuery.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  const empty = { query, shelves: [], books: [], chapters: [], pages: [], total: { shelves: 0, books: 0, chapters: 0, pages: 0 } };
  if (!query) return empty;
  const { spaces, pages } = await libraryPages(user, workspaceId);
  if (!spaces.length) return empty;
  const grouped = new Map<string, Page[]>();
  for (const p of pages) (grouped.get(p.space_id) ?? grouped.set(p.space_id, []).get(p.space_id)!).push(p);
  const places = new Map<string, LibraryPlace<Page>>();
  for (const s of spaces) for (const [id, place] of libraryIndex(grouped.get(s.id) || [], s.id).places) places.set(id, place);
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
  const pathOf = (place: LibraryPlace<Page>, upTo = place.path.length - 1) => [
    { id: place.spaceId, title: spaceName.get(place.spaceId) || "" },
    ...place.path.slice(0, upTo).map((p) => ({ id: p.id, title: p.title })),
  ];
  // Filters (#tag, in:, OR …) are for the content; titles take the words.
  const words = query
    .split(/\s+/)
    .filter((w) => w && !/^[-#]|^\w+:|^(OR|AND|NOT)$|^[()|]$/.test(w))
    .join(" ");
  const folded = foldText(words);
  const shelves: { hit: LibraryHit; rank: number; order: number }[] = [];
  const books: typeof shelves = [],
    chapters: typeof shelves = [],
    titled: typeof shelves = [];
  if (folded) {
    spaces.forEach((s, order) => {
      const rank = titleRank(s.name, folded);
      if (rank !== null) shelves.push({ hit: { id: s.id, title: s.name, icon: s.icon, kind: "shelf", spaceId: s.id, path: [] }, rank, order });
    });
    let order = 0;
    for (const [id, place] of places) {
      order++;
      const page = place.path[place.path.length - 1];
      const rank = titleRank(page.title, folded);
      if (rank === null) continue;
      const hit: LibraryHit = { id, title: page.title, icon: page.icon, kind: page.kind, spaceId: place.spaceId, level: place.level, path: pathOf(place) };
      (place.level === 0 ? books : place.level === 1 ? chapters : titled).push({ hit, rank, order });
    }
  }
  // Text, records, comments and files of the books' pages.
  const found: SearchResult[] = await searchWorkspace(user, workspaceId, query, {
    spaceIds: spaces.map((s) => s.id),
    excludeDays: true,
    timeZone: options.timeZone,
  });
  // A page found by its title is in its group already: its text adds the
  // snippet there instead of a second hit.
  const listed = new Map([...books, ...chapters, ...titled].map((x) => [x.hit.id, x.hit]));
  const content: LibraryHit[] = [];
  const seen = new Set<string>();
  for (const r of found) {
    const place = places.get(r.id);
    if (!place) continue;
    const entry = !r.rowId && r.kind !== "comment" && r.kind !== "file";
    const snippet = r.snippet && r.snippet.includes(MARK_START) ? r.snippet : undefined;
    const known = entry ? listed.get(r.id) : undefined;
    if (known) {
      if (snippet && !known.snippet) known.snippet = snippet;
      continue;
    }
    const key = `${r.id}:${r.rowId || ""}:${r.kind}:${r.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    content.push({
      id: r.id,
      ...(r.rowId ? { rowId: r.rowId } : {}),
      title: r.title || r.pageTitle || "",
      icon: r.icon,
      kind: r.kind,
      spaceId: place.spaceId,
      level: place.level,
      // A record, comment or file: the way includes its page.
      path: entry ? pathOf(place) : pathOf(place, place.path.length),
      ...(snippet ? { snippet } : {}),
    });
  }
  // Titles further down first (whole and leading matches), then the text.
  const unique = [...byRank(titled), ...content];
  const cut = <T,>(list: T[]) => list.slice(0, LIBRARY_GROUP_LIMIT);
  return {
    query,
    shelves: cut(byRank(shelves)),
    books: cut(byRank(books)),
    chapters: cut(byRank(chapters)),
    pages: cut(unique),
    total: { shelves: shelves.length, books: books.length, chapters: chapters.length, pages: unique.length },
  };
}
