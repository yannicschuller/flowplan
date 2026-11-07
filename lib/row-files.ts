import { hiddenFieldsFor, stripCells } from "./field-access";
import { all, one, sql } from "./db";
import { hiddenRowIds } from "./row-access";
import { trashedRole } from "./row-trash";
import type { Identity, Page } from "./types";

// Files of a page hidden from the person: in the file list, downloads,
// search, the media library, copies and backups.
// - Files in the trash (#164, lib/file-trash.ts), for everyone.
// - Files of a database belong to the page, not to a record. Those used only
//   by records hidden from the person (private records) stay hidden with them.
//   So do those of a hidden record that also appear in a visible one, unless
//   the visible use is evidently not about the hidden record (see
//   hiddenRowFileIds).
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

// Who a hidden use of a file belongs to: the people who created the record
// or hold a grant on it (users, groups); `always` for uses whose owners are
// not told apart (properties hidden from the person).
type HiddenUse = { users: Set<string>; groups: Set<string>; always: boolean };
const ids = (text: string) => [...text.matchAll(/\/api\/files\/([\w-]+)/g)].map((m) => m[1]);

// Only the files of records hidden from the person (trashed files not included).
//
// A reference in a visible record does not by itself open a file a hidden
// record uses: whoever may edit a visible record could write
// `/api/files/<id>` of a private record's file into it and then download
// the file. Copies of records get files of their own (lib/row-transfer.ts),
// so the same file in a hidden and a visible record means a reference was
// written by hand or came from a record template. Such a file stays hidden
// when it was uploaded for the hidden record – by whoever created it or
// holds a grant on it, or by nobody known (form and shared uploads) – and is
// shown when the person uploaded it themselves, when it was uploaded by
// someone else unrelated to the hidden record (a file of a visible record
// that somebody also used in their private one), or when its uploader put
// it into a record template of the database.
export async function hiddenRowFileIds(user: Identity, page: Pick<Page, "id" | "kind" | "workspace_id"> & Partial<Page>): Promise<Set<string>> {
  if (page.kind !== "database") return new Set();
  const hidden = await hiddenRowIds(user, page as Page);
  const inHidden = new Map<string, HiddenUse>(),
    inVisible = new Set<string>();
  const use = (file: string) => {
    let entry = inHidden.get(file);
    if (!entry) inHidden.set(file, (entry = { users: new Set(), groups: new Set(), always: false }));
    return entry;
  };
  // Records in the trash keep their permissions too.
  for (const trashed of await all<{ payload: string }>(
    "SELECT payload FROM row_trash WHERE page_id=? AND payload LIKE '%/api/files/%'",
    page.id,
  )) {
    const payload = JSON.parse(trashed.payload) as Parameters<typeof trashedRole>[2];
    if (await trashedRole(user, page as Page, payload)) continue;
    for (const id of ids(trashed.payload)) {
      const entry = use(id);
      if (payload.row?.created_by) entry.users.add(String(payload.row.created_by));
      for (const grant of payload.grants || []) {
        if (grant.user_id) entry.users.add(grant.user_id);
        if (grant.group_id) entry.groups.add(grant.group_id);
      }
    }
  }
  // Files in properties hidden from this person (lib/field-access.ts).
  const hiddenFields = await hiddenFieldsFor(user, page as Page);
  if (!hidden.size && !inHidden.size && !hiddenFields.size) return new Set();
  const hiddenRowsOf = new Map<string, string[]>();
  for (const row of await all<{ id: string; cells: string; text: string; created_by: string | null }>(
    `SELECT r.id,r.cells,r.created_by,COALESCE(r.icon,'')||' '||COALESCE(r.cover,'')||' '||COALESCE(r.content,'')||' '||COALESCE(d.html,'') text
     FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.page_id=?`,
    page.id,
  )) {
    let cells = row.cells;
    if (hiddenFields.size && cells.includes("/api/files/")) {
      const parsed = JSON.parse(cells) as Record<string, unknown>;
      for (const key of hiddenFields) for (const id of ids(JSON.stringify(parsed[key] ?? ""))) use(id).always = true;
      cells = stripCells(cells, hiddenFields);
    }
    const found = ids(`${cells} ${row.text}`);
    if (!hidden.has(row.id)) {
      for (const id of found) inVisible.add(id);
      continue;
    }
    for (const id of found) {
      const entry = use(id);
      if (row.created_by) entry.users.add(row.created_by);
      hiddenRowsOf.set(id, [...(hiddenRowsOf.get(id) || []), row.id]);
    }
  }
  const result = new Set<string>();
  for (const [id, entry] of inHidden) {
    if (!inVisible.has(id)) result.add(id);
    else if (await uploadedForHidden(user, page.id, id, entry, hiddenRowsOf.get(id) || [])) result.add(id);
  }
  return result;
}

// Whether a file used by hidden records and by visible ones belongs to the
// hidden ones (see above).
async function uploadedForHidden(user: Identity, pageId: string, fileId: string, entry: HiddenUse, hiddenRows: string[]) {
  const file = await one<{ created_by: string | null }>("SELECT created_by FROM files WHERE id=?", fileId);
  const uploader = file?.created_by ?? null;
  if (uploader && uploader === user.id) return false;
  // A file its uploader put into a record template of the database: records
  // made from it carry it, private ones and others alike.
  if (
    uploader &&
    (await one(
      `SELECT 1 FROM row_templates WHERE page_id=? AND created_by=? AND (${sql.instr("cells", "?")}>0 OR ${sql.instr("html", "?")}>0)`,
      pageId,
      uploader,
      `/api/files/${fileId}`,
      `/api/files/${fileId}`,
    ))
  )
    return false;
  if (entry.always || !uploader || entry.users.has(uploader)) return true;
  if (hiddenRows.length) {
    const grants = await all<{ user_id: string | null; group_id: string | null }>(
      `SELECT user_id,group_id FROM row_grants WHERE row_id IN (${hiddenRows.map(() => "?").join(",")})`,
      ...hiddenRows,
    );
    for (const grant of grants) {
      if (grant.user_id) entry.users.add(grant.user_id);
      if (grant.group_id) entry.groups.add(grant.group_id);
    }
    if (entry.users.has(uploader)) return true;
  }
  if (!entry.groups.size) return false;
  const groups = [...entry.groups];
  return !!(await one(
    `SELECT 1 FROM group_members WHERE user_id=? AND group_id IN (${groups.map(() => "?").join(",")})`,
    uploader,
    ...groups,
  ));
}
