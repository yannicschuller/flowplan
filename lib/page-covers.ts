import { all, one, run } from "./db";
import { HttpError } from "./auth";
import {
  imageFileId,
  imageMimes,
  appearanceSchema,
  type PageAppearance,
  type PageImage,
} from "./page-appearance";
export async function pageImages(pageId: string): Promise<PageImage[]> {
  return (await all<{ id: string; name: string; mime: string }>(
    "SELECT id,name,mime FROM files WHERE page_id=? AND deleted_at IS NULL ORDER BY created_at DESC,seq DESC",
    pageId,
  ))
    .filter((file) =>
      imageMimes.includes(file.mime as (typeof imageMimes)[number]),
    )
    .map((file) => ({
      id: file.id,
      name: file.name,
      url: `/api/files/${file.id}`,
    }));
}
export type PageFile = PageImage & { mime: string; size: number };
// All attachments of a page, e.g. for names and previews in files cells.
export async function pageFiles(pageId: string, hidden: Set<string> = new Set()): Promise<PageFile[]> {
  return (await all<{ id: string; name: string; mime: string; size: number }>(
    "SELECT id,name,mime,size FROM files WHERE page_id=? AND deleted_at IS NULL ORDER BY created_at DESC,seq DESC LIMIT 5000",
    pageId,
  ))
    .filter((file) => !hidden.has(file.id))
    .map((file) => ({ ...file, url: `/api/files/${file.id}` }));
}
export async function validateCover(
  pageId: string,
  value: string,
  message = "Bitte ein Bild dieser Seite als Cover verwenden.",
) {
  const fid = imageFileId(value);
  if (!fid) return;
  const file = await one<{ page_id: string; mime: string }>(
    "SELECT page_id,mime FROM files WHERE id=? AND deleted_at IS NULL",
    fid,
  );
  if (
    !file ||
    file.page_id !== pageId ||
    !imageMimes.includes(file.mime as (typeof imageMimes)[number])
  )
    throw new HttpError(400, message);
}
export const validateIcon = async (pageId: string, value: string) =>
  await validateCover(
    pageId,
    value,
    "Bitte ein Bild dieser Seite als Seitensymbol verwenden.",
  );
export async function applyAppearance(pageId: string, input: unknown) {
  const value = appearanceSchema.parse(input);
  await validateCover(pageId, value.cover);
  await run(
    "UPDATE pages SET cover=?,cover_position=? WHERE id=?",
    value.cover,
    value.coverPosition,
    pageId,
  );
}
export async function snapshotAppearance(
  pageId: string,
  json: string | null | undefined,
): Promise<PageAppearance | undefined> {
  if (!json) return;
  const value = appearanceSchema.parse(JSON.parse(json));
  // A cover deleted meanwhile (trash, #164) is dropped, not restored.
  try {
    await validateCover(pageId, value.cover);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    value.cover = "";
  }
  return value;
}
