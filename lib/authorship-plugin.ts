// "Autoren anzeigen": colours the text by who wrote it (lib/authorship.ts).
// Only decorations – the document itself is never touched. Switched on and
// off with a meta transaction carrying the sessions → people table.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { attributeRuns, authorColor, authorRuns, authorShares } from "./authorship";

export type AuthorshipInfo = {
  clients: Record<string, string>;
  self: { client: number; userId: string };
  names: Record<string, string>;
  earlier: string;
};
type State = { info: AuthorshipInfo | null; decorations: DecorationSet };
export const authorshipKey = new PluginKey<State>("authorship");
export type AuthorShares = { shares: [string | null, number][]; unknown: number[] };

export const Authorship = Extension.create<{ onShares?: (result: AuthorShares) => void }>({
  name: "authorship",
  addOptions() {
    return { onShares: undefined };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<State>({
        key: authorshipKey,
        state: {
          init: () => ({ info: null, decorations: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(authorshipKey) as Partial<State> | undefined;
            if (meta && "info" in meta && !meta.info) return { info: null, decorations: DecorationSet.empty };
            if (meta) return { ...value, ...meta };
            return tr.docChanged ? { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) } : value;
          },
        },
        props: { decorations: (state) => authorshipKey.getState(state)?.decorations },
        // Computed after the editor and Yjs are in step again (a moment
        // after each change), not inside the transaction.
        view: (view) => {
          let timer: ReturnType<typeof setTimeout> | undefined,
            lastDoc: PMNode | null = null,
            lastInfo: AuthorshipInfo | null = null;
          const compute = () => {
            timer = undefined;
            const info = authorshipKey.getState(view.state)?.info;
            const binding = (ySyncPluginKey.getState(view.state) as { binding?: { type: Y.XmlFragment; mapping: Map<Y.AbstractType<unknown>, PMNode | PMNode[]> } } | undefined)?.binding;
            if (!info || !binding || view.isDestroyed) return;
            const doc = view.state.doc;
            const runs = authorRuns(binding.type, doc, binding.mapping);
            const ranges = attributeRuns(runs, info.clients, info.self).filter((r) => r.from < r.to && r.to <= doc.content.size);
            const decorations = DecorationSet.create(
              doc,
              ranges.map((r) =>
                Decoration.inline(
                  r.from,
                  r.to,
                  r.userId
                    ? { class: "author-mark", style: `background-color: ${authorColor(r.userId)}`, title: info.names[r.userId] || "" }
                    : { class: "author-mark earlier", title: info.earlier },
                ),
              ),
            );
            lastDoc = doc;
            lastInfo = info;
            const unknown = [...new Set(runs.map((r) => r.client))].filter((c) => !info.clients[c] && c !== info.self.client);
            options.onShares?.({ shares: authorShares(ranges), unknown });
            view.dispatch(view.state.tr.setMeta(authorshipKey, { decorations }).setMeta("addToHistory", false));
          };
          return {
            update(view) {
              const info = authorshipKey.getState(view.state)?.info || null;
              if (!info) {
                lastInfo = null;
                if (timer) clearTimeout(timer);
                timer = undefined;
                return;
              }
              if (view.state.doc === lastDoc && info === lastInfo) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(compute, lastInfo === info ? 250 : 0);
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
