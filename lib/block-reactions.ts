// Emoji reactions on paragraphs and headings, stored in the document
// (data-reactions: emoji → user ids), so they travel with the block and
// sync live. Reactions show at the end of the block; the block with the
// cursor offers a smiley to add one.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const blockReactionsKey = new PluginKey("blockReactions");
export type BlockReactionMap = Record<string, string[]>;
const quick = ["👍", "❤️", "🎉", "😄", "👀", "✅", "🙏", "🔥"];
const types = ["paragraph", "heading"];

// Only well-formed values survive: up to 20 emojis with up to 200 ids each.
export function parseReactions(raw: unknown): BlockReactionMap | null {
  if (typeof raw !== "string" || !raw || raw.length > 20_000) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: BlockReactionMap = {};
    for (const [emoji, ids] of Object.entries(value).slice(0, 20)) {
      if (emoji.length > 32 || !Array.isArray(ids)) continue;
      const clean = ids.filter((id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id)).slice(0, 200);
      if (clean.length) out[emoji] = clean;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
export function toggleReaction(map: BlockReactionMap | null, emoji: string, userId: string) {
  const next: BlockReactionMap = { ...(map || {}) };
  const ids = next[emoji] || [];
  next[emoji] = ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId];
  if (!next[emoji].length) delete next[emoji];
  return Object.keys(next).length ? next : null;
}

// Schema part (server and client): the attribute on paragraphs and headings.
export const BlockReactionAttribute = Extension.create({
  name: "blockReactionAttribute",
  addGlobalAttributes() {
    return [
      {
        types,
        attributes: {
          reactions: {
            default: null,
            parseHTML: (element) => {
              const parsed = parseReactions(element.getAttribute("data-reactions"));
              return parsed ? JSON.stringify(parsed) : null;
            },
            renderHTML: (attributes) =>
              attributes.reactions ? { "data-reactions": attributes.reactions } : {},
          },
        },
      },
    ];
  },
});

type Options = { userId: string; names: () => Map<string, string> };

export function setReactions(view: EditorView, pos: number, emoji: string, userId: string) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !types.includes(node.type.name)) return;
  const next = toggleReaction(parseReactions(node.attrs.reactions), emoji, userId);
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      reactions: next ? JSON.stringify(next) : null,
    }),
  );
}
function widget(view: EditorView, pos: number, raw: unknown, showAdd: boolean, options: Options, editable: boolean) {
  const map = parseReactions(raw) || {};
  const box = document.createElement("span");
  box.className = "block-reactions";
  box.contentEditable = "false";
  const names = options.names();
  for (const [emoji, ids] of Object.entries(map)) {
    const pill = document.createElement(editable ? "button" : "span");
    pill.className = "block-reaction";
    if (ids.includes(options.userId)) pill.classList.add("mine");
    pill.textContent = `${emoji} ${ids.length}`;
    pill.title = ids.map((id) => names.get(id) || "Jemand").join(", ");
    if (editable && pill instanceof HTMLButtonElement) {
      pill.type = "button";
      pill.setAttribute("aria-pressed", String(ids.includes(options.userId)));
      pill.setAttribute("aria-label", `${emoji} ${ids.length}`);
      pill.addEventListener("mousedown", (e) => e.preventDefault());
      pill.addEventListener("click", () => setReactions(view, pos, emoji, options.userId));
    }
    box.append(pill);
  }
  if (showAdd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "block-reaction-add";
    // The symbol comes from CSS, so it never becomes part of the text.
    add.setAttribute("aria-label", "Auf Block reagieren");
    add.addEventListener("mousedown", (e) => e.preventDefault());
    add.addEventListener("click", () => {
      const open = box.querySelector(".block-reaction-picker");
      if (open) return open.remove();
      const picker = document.createElement("span");
      picker.className = "block-reaction-picker";
      for (const emoji of quick) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.textContent = emoji;
        choice.setAttribute("aria-label", `Mit ${emoji} reagieren`);
        choice.addEventListener("mousedown", (e) => e.preventDefault());
        choice.addEventListener("click", () => setReactions(view, pos, emoji, options.userId));
        picker.append(choice);
      }
      box.append(picker);
    });
    box.append(add);
  }
  return box;
}

export const BlockReactions = Extension.create<Options>({
  name: "blockReactions",
  addOptions() {
    return { userId: "", names: () => new Map() };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin({
        key: blockReactionsKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const editable = editor.isEditable && !!options.userId;
            const { $from, empty } = state.selection;
            const current = $from.depth > 0 && types.includes($from.parent.type.name) ? $from.before() : -1;
            state.doc.descendants((node, pos) => {
              if (!types.includes(node.type.name)) return true;
              const has = !!node.attrs.reactions;
              // Offer reacting on a block with text, where the cursor rests.
              // Adding goes through the text menu (select or right-click).
              const showAdd = false;
              if (has || showAdd)
                decorations.push(
                  Decoration.widget(
                    pos + node.nodeSize - 1,
                    (view) => widget(view, pos, node.attrs.reactions, showAdd, options, editable),
                    {
                      side: 1,
                      ignoreSelection: true,
                      key: `reactions-${pos}-${node.attrs.reactions || ""}-${showAdd}-${editable}`,
                    },
                  ),
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

// The paragraph or heading around a position (for reacting from a menu).
export function reactionBlockAt(doc: import("@tiptap/pm/model").Node, pos: number) {
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  for (let d = $pos.depth; d > 0; d--)
    if (types.includes($pos.node(d).type.name)) return $pos.before(d);
  return null;
}
