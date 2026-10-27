// Links on whiteboards: links into the web (http, https, mailto) and links
// to an element of a board ("Link zu diesem Element kopieren"). An element
// link is the page address with the element: /#page=<board>&item=<element>;
// inside the same board "#item=<element>" is enough. Everything else
// (javascript:, data:, relative paths …) is no link at all.

// Element ids: UUIDs on new boards, short ids in imported or demo content.
export const ITEM_ID = /^[\w-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The address that opens the board zoomed to the element.
export function elementLink(origin: string, pageId: string, itemId: string) {
  return `${origin.replace(/\/$/, "")}/#page=${pageId}&item=${encodeURIComponent(itemId)}`;
}

// An element link: "#item=<id>", "#page=<board>&item=<id>" or a full
// address of this Flowplan (origin) with that hash. Null otherwise.
export function parseElementLink(raw: string, origin?: string): { pageId?: string; itemId: string } | null {
  const value = raw.trim();
  let hash: string;
  if (value.startsWith("#")) hash = value;
  else if (value.startsWith("/#")) hash = value.slice(1);
  else {
    if (!origin) return null;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== new URL(origin).origin || (url.pathname !== "/" && url.pathname !== "")) return null;
    hash = url.hash;
  }
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if ([...params.keys()].some((key) => key !== "page" && key !== "item")) return null;
  const itemId = params.get("item"),
    pageId = params.get("page");
  if (!itemId || !ITEM_ID.test(itemId) || params.getAll("item").length > 1) return null;
  if (pageId !== null && !UUID.test(pageId)) return null;
  return pageId ? { pageId, itemId } : { itemId };
}

// A link people may follow: http(s) with a host, mailto with an address, or
// an element link. Returns the normalized link or null.
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\s<>"'`\\]/.test(value)) return null;
  if (/^#item=[\w-]{1,64}$/.test(value)) return value;
  if (/^\/?#page=/.test(value)) return parseElementLink(value) ? value : null;
  if (/^mailto:/i.test(value)) return /^mailto:[^@\s/?#]+@[^@\s/?#]+\.[^@\s/?#]+(\?[^\s]*)?$/i.test(value) ? value : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  return url.href;
}

// What a click on a link does on the board with this page: jump to an
// element here, open another Flowplan page, or open the web address in a
// new tab.
export type LinkTarget =
  | { kind: "item"; itemId: string }
  | { kind: "page"; href: string }
  | { kind: "web"; href: string };
export function linkTarget(href: string, pageId: string, origin: string): LinkTarget | null {
  const safe = safeHref(href) ?? (parseElementLink(href, origin) ? href : null);
  if (!safe) return null;
  const element = parseElementLink(safe, origin);
  if (element && (!element.pageId || element.pageId === pageId)) return { kind: "item", itemId: element.itemId };
  if (element) return { kind: "page", href: `/#page=${element.pageId}&item=${encodeURIComponent(element.itemId)}` };
  return { kind: "web", href: safe };
}
