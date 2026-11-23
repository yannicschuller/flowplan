import { Extension, type Editor, type NodeViewRenderer } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { commentColorOf } from "./comment-colors";
import { ySyncPluginKey, isStructuralTransaction } from "@tiptap/y-tiptap";
import type { InlineThread } from "./inline-comment-types";
import {
  commentRange,
  commentAnchor,
  commentQuote,
  movedCommentRange,
  type BlockMove,
  type CommentBinding,
} from "./comment-positions";
import { BLOCK_MOVE_META } from "./document-blocks";
// Passages of threads that moved with blocks (see movedCommentRange), in
// the document after `source` and the transactions appended to it.
export type RelocatedComments = {
  source: Transaction;
  ranges: { id: string; from: number; to: number; quote: string }[];
};
type CommentState = {
  threads: InlineThread[];
  active: string | null;
  marks: DecorationSet;
  relocated: RelocatedComments | null;
};
const key = new PluginKey<CommentState>("inlineComments");
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
// The threads whose passage moved in `tr` (a block moved up, down or
// dragged), with fresh anchors now that Yjs holds the move – to store on
// the server (thread.reanchor). Call it from the editor's transaction event.
export function relocatedCommentAnchors(
  editor: Editor,
  tr: Transaction,
  generation: string,
) {
  const relocated = key.getState(editor.state)?.relocated;
  if (!relocated || relocated.source !== tr) return [];
  const binding = editorCommentBinding(editor);
  if (!binding) return [];
  const result: { id: string; anchor: ReturnType<typeof commentAnchor> }[] = [];
  for (const r of relocated.ranges) {
    try {
      if (commentQuote(binding.content, r.from, r.to) !== r.quote) continue;
      const anchor = commentAnchor(binding, r.from, r.to, generation),
        back = commentRange(binding, anchor, generation);
      if (back?.from === r.from && back.to === r.to)
        result.push({ id: r.id, anchor });
    } catch {}
  }
  return result;
}
export function setCommentHighlights(
  editor: Editor,
  threads: InlineThread[],
  active: string | null,
) {
  if (!editor.isDestroyed)
    editor.view.dispatch(editor.state.tr.setMeta(key, { threads, active }));
}
type CommentAttrs = {
  class: string;
  "data-comment-thread": string;
  "data-comment-color": string;
  "data-comment-count"?: string;
};
// The number shown after a passage (#450): every message of the thread, the
// first one included – a new comment's own highlight (no messages yet)
// shows none.
export function commentCount(thread: Pick<InlineThread, "messageCount">): string {
  const n = Number(thread.messageCount) || 0;
  return n > 0 ? (n > 99 ? "99+" : String(n)) : "";
}
function countWidget(id: string, color: string, count: string) {
  const el = document.createElement("span");
  el.className = "inline-comment-count";
  el.contentEditable = "false";
  el.dataset.commentThread = id;
  el.dataset.commentColor = color;
  el.dataset.commentCount = count;
  el.setAttribute("aria-hidden", "true");
  return el;
}
// The end of the last text inside from…to: where the count goes (a passage
// may end in an empty paragraph or after a hard break).
export function lastTextPosition(doc: ProseMirrorNode, from: number, to: number): number | null {
  let last: number | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const end = Math.min(to, pos + node.nodeSize);
      if (end > Math.max(from, pos)) last = end;
    }
  });
  return last;
}
// Wrapping node views (resizable images) render the node inside a container,
// which receives the node decoration; the mark belongs on the inner element.
export function commentMarkedNodeView(
  render: NodeViewRenderer,
  selector: string,
): NodeViewRenderer {
  return (props) => {
    const nodeView = render(props),
      target =
        nodeView.dom instanceof HTMLElement
          ? nodeView.dom.querySelector<HTMLElement>(selector)
          : null;
    if (!target) return nodeView;
    const mark = (decos: readonly Decoration[]) => {
      const attrs = decos.find((d) => d.spec.comment)?.spec.comment as
        CommentAttrs | undefined;
      target.classList.toggle("inline-comment-mark", !!attrs);
      target.classList.toggle(
        "inline-comment-active",
        !!attrs?.class.includes("inline-comment-active"),
      );
      if (attrs) {
        target.dataset.commentThread = attrs["data-comment-thread"];
        target.dataset.commentColor = attrs["data-comment-color"];
      } else {
        delete target.dataset.commentThread;
        delete target.dataset.commentColor;
      }
      // The count (#450) at the corner of the box around the image (an
      // image draws no ::after of its own; the container is as wide as the
      // text, app/comment-margin.css).
      const box = target.closest<HTMLElement>("[data-resize-wrapper]");
      if (box && attrs?.["data-comment-count"]) {
        box.dataset.commentCount = attrs["data-comment-count"];
        box.dataset.commentColor = attrs["data-comment-color"];
      } else if (box) {
        delete box.dataset.commentCount;
        delete box.dataset.commentColor;
      }
    };
    mark(props.decorations);
    const update = nodeView.update?.bind(nodeView);
    if (update)
      nodeView.update = (n, decos, innerDecos) => {
        const ok = update(n, decos, innerDecos);
        if (ok) mark(decos);
        return ok;
      };
    return nodeView;
  };
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
        new Plugin<CommentState>({
          key,
          state: {
            init: () => ({
              threads: [],
              active: null,
              marks: DecorationSet.empty,
              relocated: null,
            }),
            apply(tr, prev, old, state) {
              const meta = tr.getMeta(key),
                threads: InlineThread[] = meta?.threads || prev.threads,
                active = meta ? meta.active : prev.active;
              const sync = ySyncPluginKey.getState(state),
                remote = sync?.isChangeOrigin;
              const move = tr.getMeta(BLOCK_MOVE_META) as BlockMove | undefined;
              let relocated: RelocatedComments | null = null;
              if (move && !remote && sync?.binding?.mapping.size) {
                // Yjs and its mapping still describe the document before
                // this transaction: where the passages were.
                const before: CommentBinding = {
                  doc: sync.doc,
                  type: sync.type,
                  mapping: sync.binding.mapping,
                  content: old.doc,
                };
                const ranges: RelocatedComments["ranges"] = [];
                for (const t of threads) {
                  const range = commentRange(before, t.anchor, generation),
                    next =
                      range &&
                      movedCommentRange(old.doc, tr.doc, tr.mapping, move, range);
                  if (range && next)
                    ranges.push({
                      id: t.id,
                      ...next,
                      quote: commentQuote(old.doc, range.from, range.to),
                    });
                }
                relocated = { source: tr, ranges };
              } else if (
                prev.relocated &&
                tr.getMeta("appendedTransaction") === prev.relocated.source
              )
                // Transactions appended to the move (block ids …).
                relocated = {
                  source: prev.relocated.source,
                  ranges: prev.relocated.ranges.map((r) => ({
                    ...r,
                    from: tr.mapping.map(r.from, 1),
                    to: tr.mapping.map(r.to, -1),
                  })),
                };
              if (
                tr.docChanged &&
                !remote &&
                isStructuralTransaction(tr, old.doc)
              )
                return { threads, active, marks: DecorationSet.empty, relocated };
              if (!meta && !remote)
                return {
                  ...prev,
                  marks: prev.marks.map(tr.mapping, tr.doc),
                  relocated,
                };
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
                    const count = commentCount(t);
                    const attrs: CommentAttrs = {
                      class: `inline-comment-mark${t.id === active ? " inline-comment-active" : ""}`,
                      "data-comment-thread": t.id,
                      "data-comment-color": commentColorOf(t.color),
                    };
                    if (node?.isBlock && range.to === range.from + node.nodeSize) {
                      const block = count ? { ...attrs, "data-comment-count": count } : attrs;
                      marks.push(
                        Decoration.node(range.from, range.to, block, {
                          comment: block,
                        }),
                      );
                    } else {
                      marks.push(
                        Decoration.inline(range.from, range.to, attrs, {
                          inclusiveStart: false,
                          inclusiveEnd: true,
                        }),
                      );
                      // The number of comments, raised after the passage
                      // (#450): an empty widget at its last letter that CSS
                      // draws (::after) from its data attribute – never text
                      // in the document, so copying, exports and the
                      // collaboration never see it, and the highlight stays
                      // one piece.
                      const last = count ? lastTextPosition(state.doc, range.from, range.to) : null;
                      if (last !== null)
                        marks.push(
                          Decoration.widget(last, () => countWidget(t.id, attrs["data-comment-color"], count), {
                            side: -1,
                            ignoreSelection: true,
                            key: `comment-count:${t.id}:${count}:${attrs["data-comment-color"]}`,
                          }),
                        );
                    }
                  }
                }
              return {
                threads,
                active,
                marks: DecorationSet.create(state.doc, marks),
                relocated,
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
