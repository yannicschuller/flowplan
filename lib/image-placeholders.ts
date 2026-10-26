// Placeholders of uploaded images: the size the image is shown in and a
// ThumbHash (lib/thumbhash.ts) – a blurred picture of about 25 bytes the
// browser shows in the right proportions until the image has loaded
// (components/file-image.tsx). Computed once from the file (lib/image-decode.ts):
// at upload, otherwise the first time someone asks for it. Stored with the
// file (files.width, files.height, files.thumbhash: NULL not computed yet,
// '' nothing to show) and for profile pictures in user_avatars.
//
// Files of end-to-end encrypted spaces are never looked into: the server
// holds only their ciphertext, and a hash would be a picture of the
// plaintext. Who may see a placeholder follows the file itself (the same
// rules as GET /api/files/<id>); everything else is left out of the answer,
// indistinguishable from a file that does not exist.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { all, one, run } from "./db";
import { avatarFor } from "./avatars";
import { decodeImageInSlices } from "./image-decode";
import { isEncryptedPage } from "./e2ee-server";
import { requireUnlocked } from "./journal-extras";
import { requirePage } from "./permissions";
import { hiddenFileIds } from "./row-files";
import { ensureLocal, storageConfig } from "./storage";
import { rgbaToThumbHash, thumbHashToBase64 } from "./thumbhash";
import type { Identity, Page } from "./types";

export type Placeholder = { width: number; height: number; hash: string | null };
/** What the browser gets: width, height and (when there is one) the hash. */
export type PlaceholderInfo = { w: number; h: number; hash?: string };

/** Types with a size we can read; all but AVIF and HEIC also get a hash. */
export const PLACEHOLDER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic"];
/** Larger files keep no placeholder (the upload limit may be higher). */
const MAX_BYTES = 40 * 1024 * 1024;
/** How long a request waits for placeholders that are still missing. */
const WAIT_MS = 400;
/** At most this many per request. */
export const MAX_PLACEHOLDER_IDS = 100;

/** Size and hash of an image's bytes (null when it is not an image we read). */
export async function computePlaceholder(data: Uint8Array): Promise<Placeholder | null> {
  const decoded = await decodeImageInSlices(data);
  if (!decoded) return null;
  const small = decoded.small;
  const hash = small ? thumbHashToBase64(rgbaToThumbHash(small.width, small.height, small.rgba)) : null;
  return { width: decoded.width, height: decoded.height, hash };
}

type FileRow = { id: string; page_id: string | null; mime: string; size: number; thumbhash: string | null; width: number | null; height: number | null };

const info = (row: { width: number | null; height: number | null; thumbhash: string | null }): PlaceholderInfo | null =>
  row.width && row.height ? { w: row.width, h: row.height, ...(row.thumbhash ? { hash: row.thumbhash } : {}) } : null;

// Plaintext images only: an encrypted space's files (and anything stored as
// a plain download) are skipped without being read.
function eligible(file: Pick<FileRow, "mime" | "page_id">) {
  if (!PLACEHOLDER_TYPES.includes(file.mime) || !file.page_id) return false;
  const page = one<Pick<Page, "space_id">>("SELECT space_id FROM pages WHERE id=?", file.page_id);
  return !!page && !isEncryptedPage(page);
}

/** Stores what an upload computed (its bytes are at hand already). */
export function storePlaceholder(fileId: string, placeholder: Placeholder | null) {
  // Checked again on storing: the space may have been encrypted meanwhile.
  const file = one<FileRow>("SELECT id,page_id,mime FROM files WHERE id=?", fileId);
  if (!file) return;
  const keep = placeholder && eligible(file) ? placeholder : null;
  run(
    "UPDATE files SET width=?,height=?,thumbhash=? WHERE id=?",
    keep?.width ?? null,
    keep?.height ?? null,
    keep?.hash ?? "",
    fileId,
  );
}

/** The placeholder of a new upload, computed from its bytes and stored.
 *  Never throws: an upload does not fail for its placeholder. */
export async function placeholderForUpload(fileId: string, mime: string, pageId: string, data: Uint8Array): Promise<PlaceholderInfo | null> {
  try {
    const wanted = eligible({ mime, page_id: pageId }) && data.length <= MAX_BYTES;
    storePlaceholder(fileId, wanted ? await computePlaceholder(data) : null);
  } catch (error) {
    console.error("Platzhalter konnte nicht berechnet werden:", (error as Error).message);
    return null;
  }
  const row = one<FileRow>("SELECT width,height,thumbhash FROM files WHERE id=?", fileId);
  return row ? info(row) : null;
}

// ---- computing later (files from before, copies, imports) ----

const state = globalThis as typeof globalThis & {
  flowplanPlaceholders?: { pending: Map<string, Promise<void>>; queue: Promise<void> };
};
function queueState() {
  return (state.flowplanPlaceholders ??= { pending: new Map(), queue: Promise.resolve() });
}

async function backfillFile(fileId: string) {
  const file = one<FileRow>("SELECT id,page_id,mime,size,thumbhash FROM files WHERE id=?", fileId);
  if (!file || file.thumbhash !== null) return;
  if (!eligible(file) || file.size > MAX_BYTES) return storePlaceholder(file.id, null);
  // Not here: gone for good, unless the bucket may still have it (asked again later).
  if (!(await ensureLocal(file.id))) return storageConfig() ? undefined : storePlaceholder(file.id, null);
  const data = await readFile(resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads", file.id));
  storePlaceholder(file.id, await computePlaceholder(data));
}

/** Computes the placeholder of a file without one, one file at a time;
 *  the same file is never computed twice at once. */
export function backfillPlaceholder(fileId: string): Promise<void> {
  const s = queueState();
  const running = s.pending.get(fileId);
  if (running) return running;
  const job = s.queue
    .then(() => backfillFile(fileId))
    .catch((error) => {
      console.error("Platzhalter konnte nicht berechnet werden:", (error as Error).message);
      try {
        storePlaceholder(fileId, null);
      } catch {
        /* the file is gone */
      }
    })
    .finally(() => s.pending.delete(fileId));
  s.pending.set(fileId, job);
  s.queue = job;
  return job;
}

// ---- who may see what ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids of the given files this person may open (as GET /api/files/<id>). */
export function readableFileIds(user: Identity, ids: string[]): Map<string, FileRow> {
  const wanted = [...new Set(ids.filter((x) => UUID.test(x)))].slice(0, MAX_PLACEHOLDER_IDS);
  const readable = new Map<string, FileRow>();
  if (!wanted.length) return readable;
  const files = all<FileRow>(
    `SELECT id,page_id,mime,size,thumbhash,width,height FROM files WHERE id IN (${wanted.map(() => "?").join(",")})`,
    ...wanted,
  );
  const byPage = new Map<string, FileRow[]>();
  for (const file of files) if (file.page_id) byPage.set(file.page_id, [...(byPage.get(file.page_id) || []), file]);
  for (const [pageId, list] of byPage) {
    let page: Page;
    try {
      page = requirePage(user, pageId);
      requireUnlocked(user, page);
    } catch {
      continue;
    }
    // Encrypted spaces: nothing, not even the size.
    if (isEncryptedPage(page)) continue;
    const hidden = hiddenFileIds(user, page);
    for (const file of list) if (!hidden.has(file.id)) readable.set(file.id, file);
  }
  return readable;
}

/** Placeholders of files ("<file id>") and profile pictures ("avatar:<user
 *  id>") for this person; ones still missing are computed, waiting a
 *  moment for them. Entries without a placeholder are left out. */
export async function placeholdersFor(user: Identity, keys: string[], waitMs = WAIT_MS) {
  const fileKeys = keys.filter((k) => !k.startsWith("avatar:"));
  const avatarKeys = keys.filter((k) => k.startsWith("avatar:")).slice(0, MAX_PLACEHOLDER_IDS);
  let files = readableFileIds(user, fileKeys);
  const missing = [...files.values()].filter((f) => f.thumbhash === null).map((f) => backfillPlaceholder(f.id));
  if (missing.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(missing), new Promise((done) => (timer = setTimeout(done, waitMs)))]);
    clearTimeout(timer);
    // Read again, with the same rules (they may have changed meanwhile).
    files = readableFileIds(user, fileKeys);
  }
  const result: Record<string, PlaceholderInfo> = {};
  for (const [fileId, file] of files) {
    const entry = info(file);
    if (entry) result[fileId] = entry;
  }
  for (const key of avatarKeys) {
    const userId = key.slice("avatar:".length);
    if (!UUID.test(userId) || !avatarFor(user, userId)) continue;
    const row = one<{ width: number | null; height: number | null; thumbhash: string | null }>(
      "SELECT width,height,thumbhash FROM user_avatars WHERE user_id=?",
      userId,
    );
    if (row && row.thumbhash === null) await avatarPlaceholder(userId);
    const fresh = one<{ width: number | null; height: number | null; thumbhash: string | null }>(
      "SELECT width,height,thumbhash FROM user_avatars WHERE user_id=?",
      userId,
    );
    const entry = fresh && info(fresh);
    if (entry) result[key] = entry;
  }
  return result;
}

/** The placeholder of a profile picture (small images: computed at once). */
export async function avatarPlaceholder(userId: string) {
  const row = one<{ data: Uint8Array }>("SELECT data FROM user_avatars WHERE user_id=?", userId);
  if (!row) return;
  let placeholder: Placeholder | null = null;
  try {
    placeholder = await computePlaceholder(row.data);
  } catch {
    placeholder = null;
  }
  run(
    "UPDATE user_avatars SET width=?,height=?,thumbhash=? WHERE user_id=?",
    placeholder?.width ?? null,
    placeholder?.height ?? null,
    placeholder?.hash ?? "",
    userId,
  );
}
