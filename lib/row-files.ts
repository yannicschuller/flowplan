import { hiddenFieldsFor, stripCells } from "./field-access";
import { all } from "./db";
import { hiddenRowIds } from "./row-access";
import { trashedRole } from "./row-trash";
import type { Identity, Page } from "./types";

// Files of a page hidden from the person: in the file list, downloads,
// search, the media library, copies and backups.
// - Files in the trash (#164, lib/file-trash.ts), for everyone.
// - Files of a database belong to the page, not to a record. Those used only
//   by records hidden from the person (private records) stay hidden with them.
export async function hiddenFileIds(user: Identity, page: Pick<Page, "id" | "kind" | "workspace_id"> & Partial<Page>): Promise<Set<string>> {
  const trashed = await trashedFileIds(page.id);
  if (page.kind !== "database") return trashed;
  const rowHidden = await hiddenRowFileIds(user, page);
  for (const id of trashed) rowHidden.add(id);
  return rowHidden;
}
// Files of a page in the trash (partial index files_trashed).
export const trashedFileIds = async (pageId: string) =>
  new Set((await all<{ id: string }>("SELECT id FROM files WHERE page_id=? AND deleted_at IS NOT NULL", pageId)).map((f) => f.id));
// Only the files of records hidden from the person (trashed files not included).
export async function hiddenRowFileIds(user: Identity, page: Pick<Page, "id" | "kind" | "workspace_id"> & Partial<Page>): Promise<Set<string>> {
  if (page.kind !== "database") return new Set();
  const hidden = await hiddenRowIds(user, page as Page);
  const inHidden = new Set<string>(),
    inVisible = new Set<string>();
  const ids = (text: string) => [...text.matchAll(/\/api\/files\/([\w-]+)/g)].map((m) => m[1]);
  // Records in the trash keep their permissions too.
  for (const trashed of await all<{ payload: string }>(
    "SELECT payload FROM row_trash WHERE page_id=? AND payload LIKE '%/api/files/%'",
    page.id,
  )) {
    const payload = JSON.parse(trashed.payload) as Parameters<typeof trashedRole>[2];
    if (!(await trashedRole(user, page as Page, payload))) for (const id of ids(trashed.payload)) inHidden.add(id);
  }
  // Files in properties hidden from this person (lib/field-access.ts).
  const hiddenFields = await hiddenFieldsFor(user, page as Page);
  if (!hidden.size && !inHidden.size && !hiddenFields.size) return new Set();
  for (const row of await all<{ id: string; cells: string; text: string }>(
    `SELECT r.id,r.cells,COALESCE(r.icon,'')||' '||COALESCE(r.cover,'')||' '||COALESCE(r.content,'')||' '||COALESCE(d.html,'') text
     FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.page_id=?`,
    page.id,
  )) {
    const target = hidden.has(row.id) ? inHidden : inVisible;
    let cells = row.cells;
    if (hiddenFields.size && cells.includes("/api/files/")) {
      const parsed = JSON.parse(cells) as Record<string, unknown>;
      for (const key of hiddenFields) for (const id of ids(JSON.stringify(parsed[key] ?? ""))) inHidden.add(id);
      cells = stripCells(cells, hiddenFields);
    }
    for (const id of ids(`${cells} ${row.text}`)) target.add(id);
  }
  for (const id of inVisible) inHidden.delete(id);
  return inHidden;
}
