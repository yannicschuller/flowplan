// Metadata of published pages: their title, the favicon an owner chose and,
// with a verified custom domain (lib/custom-domains.ts), the canonical
// address there. Pages under a custom domain may be indexed; the app's own
// /share addresses stay out of search engines.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { CUSTOM_HOST_HEADER } from "./custom-domain-routing";
import { customHostFor, publicationHost, renderedTheme } from "./custom-domains";
import { one } from "./db";
import { imageFileId } from "./page-appearance";
import { publicFile, publicPage, publishedHtml } from "./publication";
import { recordScope, recordTitle } from "./record-share";
import { htmlText } from "./search-index";
import { siteUrl } from "./seo";

// How long the excerpt of a link preview may be (#531): about what
// messengers and social networks show under the title.
export const PREVIEW_EXCERPT_CHARS = 200;

// The start of a text, cut at a word and ended with "…" when longer.
export function excerpt(text: string, max = PREVIEW_EXCERPT_CHARS) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// What a link preview shows of a published page (#531): the start of its
// text and its cover picture, as the page itself serves them. Only through
// the publication's address (never a private share link), and only while
// it is open: behind a password or after its end date publicPage refuses,
// and the preview stays Flowplan's general one.
export async function publicationPreview(
  token: string,
  context: Awaited<ReturnType<typeof publicPage>>,
): Promise<{ description?: string; image?: string }> {
  const { page, pages } = context;
  const html = String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id))?.html || "");
  const description = html ? excerpt(htmlText(await publishedHtml(html, token, pages))) : "";
  let image: string | undefined;
  const coverId = imageFileId(page.cover || "");
  if (coverId)
    try {
      await publicFile(token, coverId);
      image = `${siteUrl()}/api/share/${token}/files/${coverId}`;
    } catch {}
  return { ...(description ? { description } : {}), ...(image ? { image } : {}) };
}

// The custom domain this request came in on, when it belongs to `token`.
// The proxy sets the header and removes any a client sends.
export async function requestCustomHost(token: string) {
  const host = (await headers()).get(CUSTOM_HOST_HEADER);
  try {
    return await customHostFor(host, token);
  } catch {
    return null;
  }
}

export async function publicationMetadata(token: string, pageId?: string): Promise<Metadata> {
  const base: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
  // A shared record (lib/record-share.ts): its title, never indexed – the
  // app's /share addresses stay out of search engines.
  try {
    const record = await recordScope(token);
    if (record && !pageId) return { ...base, title: recordTitle(record) || record.page.title };
    // A sub-page of the record (#231): its title, never indexed.
    if (record) {
      const sub = await publicPage(token, pageId);
      return { ...base, title: sub.page.title || sub.root.title };
    }
  } catch {
    return base;
  }
  let context;
  try {
    context = await publicPage(token, pageId);
  } catch {
    return base;
  }
  const { root, page } = context;
  const isPublication = root.public_token === token;
  let favicon: string | undefined;
  if (isPublication)
    try {
      favicon = (await renderedTheme(token, root.id)).favicon;
    } catch {}
  const customHost = await requestCustomHost(token);
  const host = customHost || (isPublication ? (await publicationHost(root.id)) : null);
  const path = page.id === root.id ? "/" : `/${page.id}`;
  const title = page.title || root.title;
  // The page's own preview for messengers and social networks (#531); a
  // private share link keeps the general one of the layout.
  const preview = isPublication ? await publicationPreview(token, context).catch(() => ({}) as { description?: string; image?: string }) : null;
  const images = preview?.image ? [{ url: preview.image, alt: title }] : undefined;
  return {
    ...base,
    title,
    ...(preview?.description ? { description: preview.description } : {}),
    ...(favicon ? { icons: { icon: favicon } } : {}),
    ...(host ? { alternates: { canonical: `https://${host}${path}` } } : {}),
    ...(preview
      ? {
          openGraph: {
            type: "article",
            siteName: "Flowplan",
            title,
            ...(preview.description ? { description: preview.description } : {}),
            ...(customHost ? { url: `https://${customHost}${path}` } : {}),
            ...(images ? { images } : {}),
          },
          twitter: {
            card: images ? "summary_large_image" : "summary",
            title,
            ...(preview.description ? { description: preview.description } : {}),
            ...(images ? { images: images.map((i) => i.url) } : {}),
          },
        }
      : {}),
    ...(customHost ? { metadataBase: new URL(`https://${customHost}`), robots: { index: true, follow: true } } : {}),
  };
}
