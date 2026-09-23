import { z } from "zod";
export const imageMimes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
export const imageAccept = imageMimes.join(",");
export const imageFileId = (url: string) =>
  /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    url,
  )?.[1];
export const coverSchema = z
  .string()
  .max(100)
  .refine(
    (value) =>
      value === "" || /^#[0-9a-f]{6}$/i.test(value) || !!imageFileId(value),
    "Ungültiges Cover.",
  );
export const appearanceSchema = z.object({
  cover: coverSchema,
  coverPosition: z.number().finite().min(0).max(100),
});
export type PageAppearance = z.infer<typeof appearanceSchema>;
export type PageImage = { id: string; url: string; name: string };
export function pageAppearance(page: {
  cover: string;
  cover_position?: number;
}): PageAppearance {
  return { cover: page.cover, coverPosition: page.cover_position ?? 50 };
}
