// Files in the trash (#164). "Delete" in the media library moves a file to
// the trash: its row, upload and derived data stay, with files.deleted_at
// set. From then on it is hidden like a file of a private record
// (lib/row-files.ts hiddenFileIds): not served, not listed, not searched,
// not copied or exported; documents that still show it get a missing-image
// placeholder. "Restore" brings it back unchanged. It goes for good – row,
// upload (pending_file_deletions, lib/db.ts), the object storage copy
// (storage_queue trigger, lib/storage.ts), extracted text, handwriting,
// placeholder and search entries – when it is deleted permanently from the
// trash, the trash is emptied, or the trash period ends (lib/trash.ts).
// Removing an image from a document never deletes the file by itself.
//
// Rights: those who may edit the file's page, full members only
// (mayDeleteFiles in lib/media-library.ts); private pages and records,
// journals behind a PIN and guests keep their protections.
import { z } from "zod";
import { all, audit, nowText, one, run, transaction } from "./db";
import { removeEntry } from "./search-store";
import { HttpError } from "./auth";
import { pageRole, requireMember } from "./permissions";
import { journalLocked, lockedPageIds } from "./journal-extras";
import { hiddenFileIds, hiddenRowFileIds } from "./row-files";
import { mayDeleteFiles, mediaEntries } from "./media-library";
import type { Identity, Page } from "./types";

const uuid = z.string().uuid();
export const MAX_FILES_PER_DELETE = 500;
type FileRow = { id: string; page_id: string; name: string; mime: string; size: number; deleted_at: string | null };

// The file with its page, if this person may see it. Hidden files (other
// people's private records, journals behind a PIN, unreadable pages) are
// simply missing.
async function visibleFile(user: Identity, fileId: string, trashed: boolean) {
  const file = await one<FileRow>("SELECT id,page_id,name,mime,size,deleted_at FROM files WHERE id=?", fileId);
  if (!file || !!file.deleted_at !== trashed) throw new HttpError(404, "Datei fehlt.");
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", file.page_id);
  if (!page || page.deleted_at || !(await pageRole(user, page)) || (await journalLocked(user, page)))
    throw new HttpError(404, "Datei fehlt.");
  const hidden = trashed ? await hiddenRowFileIds(user, page) : await hiddenFileIds(user, page);
  if (hidden.has(file.id)) throw new HttpError(404, "Datei fehlt.");
  return { file, page };
}
async function requireDeletable(user: Identity, page: Page) {
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (!(await mayDeleteFiles(user, page))) throw new HttpError(403, "Keine Berechtigung für diese Seite.");
}
const reindex = (file: Pick<FileRow, "id" | "page_id">) =>
  run("INSERT INTO search_dirty(page_id,row_id) VALUES(?,?) ON CONFLICT DO NOTHING", file.page_id, `f:${file.id}`);
async function trash(user: Identity, file: FileRow) {
  await run("UPDATE files SET deleted_at=?,deleted_by=? WHERE id=?", nowText(), user.id, file.id);
  await reindex(file);
  await audit(user.id, "file.trashed", file.id, file.name);
}

// file.delete: files into the trash, all or none.
export async function trashFiles(user: Identity, input: Record<string, unknown>) {
  const ids = [...new Set(z.array(uuid).min(1).max(MAX_FILES_PER_DELETE).parse(input.fileIds))];
  return await transaction(async () => {
    const found = [];
    for (const fid of ids) found.push(await visibleFile(user, fid, false));
    for (const { page } of found) await requireDeletable(user, page);
    for (const { file } of found) await trash(user, file);
    return { ok: true, files: found.length };
  });
}

// files.deleteUnused: every unused file of the media library's current
// filter (type, name) this person may delete, into the trash.
export async function trashUnusedFiles(user: Identity, input: Record<string, unknown>) {
  const workspaceId = uuid.parse(input.workspaceId);
  await requireMember(user, workspaceId, "editor");
  const kind = z.enum(["all", "image", "video", "audio", "pdf", "other"]).catch("all").parse(input.kind ?? "all");
  const query = z.string().max(200).catch("").parse(input.query ?? "");
  const entries = (await mediaEntries(user, workspaceId, { kind, query })).filter((e) => e.unused && e.canDelete);
  await transaction(async () => {
    for (const entry of entries)
      await trash(user, { id: entry.id, page_id: entry.pageId, name: entry.name, mime: entry.mime, size: entry.size, deleted_at: null });
    if (entries.length) await audit(user.id, "files.trashedUnused", workspaceId, `${entries.length} files`);
  });
  return { ok: true, files: entries.length };
}

// file.restore: back from the trash, unchanged.
export async function restoreFile(user: Identity, input: Record<string, unknown>) {
  const { file, page } = await visibleFile(user, uuid.parse(input.fileId), true);
  await requireDeletable(user, page);
  await run("UPDATE files SET deleted_at=NULL,deleted_by=NULL WHERE id=?", file.id);
  await reindex(file);
  await audit(user.id, "file.restored", file.id, file.name);
  return { ok: true };
}

// Deletes files for good. Inside a transaction; the upload is removed once
// it commits (pending_file_deletions), the object storage copy by the
// storage worker (trigger on files); extracted text, handwriting and guest
// upload marks go with the row (foreign keys).
export async function purgeFiles(files: Pick<FileRow, "id" | "page_id">[]) {
  for (const file of files) {
    await run("INSERT INTO pending_file_deletions(id) VALUES(?) ON CONFLICT DO NOTHING", file.id);
    await removeEntry(file.page_id, `f:${file.id}`);
    await run("DELETE FROM files WHERE id=?", file.id);
  }
}

// file.purge: one file from the trash, for good.
export async function purgeTrashedFile(user: Identity, input: Record<string, unknown>) {
  const { file, page } = await visibleFile(user, uuid.parse(input.fileId), true);
  await requireDeletable(user, page);
  await transaction(async () => {
    await purgeFiles([file]);
    await audit(user.id, "file.purged", file.id, file.name);
  });
  return { ok: true };
}

export type TrashedFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  pageId: string;
  pageTitle: string;
  deletedAt: string;
};
// Files in the trash of a workspace this person may restore or delete.
// Those of pages in the trash go with their page and are not listed.
export async function listFileTrash(user: Identity, workspaceId: string): Promise<TrashedFile[]> {
  await requireMember(user, workspaceId);
  const locked = await lockedPageIds(user, workspaceId);
  const rows = await all<Page & { file_id: string; file_name: string; mime: string; size: number; file_deleted: string }>(
    `SELECT p.*,f.id file_id,f.name file_name,f.mime,f.size,f.deleted_at file_deleted
     FROM files f JOIN pages p ON p.id=f.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND f.deleted_at IS NOT NULL
     ORDER BY f.deleted_at DESC,f.seq DESC LIMIT 2000`,
    workspaceId,
  );
  const allowed = new Map<string, boolean>(),
    hidden = new Map<string, Set<string>>();
  const out: TrashedFile[] = [];
  for (const row of rows) {
    if (!allowed.has(row.id)) allowed.set(row.id, !locked.has(row.id) && (await mayDeleteFiles(user, row)));
    if (!allowed.get(row.id)) continue;
    if (!hidden.has(row.id)) hidden.set(row.id, await hiddenRowFileIds(user, row));
    if (hidden.get(row.id)!.has(row.file_id)) continue;
    out.push({
      id: row.file_id,
      name: row.file_name || "Datei",
      mime: row.mime || "application/octet-stream",
      size: Number(row.size || 0),
      pageId: row.id,
      pageTitle: row.title,
      deletedAt: row.file_deleted,
    });
  }
  return out;
}

// Retention (lib/trash.ts expireTrash): files longer than `days` in the
// trash (`cutoff`: daysAgoText(days)). Inside a transaction.
export async function expireTrashedFiles(cutoff: string) {
  const files = await all<Pick<FileRow, "id" | "page_id">>(
    "SELECT id,page_id FROM files WHERE deleted_at IS NOT NULL AND deleted_at<?",
    cutoff,
  );
  await purgeFiles(files);
  return files.length;
}
