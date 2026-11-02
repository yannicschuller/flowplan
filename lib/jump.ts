// Orientation after a jump: when a search hit, a backlink, a mention or a
// notification opens a page, the block it is about flashes briefly once it
// has loaded (lib/motion.ts `flash`). Nothing is stored: the highlight is an
// overlay that removes itself.
import { reveal } from "./motion";
import { isFolded } from "./heading-folds";
import { parsePageLocation } from "./page-location";
import { findBlock } from "./block-ids";
import type { Node as PMNode } from "@tiptap/pm/model";

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

/**
 * A block by its id (block links, lib/block-ids.ts): its element, or – for
 * blocks the editor draws itself (code, formulas, diagrams …) – the
 * editor's element for it.
 */
export function byBlockId(blockId: string): JumpFinder {
  return (scope) => {
    const el = scope.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    if (el) return el;
    // Tiptap keeps its editor on the editor's element.
    const editor = (scope as Element & { editor?: { state: { doc: PMNode }; view: { nodeDOM: (pos: number) => unknown } } }).editor;
    const block = editor ? findBlock(editor.state.doc, blockId) : null;
    const dom = block ? editor!.view.nodeDOM(block.pos) : null;
    return dom instanceof Element ? dom : null;
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
export function jumpTo(
  target: { pageId: string; rowId?: string | null },
  find: JumpFinder,
  timeout = 6000,
  // onMissing: the page is there with its text, but the block is not (a
  // block link to a deleted block); onDone: found or given up.
  options: { onMissing?: () => void; onDone?: () => void } = {},
) {
  if (typeof window === "undefined") return;
  pending?.stop();
  const started = Date.now();
  // When the text came (a block link waits a little longer for its block:
  // the live document may still be catching up).
  let loaded = 0;
  const timer = setInterval(() => {
    const here = parsePageLocation(location.hash);
    const arrived = here?.pageId === target.pageId && (here.rowId || null) === (target.rowId || null);
    if (Date.now() - started > timeout || (Date.now() - started > 1500 && here && !arrived)) {
      if (arrived && loaded) options.onMissing?.();
      return stop();
    }
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
    if (content.length) loaded ||= Date.now();
    for (const root of content) {
      const el = find(root);
      // A block in a folded section counts too: reveal() unfolds it.
      if (el && (el.getClientRects().length || isFolded(el))) {
        stop();
        reveal(el);
        return;
      }
    }
    if (options.onMissing && loaded && Date.now() - loaded > 2500) {
      options.onMissing();
      stop();
    }
  }, 150);
  const stop = () => {
    clearInterval(timer);
    if (pending === handle) pending = null;
    options.onDone?.();
  };
  const handle = { stop };
  pending = handle;
}
