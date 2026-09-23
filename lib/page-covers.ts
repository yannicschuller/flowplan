import { all, one, run } from "./db";
import { HttpError } from "./auth";
import {
  imageFileId,
  imageMimes,
  appearanceSchema,
  type PageAppearance,
  type PageImage,
} from "./page-appearance";
export function pageImages(pageId: string): PageImage[] {
  return all<{ id: string; name: string; mime: string }>(
    "SELECT id,name,mime FROM files WHERE page_id=? ORDER BY created_at DESC",
    pageId,
  )
    .filter((file) =>
      imageMimes.includes(file.mime as (typeof imageMimes)[number]),
    )
    .map((file) => ({
      id: file.id,
      name: file.name,
      url: `/api/files/${file.id}`,
    }));
}
export function validateCover(pageId: string, value: string) {
  const fid = imageFileId(value);
  if (!fid) return;
  const file = one<{ page_id: string; mime: string }>(
    "SELECT page_id,mime FROM files WHERE id=?",
    fid,
  );
  if (
    !file ||
    file.page_id !== pageId ||
    !imageMimes.includes(file.mime as (typeof imageMimes)[number])
  )
    throw new HttpError(
      400,
      "Bitte ein Bild dieser Seite als Cover verwenden.",
    );
}
export function applyAppearance(pageId: string, input: unknown) {
  const value = appearanceSchema.parse(input);
  validateCover(pageId, value.cover);
  run(
    "UPDATE pages SET cover=?,cover_position=? WHERE id=?",
    value.cover,
    value.coverPosition,
    pageId,
  );
}
export function snapshotAppearance(
  pageId: string,
  json: string | null | undefined,
): PageAppearance | undefined {
  if (!json) return;
  const value = appearanceSchema.parse(JSON.parse(json));
  validateCover(pageId, value.cover);
  return value;
}
