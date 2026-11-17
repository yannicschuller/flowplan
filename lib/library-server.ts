// A space as a library on the server (#329): the books, chapters and pages
// of one space as the asking person may see them – for the API
// (GET /api/spaces/{spaceId}/library) and MCP (get_library). The browser
// works the same out from the bootstrap's pages (lib/library.ts).
import { all, one } from "./db";
import { HttpError } from "./auth";
import { filterAsync } from "./each-async";
import { lockedPageIds } from "./journal-extras";
import { libraryBooks } from "./library";
import { pageRole, requireMember, spaceRole } from "./permissions";
import type { Identity, Page, Space } from "./types";

// Only the columns the library shows: one query for the whole space,
// then the same check per page as the sidebar's (bootstrap) – a page is
// listed when the person may read it, wherever the access comes from.
const COLUMNS = "id,workspace_id,space_id,parent_id,parent_row_id,title,icon,cover,kind,position,updated_at,deleted_at,journal_date,synced";

export async function spaceLibraryPages(user: Identity, space: Space) {
  const guest = !!(await one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", space.workspace_id, user.id));
  const pages = await all<Page>(
    `SELECT ${COLUMNS} FROM pages WHERE space_id=? AND deleted_at IS NULL AND synced=0 ORDER BY position`,
    space.id,
  );
  // Journals behind a PIN not entered and encrypted spaces: no titles.
  const locked = await lockedPageIds(user, space.workspace_id);
  return await filterAsync(pages, async (p) => !locked.has(p.id) && !(guest && p.kind === "workflow") && !!(await pageRole(user, p)));
}

export async function spaceLibrary(user: Identity, spaceId: string) {
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND deleted_at IS NULL", spaceId);
  if (!space) throw new HttpError(404, "Bereich nicht gefunden.");
  await requireMember(user, space.workspace_id);
  const pages = await spaceLibraryPages(user, space);
  // A space one may not open, with no page shared from it: not there.
  if (!(await spaceRole(user, space)) && !pages.length) throw new HttpError(404, "Bereich nicht gefunden.");
  const brief = (p: Page) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, updatedAt: p.updated_at });
  return {
    space: { id: space.id, name: space.name, library: !!space.library },
    books: libraryBooks(pages, space.id).map((book) => ({
      ...brief(book.page),
      cover: book.page.cover || "",
      pages: book.pages,
      updatedAt: book.updatedAt,
      chapters: book.chapters.map((chapter) => ({
        ...brief(chapter.page),
        below: chapter.below,
        pages: chapter.pages.map((entry) => ({ ...brief(entry.page), below: entry.below })),
      })),
    })),
  };
}
