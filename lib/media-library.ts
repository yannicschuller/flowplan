import { all } from "./db";
import { pageRole, requireMember } from "./permissions";
import type { Identity, Page } from "./types";

export type MediaKind = "all" | "image" | "video" | "audio" | "pdf" | "other";
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

// Files of all pages the person can read in a workspace, newest first.
export function mediaLibrary(
  user: Identity,
  workspaceId: string,
  options: { kind?: MediaKind; query?: string; offset?: number } = {},
) {
  requireMember(user, workspaceId);
  const kind = options.kind || "all",
    query = (options.query || "").trim().slice(0, 200),
    offset = Math.max(0, Math.floor(options.offset || 0));
  const rows = all<
    Page & {
      file_id: string;
      file_name: string;
      mime: string;
      size: number;
      file_created: string;
    }
  >(
    `SELECT p.*,f.id file_id,f.name file_name,f.mime,f.size,f.created_at file_created
     FROM files f JOIN pages p ON p.id=f.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL
     ${kind === "all" ? "" : `AND ${kindSql[kind]}`}
     ${query ? "AND instr(lower(f.name),lower(?))>0" : ""}
     ORDER BY f.created_at DESC,f.rowid DESC LIMIT 5000`,
    workspaceId,
    ...(query ? [query] : []),
  );
  const readable = new Map<string, boolean>();
  const items: MediaItem[] = [];
  for (const row of rows) {
    if (!readable.has(row.id)) readable.set(row.id, !!pageRole(user, row));
    if (!readable.get(row.id)) continue;
    items.push({
      id: row.file_id,
      name: row.file_name || "Datei",
      mime: row.mime || "application/octet-stream",
      size: Number(row.size || 0),
      created_at: row.file_created,
      url: `/api/files/${row.file_id}`,
      pageId: row.id,
      pageTitle: row.title,
      kind: kindOf(row.mime || ""),
    });
  }
  return {
    items: items.slice(offset, offset + MEDIA_PAGE),
    total: items.length,
    bytes: items.reduce((sum, i) => sum + i.size, 0),
  };
}
