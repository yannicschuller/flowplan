import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Text direction of blocks (Arabic, Hebrew, Persian … right to left). A block
// without a set direction follows its text: the first letter decides, like
// dir="auto" in HTML. A set direction ("ltr", "rtl") is stored as the block's
// "dir" attribute and goes into the HTML; Markdown has no place for it.
export type BlockDirection = "ltr" | "rtl";
export const TEXT_DIRECTION_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "callout",
  "toggle",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "table",
  "tableCell",
  "tableHeader",
];
const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
// The direction of the first letter of a text; null when it has none.
export function strongDirection(text: string): BlockDirection | null {
  const letter = /\p{L}/u.exec(text);
  if (!letter) return null;
  return RTL_LETTER.test(letter[0]) ? "rtl" : "ltr";
}
export const textDirection = (value: unknown): BlockDirection | null =>
  value === "ltr" || value === "rtl" ? value : null;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockDirection: {
      // Sets (or with null clears) the direction of the blocks at the
      // selection and of everything inside them.
      setBlockDirectionAt: (direction: BlockDirection | null) => ReturnType;
    };
  }
}

// Sets the direction on the block at `pos` and on all blocks inside it, so a
// list or table turns as a whole. Returns whether something changed.
export function setBlockDirection(
  tr: import("@tiptap/pm/state").Transaction,
  pos: number,
  direction: BlockDirection | null,
) {
  const node = tr.doc.nodeAt(pos);
  if (!node) return false;
  let changed = false;
  const apply = (target: PMNode, at: number) => {
    if (!TEXT_DIRECTION_TYPES.includes(target.type.name)) return;
    if ((target.attrs.dir ?? null) === direction) return;
    tr.setNodeAttribute(at, "dir", direction);
    changed = true;
  };
  apply(node, pos);
  node.descendants((child, offset) => {
    apply(child, pos + 1 + offset);
    return !child.isTextblock;
  });
  return changed;
}

const autoKey = new PluginKey<DecorationSet>("autoTextDirection");
// Decorations giving blocks without a set direction the one of their text,
// where it differs from what they would inherit. Bullets, checkboxes and
// quote bars then sit on the side the text starts on.
export function autoDirections(doc: PMNode) {
  const decorations: Decoration[] = [];
  const visit = (parent: PMNode, start: number, inherited: BlockDirection) => {
    parent.forEach((node, offset) => {
      const pos = start + offset;
      if (!node.isBlock) return;
      let own = inherited;
      if (TEXT_DIRECTION_TYPES.includes(node.type.name)) {
        const set = textDirection(node.attrs.dir);
        own = set || strongDirection(node.textContent) || inherited;
        if (!set && own !== inherited)
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir: own }));
      }
      if (!node.isTextblock && !node.isAtom) visit(node, pos + 1, own);
    });
  };
  visit(doc, 0, "ltr");
  return DecorationSet.create(doc, decorations);
}

export const BlockDirectionExtension = Extension.create<{ auto: boolean }>({
  name: "blockDirection",
  addOptions: () => ({ auto: false }),
  addGlobalAttributes() {
    return [
      {
        types: TEXT_DIRECTION_TYPES,
        attributes: {
          dir: {
            default: null,
            parseHTML: (element) => textDirection(element.getAttribute("dir")),
            renderHTML: (attributes) => {
              const dir = textDirection(attributes.dir);
              return dir ? { dir } : {};
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setBlockDirectionAt:
        (direction) =>
        ({ tr, state, dispatch }) => {
          const { from, to, $from } = state.selection;
          const positions = new Set<number>();
          // The innermost block with a direction at each end of the
          // selection, and those in between.
          // A line of a list item or table cell turns the whole item.
          const container = (pos: number) => {
            const $pos = state.doc.resolve(pos);
            for (let d = $pos.depth; d > 0; d--) {
              const name = $pos.node(d).type.name;
              if (["listItem", "taskItem", "tableCell", "tableHeader"].includes(name)) return $pos.before(d);
              if (TEXT_DIRECTION_TYPES.includes(name) && !$pos.node(d).isTextblock) break;
            }
            return null;
          };
          for (let d = $from.depth; d > 0; d--)
            if (TEXT_DIRECTION_TYPES.includes($from.node(d).type.name)) {
              positions.add(container($from.pos) ?? $from.before(d));
              break;
            }
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.isTextblock && TEXT_DIRECTION_TYPES.includes(node.type.name))
              positions.add(container(pos + 1) ?? pos);
            return !node.isTextblock;
          });
          let changed = false;
          for (const pos of positions) changed = setBlockDirection(tr, pos, direction) || changed;
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
  addProseMirrorPlugins() {
    if (!this.options.auto) return [];
    return [
      new Plugin<DecorationSet>({
        key: autoKey,
        state: {
          init: (_config, state) => autoDirections(state.doc),
          apply: (tr, value) => (tr.docChanged ? autoDirections(tr.doc) : value),
        },
        props: {
          decorations: (state) => autoKey.getState(state),
        },
      }),
    ];
  },
});

// The same for HTML shown without the editor (read-only pages, exports):
// blocks without a set direction get the one of their text where it differs.
const DOM_BLOCKS = "p,h1,h2,h3,h4,h5,h6,blockquote,aside,details,ul,ol,li,table,td,th";
export function applyTextDirections(root: HTMLElement) {
  const inherited = (element: Element): BlockDirection => {
    for (let el = element.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      const dir = textDirection(el.getAttribute("dir"));
      if (dir) return dir;
    }
    return "ltr";
  };
  for (const element of root.querySelectorAll<HTMLElement>(DOM_BLOCKS)) {
    if (element.hasAttribute("dir") && element.getAttribute("dir") !== "auto") continue;
    const parent = inherited(element);
    const own = strongDirection(element.textContent || "") || parent;
    if (own !== parent) element.setAttribute("dir", own);
    else if (element.getAttribute("dir") === "auto") element.removeAttribute("dir");
  }
}
