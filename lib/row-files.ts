import { all } from "./db";
import { hiddenRowIds } from "./row-access";
import type { Identity, Page } from "./types";

// Files of a database belong to the page, not to a record. Those used only by
// records hidden from the person (private records) stay hidden with them:
// in the file list, downloads, search, the media library, copies and backups.
export function hiddenFileIds(user: Identity, page: Pick<Page, "id" | "kind" | "workspace_id"> & Partial<Page>): Set<string> {
  if (page.kind !== "database") return new Set();
  const hidden = hiddenRowIds(user, page as Page);
  if (!hidden.size) return new Set();
  const inHidden = new Set<string>(),
    inVisible = new Set<string>();
  for (const row of all<{ id: string; text: string }>(
    `SELECT r.id,r.cells||' '||COALESCE(r.icon,'')||' '||COALESCE(r.cover,'')||' '||COALESCE(r.content,'')||' '||COALESCE(d.html,'') text
     FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.page_id=?`,
    page.id,
  )) {
    const target = hidden.has(row.id) ? inHidden : inVisible;
    for (const match of row.text.matchAll(/\/api\/files\/([\w-]+)/g)) target.add(match[1]);
  }
  for (const id of inVisible) inHidden.delete(id);
  return inHidden;
}
