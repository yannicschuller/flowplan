import { all } from "./db";
import { isGuest, memberRole, pageRole, requireMember } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { hiddenFileIds } from "./row-files";
import { usedFileIds } from "./file-usage";
import type { Identity, Page } from "./types";

export type MediaKind = "all" | "image" | "video" | "audio" | "pdf" | "other";
export type MediaUsage = "all" | "unused";
export type MediaItem = {
  id: string;
  name: string;
  mime: string;
  size: number;
  created_at: string;
  url: string;
  pageId: string;
  pageTitle: string;
  kind: Exclude<MediaKind, "all">;
  // Not referenced by any current content (lib/file-usage.ts); never for
  // files of end-to-end encrypted spaces (their content is not readable).
  unused: boolean;
  // This person may move it to the trash (lib/file-trash.ts).
  canDelete: boolean;
};
export const MEDIA_PAGE = 60;
const kindOf = (mime: string): MediaItem["kind"] =>
  mime.startsWith("image/")
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : mime === "application/pdf"
          ? "pdf"
          : "other";
const kindSql: Record<Exclude<MediaKind, "all">, string> = {
  image: "f.mime LIKE 'image/%'",
  video: "f.mime LIKE 'video/%'",
  audio: "f.mime LIKE 'audio/%'",
  pdf: "f.mime='application/pdf'",
  other:
    "f.mime NOT LIKE 'image/%' AND f.mime NOT LIKE 'video/%' AND f.mime NOT LIKE 'audio/%' AND f.mime<>'application/pdf'",
};

// May this person delete files of the page (move them to the trash, restore
// or delete them for good)? The same right as editing the page, for full
// members only: guests, viewers and read-only tokens never; a locked page
// keeps its files.
export function mayDeleteFiles(user: Identity, page: Page) {
  if (page.deleted_at || page.locked || user.apiScope === "read") return false;
  const member = memberRole(user, page.workspace_id);
  if (!member || member === "viewer" || isGuest(user, page.workspace_id)) return false;
  const role = pageRole(user, page);
  return role === "editor" || role === "owner";
}

type Entry = MediaItem & { page: Page };
// Every file of the workspace this person may see (readable page outside
// the trash, no journal behind a PIN, not of a hidden record, not in the
// trash), newest first, with whether it is used and may be deleted.
export function mediaEntries(
  user: Identity,
  workspaceId: string,
  options: { kind?: MediaKind; query?: string } = {},
): Entry[] {
  requireMember(user, workspaceId);
  const kind = options.kind || "all",
    query = (options.query || "").trim().slice(0, 200);
  const rows = all<
    Page & {
      file_id: string;
      file_name: string;
      mime: string;
      size: number;
      file_created: string;
      encrypted: number | null;
    }
  >(
    `SELECT p.*,f.id file_id,f.name file_name,f.mime,f.size,f.created_at file_created,s.encrypted
     FROM files f JOIN pages p ON p.id=f.page_id LEFT JOIN spaces s ON s.id=p.space_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND f.deleted_at IS NULL
     ${kind === "all" ? "" : `AND ${kindSql[kind]}`}
     ${query ? "AND instr(lower(f.name),lower(?))>0" : ""}
     ORDER BY f.created_at DESC,f.rowid DESC LIMIT 5000`,
    workspaceId,
    ...(query ? [query] : []),
  );
  const readable = new Map<string, boolean>(),
    deletable = new Map<string, boolean>(),
    hiddenFiles = new Map<string, Set<string>>(),
    locked = lockedPageIds(user, workspaceId);
  const visible: (typeof rows)[number][] = [];
  for (const row of rows) {
    if (!readable.has(row.id)) readable.set(row.id, !locked.has(row.id) && !!pageRole(user, row));
    if (!readable.get(row.id)) continue;
    if (!hiddenFiles.has(row.id)) hiddenFiles.set(row.id, hiddenFileIds(user, row));
    if (hiddenFiles.get(row.id)!.has(row.file_id)) continue;
    visible.push(row);
  }
  const used = usedFileIds(
    workspaceId,
    visible.filter((row) => !row.encrypted).map((row) => row.file_id),
  );
  return visible.map((row) => {
    const { file_id, file_name, mime, size, file_created, encrypted, ...page } = row;
    if (!deletable.has(page.id)) deletable.set(page.id, mayDeleteFiles(user, page as Page));
    return {
      id: file_id,
      name: file_name || "Datei",
      mime: mime || "application/octet-stream",
      size: Number(size || 0),
      created_at: file_created,
      url: `/api/files/${file_id}`,
      pageId: page.id,
      pageTitle: page.title,
      kind: kindOf(mime || ""),
      unused: !encrypted && !used.has(file_id.toLowerCase()),
      canDelete: deletable.get(page.id)!,
      page: page as Page,
    };
  });
}

// Files of all pages the person can read in a workspace, newest first.
export function mediaLibrary(
  user: Identity,
  workspaceId: string,
  options: { kind?: MediaKind; query?: string; offset?: number; usage?: MediaUsage } = {},
) {
  const offset = Math.max(0, Math.floor(options.offset || 0));
  const entries = mediaEntries(user, workspaceId, options);
  const unused = entries.filter((e) => e.unused);
  const shown = options.usage === "unused" ? unused : entries;
  const items: MediaItem[] = shown
    .slice(offset, offset + MEDIA_PAGE)
    .map(({ page: _page, ...item }) => item);
  return {
    items,
    total: shown.length,
    bytes: shown.reduce((sum, i) => sum + i.size, 0),
    // Unused files under the same type and name filter, and those of them
    // this person may delete ("Delete all unused").
    unused: unused.length,
    unusedDeletable: unused.filter((e) => e.canDelete).length,
  };
}
