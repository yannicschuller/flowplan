// Ids chosen by the device for content created offline (#370): a page made
// without a connection gets its id on the device, so what is made in it
// meanwhile – records of a new database, sub-pages, a picture on a new page –
// can refer to it before the server has it. The server takes such an id
// only when it is a UUID nobody uses yet; the same page sent again (a retry
// after a lost answer, also once the Idempotency-Key expired after a day
// offline) is recognised by its creator and place and created once.
import { z } from "zod";
import { one } from "./db";
import { HttpError } from "./auth";
import type { Identity } from "./types";

const uuid = z.string().uuid();
// The id form of a notebook sheet (lib/notebook.ts sheetId).
const sheet = z.string().regex(/^[\w-]{1,40}$/);

// A page id from the device. `existing`: this person created this page here
// already (the same request again) – nothing is created a second time.
export async function claimPageId(user: Identity, workspaceId: string, spaceId: string, raw: unknown): Promise<{ id: string; existing: boolean }> {
  const pid = uuid.parse(raw).toLowerCase();
  const page = await one<{ workspace_id: string; space_id: string; created_by: string }>(
    "SELECT workspace_id,space_id,created_by FROM pages WHERE id=?",
    pid,
  );
  if (!page) return { id: pid, existing: false };
  if (page.workspace_id === workspaceId && page.space_id === spaceId && page.created_by === user.id) return { id: pid, existing: true };
  throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
}

// The ids of a template's example records (one per record, all new).
export async function claimRowIds(raw: unknown, count: number): Promise<string[]> {
  const ids = z.array(uuid).max(1000).parse(raw).map((v) => v.toLowerCase());
  if (ids.length !== count || new Set(ids).size !== ids.length) throw new HttpError(400, "Die Kennungen der Einträge passen nicht zur Vorlage.");
  for (const rid of ids)
    if ((await one("SELECT 1 FROM rows WHERE id=?", rid)) || (await one("SELECT 1 FROM row_trash WHERE id=?", rid)))
      throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
  return ids;
}

// The first sheet of a new notebook: its handwriting was drawn offline under this id.
export async function claimSheetId(raw: unknown): Promise<string> {
  const sid = sheet.parse(raw);
  if (await one("SELECT 1 FROM notebook_sheets WHERE id=?", sid)) throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
  return sid;
}

// A file id from the device (an upload made offline): the picture is in the
// document under /api/files/<id> before it is uploaded. `existing`: this
// person's upload of this page arrived already.
export async function claimFileId(user: Identity, pageId: string, raw: unknown): Promise<{ id: string; existing: { name: string; mime: string } | null }> {
  const fid = uuid.parse(raw).toLowerCase();
  const file = await one<{ page_id: string; created_by: string; name: string; mime: string }>(
    "SELECT page_id,created_by,name,mime FROM files WHERE id=?",
    fid,
  );
  if (!file) return { id: fid, existing: null };
  if (file.page_id === pageId && file.created_by === user.id) return { id: fid, existing: { name: file.name, mime: file.mime } };
  throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
}
