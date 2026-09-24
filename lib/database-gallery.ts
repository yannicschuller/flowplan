import { fileUrls } from "./file-cells";
import { z } from "zod";
import type { Field, Row } from "./types";
export const gallerySchema = z
  .object({
    cover: z.enum(["none", "document", "field", "record"]),
    fieldId: z.string().max(500).optional(),
    fit: z.enum(["cover", "contain"]),
    size: z.enum(["small", "medium", "large"]),
  })
  .refine(
    (value) => value.cover !== "field" || !!value.fieldId,
    "Eine Bildeigenschaft auswählen.",
  );
export type GalleryConfig = z.infer<typeof gallerySchema>;
export const defaultGallery: GalleryConfig = {
  cover: "document",
  fit: "cover",
  size: "medium",
};
export function galleryImage(
  row: Row,
  config: GalleryConfig,
  fields: Field[],
  authorizedImages: ReadonlySet<string>,
): string | undefined {
  const value =
    config.cover === "record"
      ? row.cover
      : config.cover === "document"
        ? row.preview?.image
        : config.cover === "field" &&
            fields.some(
              (field) => field.id === config.fieldId && field.type === "files",
            )
          ? row.cells[config.fieldId!]
          : undefined;
  // Files cells may hold several entries; the first authorized image wins.
  return (config.cover === "field" ? fileUrls(value) : [value]).find(
    (url): url is string =>
      typeof url === "string" && authorizedImages.has(url),
  );
}
