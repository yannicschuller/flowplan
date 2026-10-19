// Orientation after a jump: when a search hit, a backlink, a mention or a
// notification opens a page, the block it is about flashes briefly once it
// has loaded (lib/motion.ts `flash`). Nothing is stored: the highlight is an
// overlay that removes itself.
import { reveal } from "./motion";
import { parsePageLocation } from "./page-location";

/** Text blocks a jump can land on, innermost first wins. */
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, summary, figcaption, aside";

/** The first hit the server marked in a search snippet (\u0002…\u0003). */
export function snippetHit(snippet: string | null | undefined): string {
  const hit = snippet?.split("\u0002")[1]?.split("\u0003")[0] || "";
  return hit.replace(/\s+/g, " ").trim();
}

/** Case- and whitespace-insensitive containment. */
export function textIncludes(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const n = norm(needle);
  return !!n && norm(haystack).includes(n);
}

export type JumpFinder = (scope: ParentNode) => Element | null | undefined;

/** The innermost text block containing `text`. */
export function byText(text: string): JumpFinder {
  return (scope) => {
    if (!text.trim()) return null;
    const hits = [...scope.querySelectorAll(BLOCKS)].filter((el) => textIncludes(el.textContent || "", text));
    return hits.find((el) => !hits.some((other) => other !== el && el.contains(other))) || null;
  };
}

/** The text block holding the first element matching `selector`. */
export function bySelector(selector: string): JumpFinder {
  return (scope) => {
    const el = scope.querySelector(selector);
    return el?.closest(BLOCKS) || el;
  };
}

/** The first finder that finds something. */
export function anyOf(...finders: JumpFinder[]): JumpFinder {
  return (scope) => {
    for (const find of finders) {
      const el = find(scope);
      if (el) return el;
    }
    return null;
  };
}

let pending: { stop: () => void } | null = null;
/**
 * After the navigation to `pageId` (and `rowId`, the record dialog), waits
 * up to a few seconds for the content to load, then scrolls the found block
 * into view and flashes it. A newer jump replaces an older one.
 */
export function jumpTo(target: { pageId: string; rowId?: string | null }, find: JumpFinder, timeout = 6000) {
  if (typeof window === "undefined") return;
  pending?.stop();
  const started = Date.now();
  const timer = setInterval(() => {
    const here = parsePageLocation(location.hash);
    const arrived = here?.pageId === target.pageId && (here.rowId || null) === (target.rowId || null);
    if (Date.now() - started > timeout || (Date.now() - started > 1500 && here && !arrived)) return stop();
    if (!arrived) return;
    const dialogs = document.querySelectorAll(".modal");
    const scope = target.rowId ? dialogs[dialogs.length - 1] : document.querySelector(".main-scroll") || document.querySelector(".main");
    if (!scope) return;
    // Only document content: titles and properties are visible anyway. The
    // live editor first; a read-only rendering only if no editor comes.
    let content = [...scope.querySelectorAll(".ProseMirror")];
    if (!content.length && Date.now() - started > 2000)
      content = [...scope.querySelectorAll(".document-editor")].filter(
        (el) => !el.parentElement?.closest(".document-editor"),
      );
    for (const root of content) {
      const el = find(root);
      if (el && el.getClientRects().length) {
        stop();
        reveal(el);
        return;
      }
    }
  }, 150);
  const stop = () => {
    clearInterval(timer);
    if (pending === handle) pending = null;
  };
  const handle = { stop };
  pending = handle;
}
