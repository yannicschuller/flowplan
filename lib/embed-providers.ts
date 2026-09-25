// Supported embed providers. A pasted page URL is turned into the provider's
// official player URL; stored documents may only contain these player URLs.
export type EmbedProvider = {
  name: string;
  host: string;
  // Returns the player URL for a pasted link, or null.
  parse: (url: URL) => string | null;
  // Exact shape of stored player URLs.
  player: RegExp;
};
const id = (value: string | null | undefined, pattern: RegExp) =>
  value && pattern.test(value) ? value : null;
export const embedProviders: EmbedProvider[] = [
  {
    name: "YouTube",
    host: "www.youtube-nocookie.com",
    parse: (url) => {
      const host = url.hostname.replace(/^(www|m)\./, "");
      const video =
        host === "youtu.be"
          ? url.pathname.slice(1)
          : host === "youtube.com"
            ? url.searchParams.get("v") ||
              /^\/(?:shorts|embed|live)\/([-\w]+)/.exec(url.pathname)?.[1]
            : host === "youtube-nocookie.com"
              ? /^\/embed\/([-\w]+)/.exec(url.pathname)?.[1]
              : null;
      const valid = id(video, /^[-\w]{6,20}$/);
      return valid ? `https://www.youtube-nocookie.com/embed/${valid}` : null;
    },
    player: /^https:\/\/www\.youtube-nocookie\.com\/embed\/[-\w]{6,20}$/,
  },
  {
    name: "Vimeo",
    host: "player.vimeo.com",
    parse: (url) => {
      const host = url.hostname.replace(/^www\./, "");
      const video =
        host === "vimeo.com"
          ? /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(url.pathname)?.[1]
          : host === "player.vimeo.com"
            ? /^\/video\/(\d{5,12})$/.exec(url.pathname)?.[1]
            : null;
      return video ? `https://player.vimeo.com/video/${video}` : null;
    },
    player: /^https:\/\/player\.vimeo\.com\/video\/\d{5,12}$/,
  },
  {
    name: "Loom",
    host: "www.loom.com",
    parse: (url) => {
      if (url.hostname.replace(/^www\./, "") !== "loom.com") return null;
      const video = /^\/(?:share|embed)\/([0-9a-f]{32})$/.exec(
        url.pathname,
      )?.[1];
      return video ? `https://www.loom.com/embed/${video}` : null;
    },
    player: /^https:\/\/www\.loom\.com\/embed\/[0-9a-f]{32}$/,
  },
  {
    name: "Spotify",
    host: "open.spotify.com",
    parse: (url) => {
      if (url.hostname !== "open.spotify.com") return null;
      const m =
        /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})$/.exec(
          url.pathname.replace(/^\/+/, "/"),
        );
      return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
    },
    player:
      /^https:\/\/open\.spotify\.com\/embed\/(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{22}$/,
  },
  {
    name: "Figma",
    host: "www.figma.com",
    parse: (url) => {
      if (url.hostname.replace(/^www\./, "") !== "figma.com") return null;
      const m =
        /^\/(file|design|proto|board)\/([A-Za-z0-9]{10,40})(?:\/[^/?#]*)?$/.exec(
          url.pathname,
        );
      if (!m) return null;
      const source = `https://www.figma.com/${m[1]}/${m[2]}`;
      return `https://www.figma.com/embed?embed_host=flowplan&url=${encodeURIComponent(source)}`;
    },
    player:
      /^https:\/\/www\.figma\.com\/embed\?embed_host=flowplan&url=https%3A%2F%2Fwww\.figma\.com%2F(file|design|proto|board)%2F[A-Za-z0-9]{10,40}$/,
  },
  {
    name: "CodePen",
    host: "codepen.io",
    parse: (url) => {
      if (url.hostname !== "codepen.io") return null;
      const m =
        /^\/([\w-]{1,40})\/(?:pen|embed|full)\/([A-Za-z0-9]{4,12})\/?$/.exec(
          url.pathname,
        );
      return m
        ? `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`
        : null;
    },
    player:
      /^https:\/\/codepen\.io\/[\w-]{1,40}\/embed\/[A-Za-z0-9]{4,12}\?default-tab=result$/,
  },
];
export const embedHosts = embedProviders.map((p) => p.host);
export function embedFromUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const provider of embedProviders) {
    const src = provider.parse(url);
    if (src) return { src, provider: provider.name };
  }
  return null;
}
export function embedProvider(src: string) {
  return embedProviders.find((p) => p.player.test(src));
}
