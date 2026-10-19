import * as Y from "yjs";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage, spaceRole } from "./permissions";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage, maxUploadMbFor } from "./user-limits";
import { verifiedMime } from "./upload-safety";
import { createPage } from "./seed";
import { writeWhiteboard } from "./whiteboard";
import {
  BOARD_IMPORT_LIMITS,
  BoardImportError,
  IMPORT_IMAGE_PREFIX,
  parseBoardFile,
  placeDrafts,
  resolveImages,
  type ImportedBoard,
} from "./whiteboard-import";
import type { Identity, Space } from "./types";

// Excalidraw and draw.io files onto whiteboards: parsed by
// lib/whiteboard-import.ts, embedded pictures stored as files of the page
// (within the person's upload, storage and workspace limits).
export async function readBoard(name: string, bytes: Buffer): Promise<ImportedBoard> {
  if (bytes.length > BOARD_IMPORT_LIMITS.bytes)
    throw new HttpError(413, "Die Datei ist zu groß (höchstens 20 MB).");
  try {
    return await parseBoardFile(name, bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof BoardImportError) throw new HttpError(400, error.message);
    throw error;
  }
}

// Inside a transaction: the board's pictures as files of the page; returns
// their addresses by reference ("import:img1" → "/api/files/…"). Pictures
// beyond the limits are left out (they become notes).
export function storeBoardImages(
  user: Identity,
  pageId: string,
  workspaceId: string,
  board: ImportedBoard,
  added = { bytes: 0 },
) {
  const urls = new Map<string, string>();
  if (!board.images.length) return urls;
  const maxFile = maxUploadMbFor(user) * 1024 * 1024;
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  mkdirSync(dir, { recursive: true });
  for (const image of board.images) {
    const data = Buffer.from(image.data);
    if (data.length > maxFile || verifiedMime(image.mime, data) !== image.mime) continue;
    enforceQuota(workspaceId, added.bytes + data.length);
    enforceUserStorage(user, added.bytes + data.length);
    added.bytes += data.length;
    const fid = id();
    writeFileSync(resolve(dir, fid), data);
    onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      fid,
      pageId,
      `${image.id}.${image.mime.split("/")[1].replace("jpeg", "jpg")}`,
      image.mime,
      data.length,
      user.id,
    );
    urls.set(IMPORT_IMAGE_PREFIX + image.id, `/api/files/${fid}`);
  }
  return urls;
}

// The Yjs state of a new board holding the imported items.
export function boardState(board: ImportedBoard, urls: Map<string, string>) {
  const doc = new Y.Doc();
  try {
    const map = doc.getMap<Y.Map<unknown>>("items");
    for (const item of placeDrafts(board.items, { newId: id, image: (ref) => urls.get(ref) ?? null })) {
      const entry = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(item))
        if (key !== "id" && value !== undefined) entry.set(key, value);
      map.set(item.id, entry);
    }
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
export function boardTitle(name: string) {
  return (
    name
      .replace(/\.(excalidraw|drawio)(\.json|\.xml|\.svg)?$/i, "")
      .replace(/\.(json|xml|svg)$/i, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200) || "Whiteboard"
  );
}

const target = z.union([
  z.object({ pageId: z.uuid() }),
  z.object({ workspaceId: z.uuid(), spaceId: z.uuid(), parentId: z.uuid().optional() }),
]);
// pageId: items for an existing board, which the board places itself
// (images already stored). Otherwise a new whiteboard page is created.
export async function importWhiteboardFile(
  user: Identity,
  name: string,
  bytes: Buffer,
  raw: Record<string, unknown>,
) {
  const where = target.parse(raw);
  if ("pageId" in where) {
    const page = requirePage(user, where.pageId, true);
    if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
    if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    const board = await readBoard(name, bytes);
    return transaction(() => {
      const urls = storeBoardImages(user, page.id, page.workspace_id, board);
      return {
        format: board.format,
        replaced: board.replaced,
        items: resolveImages(board.items, (ref) => urls.get(ref) ?? null),
      };
    }, user);
  }
  requireMember(user, where.workspaceId, "editor");
  const space = one<Space>(
    "SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL",
    where.spaceId,
    where.workspaceId,
  );
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || ""))
    throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  if (where.parentId) {
    const parent = requirePage(user, where.parentId, true);
    if (parent.space_id !== space.id)
      throw new HttpError(400, "Übergeordnete Seite liegt in anderem Bereich.");
  }
  const board = await readBoard(name, bytes);
  return transaction(() => {
    const pageId = createPage(where.workspaceId, space.id, user.id, boardTitle(name), "whiteboard", where.parentId || null);
    const urls = storeBoardImages(user, pageId, where.workspaceId, board);
    writeWhiteboard(pageId, boardState(board, urls));
    return { pageId, format: board.format, replaced: board.replaced, items: board.items.length };
  }, user);
}
