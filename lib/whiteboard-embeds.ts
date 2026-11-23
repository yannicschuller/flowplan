// Embeds on whiteboards and the checks for every newer element property.
// Videos and pages come only from the providers of lib/embed-providers.ts
// (YouTube via youtube-nocookie, Vimeo, Loom, Spotify, Figma, CodePen) –
// the same list the Content Security Policy allows as frames (proxy.ts).
// The board shows a preview first and loads the player only on a click, in
// a sandboxed frame. PDFs are files of the workspace, drawn with pdf.js.
// Every other web page becomes a link card (#455): an embed with the
// address in `url`, no `src`, and the preview the server found – never a
// frame of the page. Its picture and icon are files of the board
// (lib/link-pictures.ts): nothing is loaded from the other site while the
// board is viewed, and a picture address of another site (stored by an
// older version) is not shown.
import { z } from "zod";
import { embedFromUrl, embedProvider } from "./embed-providers";
import { safeHref } from "./whiteboard-links";
import { itemTags } from "./whiteboard-tags";
import { groupPath } from "./whiteboard-groups";
import { COMMENT_COLORS } from "./comment-colors";
import type { WhiteboardItem } from "./whiteboard-model";
import { MAX_TABLE_COLS, MAX_TABLE_LINKS, MAX_TABLE_ROWS, TABLE_FILL } from "./whiteboard-tables";

export const PDF_SOURCE = /^\/api\/(files\/[\w-]+|share\/[\w-]+\/files\/[\w-]+)$/;
// The same sandbox as embeds in documents (lib/document-schema.ts).
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-presentation";
export const EMBED_ALLOW = "autoplay; fullscreen; picture-in-picture; encrypted-media";

export type BoardEmbed =
  | { kind: "player"; src: string; provider: string }
  | { kind: "pdf"; src: string; provider: "PDF" }
  | { kind: "link"; url: string; provider: string };
export type PlayerEmbed = Extract<BoardEmbed, { kind: "player" }>;
// A pasted address as an embed of the allowlist, or null.
export function embedForUrl(raw: string): PlayerEmbed | null {
  const found = embedFromUrl(raw);
  return found ? { kind: "player", src: found.src, provider: found.provider } : null;
}
// What a stored embed element may show.
export function boardEmbed(item: Pick<WhiteboardItem, "type" | "src"> & Partial<Pick<WhiteboardItem, "url" | "preview">>): BoardEmbed | null {
  if (item.type !== "embed") return null;
  if (item.src === undefined || item.src === null) {
    const url = webUrl(item.url);
    if (!url) return null;
    const site = linkPreviewSchema.safeParse(item.preview);
    return { kind: "link", url, provider: (site.success && site.data.site) || new URL(url).hostname };
  }
  if (typeof item.src !== "string") return null;
  if (PDF_SOURCE.test(item.src)) return { kind: "pdf", src: item.src, provider: "PDF" };
  const provider = embedProvider(item.src);
  return provider ? { kind: "player", src: item.src, provider: provider.name } : null;
}
// An http(s) address people may open, or null.
export function webUrl(raw: unknown) {
  const href = safeHref(raw);
  return href && /^https?:/i.test(href) ? href : null;
}
// A picture of a preview: a file of the board (or, for guests of a share
// link, its address through the link).
export const previewPicture = z.string().max(300).regex(PDF_SOURCE);
export const isPreviewPicture = (value: unknown): value is string => previewPicture.safeParse(value).success;
// A page's preview as it may be stored (link cards, table cells).
export const linkPreviewSchema = z
  .object({
    title: z.string().max(300),
    site: z.string().max(100),
    description: z.string().max(300).optional(),
    image: previewPicture.optional().catch(undefined),
    icon: previewPicture.optional().catch(undefined),
  })
  .strip()
  // A dropped picture leaves no key behind.
  .transform((preview) => Object.fromEntries(Object.entries(preview).filter(([, value]) => value !== undefined)) as typeof preview);
const tableFill = z.union([z.literal(""), z.string().regex(TABLE_FILL)]);

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
  // PDFs (#455): the pages shown, annotations hidden.
  pages: z.array(z.number().int().min(1).max(100000)).min(1).max(2000).optional(),
  hideInk: z.boolean().optional(),
  // Comment pins (#455): a palette name of lib/comment-colors.ts.
  commentColor: z.enum(COMMENT_COLORS).optional(),
  // Link cards and tables (#455, lib/whiteboard-tables.ts).
  preview: linkPreviewSchema.optional(),
  headerCol: z.boolean().optional(),
  rowFills: z.array(tableFill).max(MAX_TABLE_ROWS).optional(),
  colFills: z.array(tableFill).max(MAX_TABLE_COLS).optional(),
  links: z
    .record(z.string().max(2000), linkPreviewSchema)
    .refine((links) => Object.keys(links).length <= MAX_TABLE_LINKS && Object.keys(links).every((url) => webUrl(url) === url))
    .optional(),
  // #455: pen opacity and highlighter, collapsed frames, own colours.
  opacity: z.number().finite().min(0.1).max(1).optional(),
  highlight: z.boolean().optional(),
  collapsed: z.array(z.string().regex(/^[\w-]{1,64}$/)).max(5000).optional(),
  ownColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).optional(),
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
