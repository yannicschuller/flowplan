"use client";
// Links to pages and records show the target's own icon (#96): emoji,
// uploaded picture or library symbol, else the default of its kind. One
// store for the whole tab:
//   - the app hands it the pages of the sidebar tree (setLinkTargetPages),
//     so icons follow renames and new icons at once, like the titles;
//   - records, and pages the tree does not have, are asked for in batches
//     (GET /api/link-targets) and asked again after a minute;
//   - published pages hand it the pages of the publication and ask nothing.
// Targets the person may not read stay unknown: the link keeps the plain
// link symbol of app/globals.css, with no hint of the target.
// Drawn by the editor (PageLinkIcons, widget decorations inside the link),
// read-only documents (decorateLinkIcons) and React links (LinkTargetIcon).
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { hasOwnIcon, iconType, linkLocation, shownPageIcon, targetKey } from "@/lib/page-link-icons";
import type { PageLocation } from "@/lib/page-location";
import { PageIcon } from "./ui";

type Info = { icon: string; kind: string };
type TargetPage = { id: string; icon: string; kind: string; deleted_at?: string | null };
const REFETCH_AFTER = 60_000;

const tree = new Map<string, Info>();
const fetched = new Map<string, { info: Info | null; at: number }>();
const queued = new Set<string>();
let mode: "app" | "share" = "app";
let treeSignature = "";
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  listeners.forEach((listener) => listener());
};

// The pages this tab knows with their icons: the sidebar tree in the app
// ("app": others are asked for), the published pages ("share": nothing else).
export function setLinkTargetPages(pages: readonly TargetPage[], source: "app" | "share" = "app") {
  const live = pages.filter((p) => !p.deleted_at);
  const signature = source + live.map((p) => `${p.id}${p.kind}${p.icon}`).join("|");
  if (signature === treeSignature) return;
  treeSignature = signature;
  if (source !== mode) fetched.clear();
  mode = source;
  tree.clear();
  for (const p of live) tree.set(p.id, { icon: p.icon || "", kind: p.kind });
  notify();
}

async function load() {
  timer = null;
  const keys = [...queued].slice(0, 100);
  keys.forEach((key) => queued.delete(key));
  if (!keys.length) return;
  let targets: Record<string, Info> = {};
  try {
    const response = await fetch(`/api/link-targets?ids=${encodeURIComponent(keys.join(","))}`, { cache: "no-store" });
    if (response.ok) targets = ((await response.json()) as { targets?: Record<string, Info> }).targets || {};
  } catch {
    // Offline: unknown for now, asked again later.
  }
  const now = Date.now();
  for (const key of keys) fetched.set(key, { info: targets[key] || null, at: now });
  if (queued.size) timer = setTimeout(load, 50);
  notify();
}

// What the store knows about a link's target: its icon and kind, null when
// it cannot be shown (no access, gone, another site), undefined while asking.
export function linkTargetInfo(location: Pick<PageLocation, "pageId" | "rowId">): Info | null | undefined {
  if (!location.rowId) {
    const page = tree.get(location.pageId);
    if (page) return page;
  }
  if (mode === "share") return null;
  const key = targetKey(location);
  const known = fetched.get(key);
  if (!known || Date.now() - known.at > REFETCH_AFTER) {
    if (typeof window !== "undefined" && !queued.has(key)) {
      queued.add(key);
      timer ??= setTimeout(load, 30);
    }
  }
  return known ? known.info : undefined;
}

export function subscribeLinkTargets(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function useLinkTargetsVersion() {
  return useSyncExternalStore(
    subscribeLinkTargets,
    () => version,
    () => 0,
  );
}

// The icon a link shows, or null for the plain link symbol.
export function linkIconFor(href: string | null | undefined): string | null {
  const target = linkLocation(href, typeof window === "undefined" ? undefined : window.location.origin);
  if (!target) return null;
  const info = linkTargetInfo(target);
  if (!info) return null;
  // A block link keeps its paragraph mark unless the page has its own icon.
  if (target.blockId && !hasOwnIcon(info.icon)) return null;
  return shownPageIcon(info.icon, target.rowId ? "record" : info.kind);
}

// The icon as a DOM element (editor widgets, read-only HTML).
const roots = new WeakMap<HTMLElement, Root>();
export function linkIconElement(name: string, doc: Document = document): HTMLElement {
  const span = doc.createElement("span");
  span.className = "page-link-icon";
  span.contentEditable = "false";
  span.setAttribute("aria-hidden", "true");
  span.dataset.linkIcon = name;
  const glyph = doc.createElement("span");
  glyph.className = "page-link-glyph";
  span.append(glyph);
  const type = iconType(name);
  if (type === "emoji") {
    span.classList.add("page-link-emoji");
    glyph.textContent = name;
  } else if (type === "image") {
    const img = doc.createElement("img");
    img.src = name;
    img.alt = "";
    img.className = "page-image-icon";
    glyph.append(img);
  } else {
    const root = createRoot(glyph);
    root.render(<PageIcon name={name} size={14} />);
    roots.set(span, root);
  }
  return span;
}
export function destroyLinkIcon(element: Node) {
  const root = roots.get(element as HTMLElement);
  if (!root) return;
  roots.delete(element as HTMLElement);
  // Not while React may be rendering.
  setTimeout(() => root.unmount());
}

// React links (comments, lists): the icon in front of the text.
export function LinkTargetIcon({ href }: { href: string }) {
  useLinkTargetsVersion();
  const name = linkIconFor(href);
  if (!name) return null;
  return (
    <span className={`page-link-icon${iconType(name) === "emoji" ? " page-link-emoji" : ""}`} aria-hidden="true" data-link-icon={name}>
      <span className="page-link-glyph">{iconType(name) === "emoji" ? name : <PageIcon name={name} size={14} />}</span>
    </span>
  );
}

// Links in running text, not the buttons of embeds and cards.
const TEXT = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, summary";
const NOT_TEXT = ".whiteboard-embed, .link-card, .linked-database, .synced-block, [data-plugin], .page-link-icon";
// Read-only HTML (reading mode, published pages, feeds): icons in front of
// every page link, kept up to date; returns the cleanup.
export function decorateLinkIcons(root: HTMLElement): () => void {
  const draw = () => {
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!a.closest(TEXT) || a.closest(NOT_TEXT)) continue;
      const name = linkIconFor(a.getAttribute("href"));
      const current = a.querySelector<HTMLElement>(":scope > .page-link-icon");
      if ((current?.dataset.linkIcon || null) === name) continue;
      if (current) {
        destroyLinkIcon(current);
        current.remove();
      }
      if (name) a.prepend(linkIconElement(name, root.ownerDocument));
    }
  };
  draw();
  const unsubscribe = subscribeLinkTargets(draw);
  return () => {
    unsubscribe();
    for (const icon of root.querySelectorAll("a > .page-link-icon")) {
      destroyLinkIcon(icon);
      icon.remove();
    }
  };
}

// The editor: a widget at the start of each link to a page or record,
// drawn inside the link (same mark), so it reads "📄 Title" as one chip.
const iconsKey = new PluginKey<DecorationSet>("pageLinkIcons");
export function iconDecorations(doc: PMNode) {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let previous: unknown = null;
    block.forEach((child, offset) => {
      const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
      const href = typeof link?.attrs.href === "string" ? link.attrs.href : null;
      if (link && href && !(previous && (previous as typeof link).eq(link))) {
        const name = linkIconFor(href);
        if (name)
          decorations.push(
            Decoration.widget(blockPos + 1 + offset, () => linkIconElement(name), {
              side: 1,
              marks: [link],
              key: `link-icon:${name}`,
              ignoreSelection: true,
              destroy: destroyLinkIcon,
            }),
          );
      }
      previous = link || null;
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}
export const PageLinkIcons = Extension.create({
  name: "pageLinkIcons",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: iconsKey,
        state: {
          init: (_, state) => iconDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(iconsKey) ? iconDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => iconsKey.getState(state) },
        view: (view) => ({
          // New icons, renames of the tree, answers for records.
          destroy: subscribeLinkTargets(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(iconsKey, true).setMeta("addToHistory", false));
          }),
        }),
      }),
    ];
  },
});
