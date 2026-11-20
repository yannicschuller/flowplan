// Who may read an uploaded file (GET /api/files/<id>): whoever may read its
// page, with a journal behind a PIN unlocked, unless only a record hidden
// from them uses it. The download and the HTML preview (#398) both ask here.
import { one } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { hiddenFileIds } from "./row-files";
import type { Identity } from "./types";

export type StoredFile = { id: string; page_id: string; name: string; mime: string };

export async function readableFile(user: Identity, fileId: string): Promise<StoredFile> {
  const file = await one<StoredFile>("SELECT * FROM files WHERE id=?", fileId);
  if (!file) throw new HttpError(404, "Datei fehlt.");
  const owner = await requirePage(user, file.page_id);
  await requireUnlocked(user, owner);
  // A file used only by a record hidden from this person stays hidden.
  if ((await hiddenFileIds(user, owner)).has(file.id)) throw new HttpError(404, "Datei fehlt.");
  return file;
}
