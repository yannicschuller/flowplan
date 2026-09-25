import { HttpError } from "./auth";
import { embedFromUrl, embedProvider } from "./embed-providers";
import { safeFetch } from "./safe-fetch";

export type ResolvedEmbed =
  | { kind: "player"; src: string; provider: string }
  | {
      kind: "card";
      url: string;
      title: string;
      provider: string;
      description: string;
      image: string;
    };
const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
function attribute(tag: string, name: string) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(
    tag,
  );
  return m ? decode(m[2] ?? m[3] ?? "") : "";
}
function meta(html: string, key: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = attribute(tag, "property") || attribute(tag, "name");
    if (name.toLowerCase() === key) return attribute(tag, "content");
  }
  return "";
}
const httpsUrl = (value: string, base: string) => {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};
const clip = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// Known players become embeds; any other page (via oEmbed discovery or Open
// Graph data) becomes a link card, never an arbitrary third-party iframe.
export async function resolveEmbed(raw: string): Promise<ResolvedEmbed> {
  const known = embedFromUrl(raw);
  if (known) return { kind: "player", ...known };
  const page = await safeFetch(raw, { maxBytes: 1_500_000 });
  if (page.status >= 400)
    throw new HttpError(502, "Die Seite antwortet mit einem Fehler.");
  const html = page.type.includes("html") ? page.body.slice(0, 400_000) : "";
  let oembed: Record<string, unknown> = {};
  const link = (html.match(/<link\b[^>]*>/gi) || []).find(
    (tag) =>
      /json\+oembed/i.test(attribute(tag, "type")) &&
      /alternate/i.test(attribute(tag, "rel")),
  );
  const endpoint = link ? httpsUrl(attribute(link, "href"), page.url) : "";
  if (endpoint) {
    try {
      const response = await safeFetch(endpoint, { maxBytes: 300_000 });
      if (response.status < 400) oembed = JSON.parse(response.body);
    } catch {}
  }
  // A player the app knows, announced through oEmbed.
  const iframe = /<iframe\b[^>]*>/i.exec(String(oembed.html || ""))?.[0];
  const player = iframe ? attribute(iframe, "src") : "";
  if (player) {
    const direct = embedProvider(player) ? player : embedFromUrl(player)?.src;
    if (direct)
      return {
        kind: "player",
        src: direct,
        provider: embedProvider(direct)!.name,
      };
  }
  return previewCard(html, page.url, oembed);
}
// Link card from oEmbed data and Open Graph tags of a fetched page.
export function previewCard(
  html: string,
  pageUrl: string,
  oembed: Record<string, unknown> = {},
): ResolvedEmbed {
  const title =
    clip(oembed.title, 300) ||
    clip(meta(html, "og:title"), 300) ||
    clip(decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || ""), 300);
  if (!title && !Object.keys(oembed).length)
    throw new HttpError(422, "Für diese Seite gibt es keine Vorschau.");
  return {
    kind: "card",
    url: pageUrl,
    title: title || new URL(pageUrl).hostname,
    provider:
      clip(oembed.provider_name, 100) ||
      clip(meta(html, "og:site_name"), 100) ||
      new URL(pageUrl).hostname,
    description:
      clip(meta(html, "og:description"), 300) ||
      clip(meta(html, "description"), 300),
    image: httpsUrl(
      String(oembed.thumbnail_url || meta(html, "og:image") || ""),
      pageUrl,
    ),
  };
}
