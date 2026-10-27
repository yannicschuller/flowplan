// Embeds on whiteboards and the checks for every newer element property.
// Videos and pages come only from the providers of lib/embed-providers.ts
// (YouTube via youtube-nocookie, Vimeo, Loom, Spotify, Figma, CodePen) –
// the same list the Content Security Policy allows as frames (proxy.ts).
// The board shows a preview first and loads the player only on a click, in
// a sandboxed frame. PDFs are files of the workspace, drawn with pdf.js.
import { z } from "zod";
import { embedFromUrl, embedProvider } from "./embed-providers";
import { safeHref } from "./whiteboard-links";
import { itemTags } from "./whiteboard-tags";
import { groupPath } from "./whiteboard-groups";
import type { WhiteboardItem } from "./whiteboard-model";

export const PDF_SOURCE = /^\/api\/(files\/[\w-]+|share\/[\w-]+\/files\/[\w-]+)$/;
// The same sandbox as embeds in documents (lib/document-schema.ts).
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-presentation";
export const EMBED_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";

export type BoardEmbed =
  | { kind: "player"; src: string; provider: string }
  | { kind: "pdf"; src: string; provider: "PDF" };
// A pasted address as an embed of the allowlist, or null.
export function embedForUrl(raw: string): BoardEmbed | null {
  const found = embedFromUrl(raw);
  return found ? { kind: "player", src: found.src, provider: found.provider } : null;
}
// What a stored embed element may show.
export function boardEmbed(item: Pick<WhiteboardItem, "type" | "src">): BoardEmbed | null {
  if (item.type !== "embed" || typeof item.src !== "string") return null;
  if (PDF_SOURCE.test(item.src)) return { kind: "pdf", src: item.src, provider: "PDF" };
  const provider = embedProvider(item.src);
  return provider ? { kind: "player", src: item.src, provider: provider.name } : null;
}

const fraction = z.number().finite().min(0).max(1);
export const cropSchema = z
  .object({ x: fraction, y: fraction, w: z.number().finite().min(0.01).max(1), h: z.number().finite().min(0.01).max(1) })
  .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001);
// The newer properties as they may be stored. Board data comes from every
// client of the board, so the board, the exports and the server read them
// through this (wrong values are dropped, never rendered).
export const boardExtrasSchema = z.object({
  groups: z.array(z.string().regex(/^[\w-]{1,64}$/)).max(16).optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  link: z.string().max(2000).refine((v) => safeHref(v) !== null).optional(),
  crop: cropSchema.optional(),
  slide: z.number().finite().min(-1e6).max(1e6).optional(),
  notes: z.string().max(20000).optional(),
  presentHidden: z.boolean().optional(),
  url: z.string().max(2000).optional(),
  page: z.number().int().min(1).max(100000).optional(),
});
export type BoardExtras = z.infer<typeof boardExtrasSchema>;
export function boardExtras(item: Partial<WhiteboardItem>): BoardExtras {
  const out: BoardExtras = {};
  const shape = boardExtrasSchema.shape;
  for (const key of Object.keys(shape) as (keyof BoardExtras)[]) {
    const value = (item as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) (out as Record<string, unknown>)[key] = parsed.data;
  }
  if (out.tags) out.tags = itemTags(out);
  if (out.groups) out.groups = groupPath(out);
  if (out.link) out.link = safeHref(out.link)!;
  return out;
}
// The item with only valid newer properties (others as they are).
export function withValidExtras<T extends Partial<WhiteboardItem>>(item: T): T {
  const extras = boardExtras(item);
  const copy = { ...item } as Record<string, unknown>;
  for (const key of Object.keys(boardExtrasSchema.shape)) if (!(key in extras)) delete copy[key];
  return { ...(copy as T), ...extras };
}
export function cleanCrop(crop: unknown) {
  const parsed = cropSchema.safeParse(crop);
  return parsed.success ? parsed.data : null;
}
