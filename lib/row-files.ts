import { all } from "./db";
import { hiddenRowIds } from "./row-access";
import { trashedRole } from "./row-trash";
import type { Identity, Page } from "./types";

// Files of a database belong to the page, not to a record. Those used only by
// records hidden from the person (private records) stay hidden with them:
// in the file list, downloads, search, the media library, copies and backups.
export function hiddenFileIds(user: Identity, page: Pick<Page, "id" | "kind" | "workspace_id"> & Partial<Page>): Set<string> {
  if (page.kind !== "database") return new Set();
  const hidden = hiddenRowIds(user, page as Page);
  const inHidden = new Set<string>(),
    inVisible = new Set<string>();
  const ids = (text: string) => [...text.matchAll(/\/api\/files\/([\w-]+)/g)].map((m) => m[1]);
  // Records in the trash keep their permissions too.
  for (const trashed of all<{ payload: string }>(
    "SELECT payload FROM row_trash WHERE page_id=? AND payload LIKE '%/api/files/%'",
    page.id,
  )) {
    const payload = JSON.parse(trashed.payload) as Parameters<typeof trashedRole>[2];
    if (!trashedRole(user, page as Page, payload)) for (const id of ids(trashed.payload)) inHidden.add(id);
  }
  if (!hidden.size && !inHidden.size) return new Set();
  for (const row of all<{ id: string; text: string }>(
    `SELECT r.id,r.cells||' '||COALESCE(r.icon,'')||' '||COALESCE(r.cover,'')||' '||COALESCE(r.content,'')||' '||COALESCE(d.html,'') text
     FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.page_id=?`,
    page.id,
  )) {
    const target = hidden.has(row.id) ? inHidden : inVisible;
    for (const id of ids(row.text)) target.add(id);
  }
  for (const id of inVisible) inHidden.delete(id);
  return inHidden;
}
