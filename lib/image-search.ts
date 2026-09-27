// Free images for whiteboards and documents from Openverse (openly
// licensed, credited). Search and download run on the server through the
// SSRF-safe fetch; the chosen image is stored like an upload.
import { z } from "zod";
import { HttpError } from "./auth";
import { safeFetch } from "./safe-fetch";

export type ImageResult = {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  width: number;
  height: number;
  credit: string;
  source: string;
};
const resultSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  url: z.string(),
  thumbnail: z.string().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  creator: z.string().nullish(),
  license: z.string().nullish(),
  license_version: z.string().nullish(),
  foreign_landing_url: z.string().nullish(),
});
export function creditLine(r: z.infer<typeof resultSchema>) {
  const licence = r.license ? `${r.license.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}` : "";
  return [r.title || "Bild", r.creator ? `von ${r.creator}` : "", licence ? `(${licence})` : "", "via Openverse"]
    .filter(Boolean)
    .join(" ");
}
export async function searchImages(query: string, page = 1): Promise<ImageResult[]> {
  const q = z.string().trim().min(2).max(100).parse(query);
  const response = await safeFetch(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=24&page=${Math.max(1, Math.min(20, page))}&mature=false`,
    { maxBytes: 2_000_000, timeout: 8000, accept: "application/json" },
  );
  let body: unknown;
  try {
    body = JSON.parse(response.data.toString("utf8"));
  } catch {
    throw new HttpError(502, "Die Bildsuche hat nicht geantwortet.");
  }
  const results = z.object({ results: z.array(z.unknown()) }).safeParse(body);
  if (!results.success) throw new HttpError(502, "Die Bildsuche hat nicht geantwortet.");
  return results.data.results.flatMap((raw) => {
    const r = resultSchema.safeParse(raw);
    if (!r.success || !/^https:\/\//.test(r.data.url)) return [];
    return [
      {
        id: r.data.id,
        title: r.data.title || "",
        thumbnail: r.data.thumbnail && /^https:\/\//.test(r.data.thumbnail) ? r.data.thumbnail : r.data.url,
        url: r.data.url,
        width: r.data.width || 0,
        height: r.data.height || 0,
        credit: creditLine(r.data),
        source: r.data.foreign_landing_url || "",
      },
    ];
  });
}
const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export async function downloadImage(url: string, maxBytes: number) {
  const target = z.url().max(2000).parse(url);
  const response = await safeFetch(target, { maxBytes, timeout: 15000, accept: "image/*" });
  const type = response.type.split(";")[0].trim().toLowerCase();
  if (!imageTypes.includes(type)) throw new HttpError(415, "Das ist kein unterstütztes Bild.");
  const ext = type.split("/")[1].replace("jpeg", "jpg");
  return { data: response.data, type, ext };
}
