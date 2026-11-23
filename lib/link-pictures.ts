// Pictures of link cards on whiteboards (#455 follow-up): the preview image
// and the icon of a web page, and the still picture of a video in a table
// cell, become files of the board when someone who may edit it adds the
// link – nobody who looks at the board loads anything from the other site.
//
// The server fetches each picture once (lib/safe-fetch.ts: public HTTPS
// only, at most PICTURE_MAX_BYTES, a time limit, no cookies), accepts only
// raster images (PNG, JPEG, WebP, GIF, AVIF and the PNG inside an .ico) and
// draws them anew with sharp – a small WebP for pictures, a PNG for icons,
// without metadata – so nothing active of the original survives. The result
// is an ordinary upload of the board (lib/page-upload.ts storeUpload): it
// counts towards the uploader's storage, follows the board's permissions,
// copies, archives and exports, and goes to the file trash like any picture
// on the board. When sharp is missing or a picture fails, the card simply
// has no picture.
import { safeFetch } from "./safe-fetch";
import { storeUpload } from "./page-upload";
import { id } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { requirePlaintext } from "./e2ee-server";
import type { Identity, Page } from "./types";

export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
export const PICTURE_TIMEOUT_MS = 6000;
// The longer side of a stored picture and of an icon, in pixels.
export const PICTURE_EDGE = 640;
export const ICON_EDGE = 64;
// Larger sources are not decoded at all.
const MAX_INPUT_PIXELS = 40_000_000;

type Sharp = (typeof import("sharp"))["default"];
let loaded: Promise<Sharp | null> | null = null;
// sharp is loaded on first use; without it (a build that left it out) cards
// keep their text only.
function sharpModule(): Promise<Sharp | null> {
  loaded ??= import("sharp").then(
    (m) => m.default ?? (m as unknown as Sharp),
    () => null,
  );
  return loaded;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (data: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);
// The largest PNG image inside an .ico file (modern icons carry PNGs; the
// old bitmap entries are not read), or null.
export function pngFromIco(data: Uint8Array): Uint8Array | null {
  if (data.length < 6 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1 || data[3] !== 0) return null;
  const count = data[4] | (data[5] << 8);
  let best: Uint8Array | null = null;
  for (let i = 0; i < Math.min(count, 64); i++) {
    const at = 6 + i * 16;
    if (at + 16 > data.length) break;
    const size = (data[at + 8] | (data[at + 9] << 8) | (data[at + 10] << 16) | (data[at + 11] << 24)) >>> 0;
    const offset = (data[at + 12] | (data[at + 13] << 8) | (data[at + 14] << 16) | (data[at + 15] << 24)) >>> 0;
    if (!size || offset + size > data.length || !startsWith(data, PNG, offset)) continue;
    if (!best || size > best.length) best = data.subarray(offset, offset + size);
  }
  return best;
}

// What the bytes are, by their first bytes (the declared type is only a hint).
export function rasterKind(data: Uint8Array): "png" | "jpeg" | "webp" | "gif" | "avif" | "ico" | null {
  if (startsWith(data, PNG)) return "png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(data, [0x66, 0x74, 0x79, 0x70], 4) && /^avi[fs]$/.test(String.fromCharCode(...data.subarray(8, 12)))) return "avif";
  if (data.length > 6 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return "ico";
  return null;
}

// The picture drawn anew: at most `edge` pixels on its longer side, WebP
// (pictures) or PNG (icons), without metadata; null when it is no raster
// image we read.
export async function reencodePicture(input: Uint8Array, kind: "picture" | "icon"): Promise<{ data: Buffer; mime: string; ext: string } | null> {
  let source = input;
  const format = rasterKind(source);
  if (!format) return null;
  if (format === "ico") {
    const png = pngFromIco(source);
    if (!png) return null;
    source = png;
  }
  const sharp = await sharpModule();
  if (!sharp) return null;
  try {
    const edge = kind === "icon" ? ICON_EDGE : PICTURE_EDGE;
    // The first frame of an animation only; EXIF orientation applied.
    const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, animated: false, failOn: "error" })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
    const data = kind === "icon" ? await image.png({ compressionLevel: 9 }).toBuffer() : await image.webp({ quality: 80 }).toBuffer();
    return kind === "icon" ? { data, mime: "image/png", ext: "png" } : { data, mime: "image/webp", ext: "webp" };
  } catch {
    return null;
  }
}

// Fetches a picture of another site, once, and draws it anew; null when
// there is none to use. `allowPrivate` only for the tests' local server.
export async function fetchPicture(url: string, kind: "picture" | "icon", options: { allowPrivate?: boolean } = {}) {
  if (!/^https:\/\//i.test(url) && !(options.allowPrivate && /^http:\/\//i.test(url))) return null;
  try {
    const response = await safeFetch(url, {
      maxBytes: PICTURE_MAX_BYTES,
      timeout: PICTURE_TIMEOUT_MS,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.8",
      allowPrivate: options.allowPrivate,
    });
    if (response.status >= 400) return null;
    const type = response.type.split(";")[0].trim().toLowerCase();
    if (type && !type.startsWith("image/") && type !== "application/octet-stream") return null;
    if (type === "image/svg+xml") return null;
    return await reencodePicture(response.data, kind);
  } catch {
    return null;
  }
}

// The picture as a file of the board: its address, or undefined when there
// is none (no picture, not readable, storage full).
export async function storeLinkPicture(
  user: Identity,
  page: Pick<Page, "id" | "workspace_id">,
  url: string | undefined,
  kind: "picture" | "icon",
  name: string,
  options: { allowPrivate?: boolean } = {},
): Promise<string | undefined> {
  if (!url) return undefined;
  const picture = await fetchPicture(url, kind, options);
  if (!picture) return undefined;
  const fid = id();
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Link";
  try {
    await storeUpload(user, page, { id: fid, name: `${base}.${picture.ext}`, mime: picture.mime, content: picture.data });
  } catch {
    return undefined;
  }
  return `/api/files/${fid}`;
}

// ---- the preview of an address on a board ----

export type BoardLinkPreview =
  | { kind: "player"; src: string; provider: string; image?: string }
  | { kind: "card"; url: string; title: string; site: string; description?: string; image?: string; icon?: string };

// The still picture of a video player: YouTube's from the address, Vimeo's
// from its oEmbed answer; undefined for other providers.
export async function playerStillUrl(src: string, options: { allowPrivate?: boolean } = {}): Promise<string | undefined> {
  const youtube = /^https:\/\/www\.youtube-nocookie\.com\/embed\/([-\w]{6,20})$/.exec(src)?.[1];
  if (youtube) return `https://i.ytimg.com/vi/${youtube}/hqdefault.jpg`;
  const vimeo = /^https:\/\/player\.vimeo\.com\/video\/(\d{5,12})$/.exec(src)?.[1];
  if (!vimeo) return undefined;
  try {
    const response = await safeFetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${vimeo}`)}`, {
      maxBytes: 100_000,
      timeout: PICTURE_TIMEOUT_MS,
      accept: "application/json",
      allowPrivate: options.allowPrivate,
    });
    if (response.status >= 400) return undefined;
    const thumbnail = (JSON.parse(response.body) as { thumbnail_url?: unknown }).thumbnail_url;
    return typeof thumbnail === "string" && /^https:\/\//i.test(thumbnail) ? thumbnail : undefined;
  } catch {
    return undefined;
  }
}

type Resolve = (raw: string) => Promise<import("./oembed").ResolvedEmbed>;
// Someone who may edit the board added an address: what GET /api/embed
// finds for it, with its picture, icon or still picture stored as files of
// the board. `resolve` and `allowPrivate` only for tests.
export async function boardLinkPreview(
  user: Identity,
  page: Pick<Page, "id" | "workspace_id">,
  raw: string,
  deps: { resolve?: Resolve; allowPrivate?: boolean; still?: (src: string) => Promise<string | undefined> } = {},
): Promise<BoardLinkPreview> {
  const resolve = deps.resolve ?? (await import("./oembed")).resolveEmbed;
  const found = await resolve(raw);
  const options = { allowPrivate: deps.allowPrivate };
  if (found.kind === "player") {
    const still = await (deps.still ?? ((src: string) => playerStillUrl(src, options)))(found.src);
    const image = await storeLinkPicture(user, page, still, "picture", found.provider, options);
    return { kind: "player", src: found.src, provider: found.provider, ...(image ? { image } : {}) };
  }
  const [image, icon] = await Promise.all([
    storeLinkPicture(user, page, found.image || undefined, "picture", found.title || found.provider, options),
    storeLinkPicture(user, page, found.icon || undefined, "icon", `${found.provider} – Symbol`, options),
  ]);
  return {
    kind: "card",
    url: found.url,
    title: found.title,
    site: found.provider,
    ...(found.description ? { description: found.description } : {}),
    ...(image ? { image } : {}),
    ...(icon ? { icon } : {}),
  };
}

// POST /api/whiteboards/<id>/links: only who may edit the board, never the
// demo's anonymous guests (the server loads other sites here, as for GET
// /api/embed), not on locked boards, journals behind a PIN or in encrypted
// spaces (the pictures would be stored readable).
export async function previewForBoard(user: Identity, pageId: string, raw: string, deps: Parameters<typeof boardLinkPreview>[3] = {}) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  const page = await requirePage(user, pageId, true);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  await requireUnlocked(user, page);
  await requirePlaintext(page);
  return await boardLinkPreview(user, page, raw, deps);
}
