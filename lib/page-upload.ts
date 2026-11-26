// Stores an upload of a page (POST /api/upload, images from the image
// search): the workspace quota and the person's storage are checked again
// together with the insert, in one transaction, so parallel uploads take
// turns (enforceQuota, enforceUserStorage) instead of all passing against
// the same "used". Checks before reading the body only refuse early. A
// refused upload leaves no file behind.
// Large uploads (lib/multipart-stream.ts) arrive as a temporary file:
// storeUploadFile moves it into place instead of writing bytes.
import { linkSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit, onTransactionRollback, run, transaction } from "./db";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import type { Identity, Page } from "./types";
import { publishUpload, unpublishUpload, uploadPath, uploadsDir } from "./storage";

// The page a file belongs to: an existing one, or one made for it in the
// same transaction, after the quota checks (a page made from a file,
// lib/file-pages.ts) – a refusal leaves neither page nor file.
export type UploadOwner = Pick<Page, "id" | "workspace_id"> | { workspace_id: string; create: () => Promise<string> };

export async function storeUpload(
  user: Identity,
  page: UploadOwner,
  file: { id: string; name: string; mime: string; content: Buffer },
) {
  return await store(user, page, { id: file.id, name: file.name, mime: file.mime, size: file.content.length }, (path) =>
    // Synchronous: a SQLite transaction awaits only the database.
    writeFileSync(path, file.content, { flag: "wx" }),
  );
}

// The same for a file already on disk (a temporary file in the same file
// system, lib/multipart-stream.ts): linked into place – nothing is read or
// copied, whatever its size – and the temporary name removed. In cluster
// mode the object goes into the bucket before the transaction, not inside
// it (a large file would keep the transaction open for minutes); a refusal
// afterwards removes it again. The caller keeps its temporary file on any
// failure before the link (and discards it).
export async function storeUploadFile(
  user: Identity,
  page: UploadOwner,
  file: { id: string; name: string; mime: string; size: number; path: string },
) {
  const path = uploadPath(file.id);
  mkdirSync(uploadsDir(), { recursive: true });
  // Fails when the name is taken (like the "wx" flag).
  linkSync(file.path, path);
  rmSync(file.path, { force: true });
  try {
    await publishUpload(file.id);
    return await store(user, page, file, null);
  } catch (error) {
    rmSync(path, { force: true });
    await unpublishUpload(file.id).catch(() => {});
    throw error;
  }
}

async function store(
  user: Identity,
  page: UploadOwner,
  file: { id: string; name: string; mime: string; size: number },
  // Writes the file inside the transaction (null: it is in place already).
  write: ((path: string) => void) | null,
) {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads"),
    path = resolve(dir, file.id);
  mkdirSync(dir, { recursive: true });
  // The id of the page the file now belongs to.
  return await transaction(async () => {
    await enforceQuota(page.workspace_id, file.size);
    await enforceUserStorage(user, file.size);
    const pageId = "create" in page ? await page.create() : page.id;
    if (write) {
      // Fails when the name is taken (like the "wx" flag).
      write(path);
      onTransactionRollback(() => {
        try {
          unlinkSync(path);
        } catch {}
      });
      // Cluster mode: into the bucket before the answer (lib/storage.ts).
      await publishUpload(file.id);
    }
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      file.id,
      pageId,
      file.name,
      file.mime,
      file.size,
      user.id,
    );
    await audit(user.id, "file.upload", pageId, file.name);
    return pageId;
  }, user);
}
