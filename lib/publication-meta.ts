// Metadata of published pages: their title, the favicon an owner chose and,
// with a verified custom domain (lib/custom-domains.ts), the canonical
// address there. Pages under a custom domain may be indexed; the app's own
// /share addresses stay out of search engines.
import type { Metadata } from "next";
import { headers } from "next/headers";
import { CUSTOM_HOST_HEADER } from "./custom-domain-routing";
import { customHostFor, publicationHost, renderedTheme } from "./custom-domains";
import { publicPage } from "./publication";

// The custom domain this request came in on, when it belongs to `token`.
// The proxy sets the header and removes any a client sends.
export async function requestCustomHost(token: string) {
  const host = (await headers()).get(CUSTOM_HOST_HEADER);
  try {
    return customHostFor(host, token);
  } catch {
    return null;
  }
}

export async function publicationMetadata(token: string, pageId?: string): Promise<Metadata> {
  const base: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
  let context;
  try {
    context = publicPage(token, pageId);
  } catch {
    return base;
  }
  const { root, page } = context;
  const isPublication = root.public_token === token;
  let favicon: string | undefined;
  if (isPublication)
    try {
      favicon = renderedTheme(token, root.id).favicon;
    } catch {}
  const customHost = await requestCustomHost(token);
  const host = customHost || (isPublication ? publicationHost(root.id) : null);
  const path = page.id === root.id ? "/" : `/${page.id}`;
  return {
    ...base,
    title: page.title || root.title,
    ...(favicon ? { icons: { icon: favicon } } : {}),
    ...(host ? { alternates: { canonical: `https://${host}${path}` } } : {}),
    ...(customHost
      ? {
          metadataBase: new URL(`https://${customHost}`),
          robots: { index: true, follow: true },
          openGraph: { type: "website", title: page.title || root.title, url: `https://${customHost}${path}` },
        }
      : {}),
  };
}
