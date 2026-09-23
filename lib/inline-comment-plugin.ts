import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey, isStructuralTransaction } from "@tiptap/y-tiptap";
import type { InlineThread } from "./inline-comment-types";
import {
  commentRange,
  commentAnchor,
  type CommentBinding,
} from "./comment-positions";
const key = new PluginKey<{
  threads: InlineThread[];
  active: string | null;
  marks: DecorationSet;
}>("inlineComments");
export function editorCommentBinding(editor: Editor): CommentBinding | null {
  const state = ySyncPluginKey.getState(editor.state);
  return state?.binding?.mapping.size
    ? {
        doc: state.doc,
        type: state.type,
        mapping: state.binding.mapping,
        content: editor.state.doc,
      }
    : null;
}
export function selectedCommentAnchor(editor: Editor, generation: string) {
  const binding = editorCommentBinding(editor);
  if (!binding) throw new Error("Das Dokument wird noch geladen.");
  let { from, to, $from } = editor.state.selection;
  if (from === to && $from.depth > 0) {
    from = $from.start();
    to = $from.end();
  }
  return commentAnchor(binding, from, to, generation);
}
export function setCommentHighlights(
  editor: Editor,
  threads: InlineThread[],
  active: string | null,
) {
  if (!editor.isDestroyed)
    editor.view.dispatch(editor.state.tr.setMeta(key, { threads, active }));
}
export function inlineCommentExtension(generation: string) {
  return Extension.create({
    name: "inlineComments",
    addKeyboardShortcuts() {
      return {
        "Mod-Alt-m": () => {
          this.editor.view.dom.dispatchEvent(new CustomEvent("comment-create"));
          return true;
        },
      };
    },
    addProseMirrorPlugins() {
      return [
        new Plugin<{
          threads: InlineThread[];
          active: string | null;
          marks: DecorationSet;
        }>({
          key,
          state: {
            init: () => ({
              threads: [],
              active: null,
              marks: DecorationSet.empty,
            }),
            apply(tr, prev, old, state) {
              const meta = tr.getMeta(key),
                threads: InlineThread[] = meta?.threads || prev.threads,
                active = meta ? meta.active : prev.active;
              const sync = ySyncPluginKey.getState(state),
                remote = sync?.isChangeOrigin;
              if (
                tr.docChanged &&
                !remote &&
                isStructuralTransaction(tr, old.doc)
              )
                return { threads, active, marks: DecorationSet.empty };
              if (!meta && !remote)
                return { ...prev, marks: prev.marks.map(tr.mapping, tr.doc) };
              const marks: Decoration[] = [];
              if (sync?.binding?.mapping.size)
                for (const t of threads) {
                  if (t.resolved && t.id !== active) continue;
                  const range = commentRange(
                    {
                      doc: sync.doc,
                      type: sync.type,
                      mapping: sync.binding.mapping,
                      content: state.doc,
                    },
                    t.anchor,
                    generation,
                  );
                  if (range) {
                    const node = state.doc.nodeAt(range.from);
                    const attrs = {
                      class: `inline-comment-mark${t.id === active ? " inline-comment-active" : ""}`,
                      "data-comment-thread": t.id,
                    };
                    marks.push(
                      node?.isBlock && range.to === range.from + node.nodeSize
                        ? Decoration.node(range.from, range.to, attrs)
                        : Decoration.inline(range.from, range.to, attrs, {
                            inclusiveStart: false,
                            inclusiveEnd: true,
                          }),
                    );
                  }
                }
              return {
                threads,
                active,
                marks: DecorationSet.create(state.doc, marks),
              };
            },
          },
          props: {
            decorations: (state) => key.getState(state)?.marks,
            handleClick(view, _pos, event) {
              const target = (event.target as HTMLElement).closest<HTMLElement>(
                "[data-comment-thread]",
              );
              if (!target) return false;
              view.dom.dispatchEvent(
                new CustomEvent("comment-open", {
                  detail: target.dataset.commentThread,
                }),
              );
              return false;
            },
          },
        }),
      ];
    },
  });
}
