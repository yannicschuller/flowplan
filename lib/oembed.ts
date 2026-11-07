import { HttpError } from "./auth";
import { embedFromUrl, embedProvider } from "./embed-providers";
import { safeFetch } from "./safe-fetch";
import { scanHtml } from "./html-tokens";

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
// Pages and oEmbed HTML are read up to here (see scanHtml: one pass, no
// regular expressions over the whole page).
const HEAD_LIMIT = 64_000;
// The src of the first <iframe> in oEmbed's HTML.
function iframeSrc(html: string) {
  let src = "";
  scanHtml(html.slice(0, HEAD_LIMIT), {
    open: ({ name, attrs }) => {
      if (name !== "iframe") return;
      src = decode(attrs.get("src") || "");
      return false;
    },
  });
  return src;
}
// What a link card needs from a page: its title, the meta tags (the first
// of each name) and the oEmbed address, up to the end of <head>.
type PageHead = { title: string; meta: Map<string, string>; oembed: string };
function readHead(html: string): PageHead {
  const head: PageHead = { title: "", meta: new Map(), oembed: "" };
  let title: string | undefined;
  let inTitle = false;
  scanHtml(html.slice(0, HEAD_LIMIT), {
    open: ({ name, attrs }) => {
      if (name === "body") return false;
      if (name === "meta") {
        const key = (attrs.get("property") || attrs.get("name") || "").toLowerCase();
        if (key && !head.meta.has(key)) head.meta.set(key, decode(attrs.get("content") || ""));
      } else if (
        name === "link" &&
        !head.oembed &&
        /json\+oembed/i.test(attrs.get("type") || "") &&
        /alternate/i.test(attrs.get("rel") || "")
      )
        head.oembed = decode(attrs.get("href") || "");
      else if (name === "title" && title === undefined) {
        title = "";
        inTitle = true;
      }
    },
    close: (name) => {
      if (name === "title") inTitle = false;
      if (name === "head") return false;
    },
    text: (raw) => {
      if (inTitle) title += raw;
    },
  });
  head.title = decode(title || "");
  return head;
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
  const head = readHead(page.type.includes("html") ? page.body : "");
  let oembed: Record<string, unknown> = {};
  const endpoint = head.oembed ? httpsUrl(head.oembed, page.url) : "";
  if (endpoint) {
    try {
      const response = await safeFetch(endpoint, { maxBytes: 300_000 });
      if (response.status < 400) oembed = JSON.parse(response.body);
    } catch {}
  }
  // A player the app knows, announced through oEmbed.
  const player = iframeSrc(String(oembed.html || ""));
  if (player) {
    const direct = embedProvider(player) ? player : embedFromUrl(player)?.src;
    if (direct)
      return {
        kind: "player",
        src: direct,
        provider: embedProvider(direct)!.name,
      };
  }
  return previewCard(head, page.url, oembed);
}
// Link card from oEmbed data and Open Graph tags of a fetched page.
export function previewCard(
  page: string | PageHead,
  pageUrl: string,
  oembed: Record<string, unknown> = {},
): ResolvedEmbed {
  const head = typeof page === "string" ? readHead(page) : page;
  const meta = (key: string) => head.meta.get(key) || "";
  const title =
    clip(oembed.title, 300) ||
    clip(meta("og:title"), 300) ||
    clip(head.title, 300);
  if (!title && !Object.keys(oembed).length)
    throw new HttpError(422, "Für diese Seite gibt es keine Vorschau.");
  return {
    kind: "card",
    url: pageUrl,
    title: title || new URL(pageUrl).hostname,
    provider:
      clip(oembed.provider_name, 100) ||
      clip(meta("og:site_name"), 100) ||
      new URL(pageUrl).hostname,
    description:
      clip(meta("og:description"), 300) ||
      clip(meta("description"), 300),
    image: httpsUrl(
      String(oembed.thumbnail_url || meta("og:image") || ""),
      pageUrl,
    ),
  };
}
