// The editor side of block ids (lib/block-ids.ts, #88):
// - BlockIds gives blocks that are new or changed by this person an id, and
//   a block that shares its id with an earlier one (a copy) a new one. Only
//   local changes: ids from other people arrive with their blocks, so two
//   editors never race to name the same new block. Blocks of older
//   documents get theirs once they are edited, or when someone copies a
//   link to them.
// - HeadingLinks shows a small link symbol after a heading (on hover, and
//   in the outline); a click copies the heading's link.
import { Extension, getChangedRanges } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { linkableBlocks, newBlockId, validBlockId } from "./block-ids";
import { tr } from "./locale-tag";

export const blockIdsKey = new PluginKey("blockIds");

type Range = { from: number; to: number };
// The ids for the blocks in `ranges` (where this person changed something):
// a block without id, or one whose id an earlier block already has (a
// copy), gets a new one. Attribute steps only: suggestions
// (lib/suggestions.ts) leave them alone. Null when nothing is missing.
export function blockIdTransaction(state: EditorState, ranges: Range[]): Transaction | null {
  if (!ranges.length) return null;
  const touched = (pos: number, size: number) => ranges.some((r) => pos <= r.to && pos + size >= r.from);
  const seen = new Set<string>();
  const fix: { pos: number; id: string }[] = [];
  for (const { node, pos } of linkableBlocks(state.doc)) {
    const id = validBlockId(node.attrs.blockId);
    if (id && !seen.has(id)) {
      seen.add(id);
      continue;
    }
    if (!touched(pos, node.nodeSize)) continue;
    let fresh = newBlockId();
    while (seen.has(fresh)) fresh = newBlockId();
    seen.add(fresh);
    fix.push({ pos, id: fresh });
  }
  if (!fix.length) return null;
  const change = state.tr;
  for (const { pos, id } of fix) change.setNodeAttribute(pos, "blockId", id);
  return change.setMeta(blockIdsKey, true);
}

// Script animations (Web Animations, not CSS) running in the editor: the
// glide of moved blocks and their neighbours.
const gliding = (dom: HTMLElement | undefined) =>
  (dom?.getAnimations?.({ subtree: true }) ?? []).some(
    (a) => a.playState === "running" && !("animationName" in a) && !("transitionProperty" in a),
  );

// Collects where local changes happened and names the blocks there right
// after the change, in a transaction of its own: appended to the typing
// itself, the Yjs binding could not follow it (its position tracking
// expects the synced text of the previous change).
export function blockIdsPlugin() {
  let ranges: Range[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Plugin({
    key: blockIdsKey,
    appendTransaction(transactions) {
      for (const t of transactions) {
        if (!t.docChanged) continue;
        ranges = ranges.map((r) => ({ from: t.mapping.map(r.from, -1), to: t.mapping.map(r.to, 1) }));
        if (t.getMeta(blockIdsKey) || t.getMeta(ySyncPluginKey)?.isChangeOrigin) continue;
        ranges.push(...getChangedRanges(t).map((r) => r.newRange));
      }
      return null;
    },
    view: () => ({
      update(view) {
        if (!ranges.length || timer) return;
        const since = Date.now();
        const run = () => {
          timer = null;
          if (view.isDestroyed) return;
          // Not in the middle of a composition (IME, dictation).
          if (view.composing) {
            timer = setTimeout(run, 200);
            return;
          }
          // Not while moved blocks glide into place (lib/block-shortcuts.ts):
          // a new id redraws the block, which ends its glide – the block
          // would jump while its handle still glides. At most two seconds.
          if (Date.now() - since < 2000 && gliding(view.dom)) {
            timer = setTimeout(run, 50);
            return;
          }
          const change = blockIdTransaction(view.state, ranges);
          ranges = [];
          if (change) view.dispatch(change);
        };
        timer = setTimeout(run, 0);
      },
      destroy() {
        if (timer) clearTimeout(timer);
        timer = null;
      },
    }),
  });
}
export const BlockIds = Extension.create({
  name: "blockIds",
  addProseMirrorPlugins: () => [blockIdsPlugin()],
});

const LINK_ICON =
  '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M137.54 186.36a8 8 0 0 1 0 11.31l-9.94 10a56 56 0 0 1-79.22-79.27l24.12-24.12a56 56 0 0 1 76.81-2.28 8 8 0 1 1-10.64 12 40 40 0 0 0-54.85 1.63L59.7 139.72a40 40 0 0 0 56.58 56.58l9.94-9.94a8 8 0 0 1 11.32 0Zm70.08-138a56.08 56.08 0 0 0-79.22 0l-9.94 9.95a8 8 0 0 0 11.32 11.31l9.94-9.94a40 40 0 0 1 56.58 56.58l-24.12 24.14a40 40 0 0 1-54.85 1.6 8 8 0 1 0-10.64 12 56 56 0 0 0 76.81-2.26l24.12-24.12a56.08 56.08 0 0 0 0-79.24Z"/></svg>';

type HeadingLinkOptions = { copy: (pos: number) => void; enabled: () => boolean };

function linkButton(view: EditorView, getPos: () => number | undefined, copy: (pos: number) => void) {
  const button = document.createElement("span");
  button.className = "heading-link";
  button.contentEditable = "false";
  button.setAttribute("role", "button");
  button.tabIndex = -1;
  const label = tr("Link zur Überschrift kopieren", "Copy link to heading");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = LINK_ICON;
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = getPos();
    // The widget sits at the end of the heading's text.
    if (typeof pos !== "number") return;
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name === "heading") copy($pos.before());
  });
  return button;
}

export const HeadingLinks = Extension.create<HeadingLinkOptions>({
  name: "headingLinks",
  addOptions() {
    return { copy: () => {}, enabled: () => true };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("headingLinks"),
        props: {
          decorations(state) {
            if (!options.enabled()) return null;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "heading") return node.isBlock && !node.isAtom;
              if (node.textContent.trim())
                decorations.push(
                  Decoration.widget(pos + node.nodeSize - 1, (view, getPos) => linkButton(view, getPos, options.copy), {
                    side: 1,
                    ignoreSelection: true,
                    stopEvent: () => true,
                    key: "heading-link",
                  }),
                );
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
