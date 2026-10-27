// GIF search for whiteboards – optional: it is there when the instance has
// a key for GIPHY (GIPHY_API_KEY) or Tenor (TENOR_API_KEY); without one the
// GIF tab of the image search is hidden. Search runs on the server through
// the SSRF-safe fetch; a chosen GIF is downloaded and stored like the
// Openverse images (/api/images/import, size limits there), so the board
// never loads anything from the provider afterwards.
import { z } from "zod";
import { HttpError } from "./auth";
import { safeFetch } from "./safe-fetch";
import type { ImageResult } from "./image-search";

export type GifProvider = "giphy" | "tenor";
export function gifProvider(env: Record<string, string | undefined> = process.env): GifProvider | null {
  if (env.GIPHY_API_KEY?.trim()) return "giphy";
  if (env.TENOR_API_KEY?.trim()) return "tenor";
  return null;
}
const https = z.string().regex(/^https:\/\//).max(2000);
const giphyItem = z.object({
  id: z.string(),
  title: z.string().nullish(),
  username: z.string().nullish(),
  images: z.object({
    fixed_width: z.object({ url: https, width: z.coerce.number(), height: z.coerce.number() }).optional(),
    fixed_width_small: z.object({ url: https }).optional(),
    downsized: z.object({ url: https, width: z.coerce.number(), height: z.coerce.number() }).optional(),
  }),
});
const tenorMedia = z.object({ url: https, dims: z.array(z.number()).optional() });
const tenorItem = z.object({
  id: z.string(),
  content_description: z.string().nullish(),
  title: z.string().nullish(),
  media_formats: z.object({ gif: tenorMedia.optional(), tinygif: tenorMedia.optional(), mediumgif: tenorMedia.optional() }),
});
// Each result is checked on its own: one odd entry does not cost the rest.
const each = <T,>(schema: z.ZodType<T>, list: unknown[]) =>
  list.flatMap((raw) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });

// Results in the shape of the image search (lib/image-search.ts).
export function parseGifResults(provider: GifProvider, body: unknown): ImageResult[] {
  const list = z.object({ [provider === "giphy" ? "data" : "results"]: z.array(z.unknown()) }).safeParse(body);
  if (!list.success) throw new HttpError(502, "Die GIF-Suche hat nicht geantwortet.");
  const entries = Object.values(list.data)[0] as unknown[];
  if (provider === "giphy") {
    return each(giphyItem, entries).flatMap((gif) => {
      const full = gif.images.downsized || gif.images.fixed_width;
      if (!full) return [];
      return [
        {
          id: gif.id,
          title: gif.title || "GIF",
          thumbnail: gif.images.fixed_width_small?.url || gif.images.fixed_width?.url || full.url,
          url: full.url,
          width: full.width || 0,
          height: full.height || 0,
          credit: [gif.title || "GIF", gif.username ? `von ${gif.username}` : "", "via GIPHY"].filter(Boolean).join(" "),
          source: `https://giphy.com/gifs/${encodeURIComponent(gif.id)}`,
        },
      ];
    });
  }
  return each(tenorItem, entries).flatMap((gif) => {
    const full = gif.media_formats.mediumgif || gif.media_formats.gif;
    if (!full) return [];
    const title = gif.content_description || gif.title || "GIF";
    return [
      {
        id: gif.id,
        title,
        thumbnail: gif.media_formats.tinygif?.url || full.url,
        url: full.url,
        width: full.dims?.[0] || 0,
        height: full.dims?.[1] || 0,
        credit: `${title} via Tenor`,
        source: "",
      },
    ];
  });
}
export function gifSearchUrl(provider: GifProvider, query: string, env: Record<string, string | undefined> = process.env) {
  const q = encodeURIComponent(query);
  return provider === "giphy"
    ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(env.GIPHY_API_KEY!.trim())}&q=${q}&limit=24&rating=g&lang=de`
    : `https://tenor.googleapis.com/v2/search?key=${encodeURIComponent(env.TENOR_API_KEY!.trim())}&q=${q}&limit=24&media_filter=gif,tinygif,mediumgif&contentfilter=medium&client_key=flowplan`;
}
export async function searchGifs(query: string): Promise<ImageResult[]> {
  const provider = gifProvider();
  if (!provider) throw new HttpError(404, "Die GIF-Suche ist auf diesem Server nicht eingerichtet.");
  const q = z.string().trim().min(2).max(100).parse(query);
  const response = await safeFetch(gifSearchUrl(provider, q), { maxBytes: 3_000_000, timeout: 8000, accept: "application/json" });
  let body: unknown;
  try {
    body = JSON.parse(response.data.toString("utf8"));
  } catch {
    throw new HttpError(502, "Die GIF-Suche hat nicht geantwortet.");
  }
  return parseGifResults(provider, body);
}
// Animated pictures may be at most this large when stored.
export const GIF_MAX_BYTES = 8 * 1024 * 1024;
