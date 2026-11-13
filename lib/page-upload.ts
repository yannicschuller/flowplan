// Stores an upload of a page (POST /api/upload, images from the image
// search): the workspace quota and the person's storage are checked again
// together with the insert, in one transaction, so parallel uploads take
// turns (enforceQuota, enforceUserStorage) instead of all passing against
// the same "used". Checks before reading the body only refuse early. A
// refused upload leaves no file behind.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit, onTransactionRollback, run, transaction } from "./db";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import type { Identity, Page } from "./types";

export async function storeUpload(
  user: Identity,
  page: Pick<Page, "id" | "workspace_id">,
  file: { id: string; name: string; mime: string; content: Buffer },
) {
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads"),
    path = resolve(dir, file.id);
  mkdirSync(dir, { recursive: true });
  await transaction(async () => {
    await enforceQuota(page.workspace_id, file.content.length);
    await enforceUserStorage(user, file.content.length, page.workspace_id);
    // Synchronous: a SQLite transaction awaits only the database.
    writeFileSync(path, file.content, { flag: "wx" });
    onTransactionRollback(() => {
      try {
        unlinkSync(path);
      } catch {}
    });
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      file.id,
      page.id,
      file.name,
      file.mime,
      file.content.length,
      user.id,
    );
    await audit(user.id, "file.upload", page.id, file.name);
  }, user);
}
