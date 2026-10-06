// Ticket numbers in text: "WEB-123" is shown as a link when a database in
// the workspace uses that prefix. Nothing is stored – the text stays plain,
// so references written before the ID property existed work too. A click
// opens the record, hovering shows its title and status.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TICKET_REF } from "./ticket-ids";
import { pageLocationHash } from "./page-location";
import { tr } from "./locale-tag";

type State = { prefixes: Set<string>; titles: Map<string, string>; decorations: DecorationSet };
const key = new PluginKey<State>("ticketRefs");

// Titles live in the plugin state: changing attributes of the editor's own
// elements by hand would make ProseMirror redraw them.
function decorate(doc: PMNode, prefixes: Set<string>, titles: Map<string, string>) {
  if (!prefixes.size) return DecorationSet.empty;
  const found: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code) return;
    if (node.marks.some((m) => m.type.name === "link" || m.type.name === "code")) return;
    for (const match of (node.text || "").matchAll(TICKET_REF))
      if (prefixes.has(match[1]))
        found.push(
          Decoration.inline(pos + match.index!, pos + match.index! + match[0].length, {
            class: "ticket-ref",
            "data-ticket": match[0],
            ...(titles.get(match[0]) ? { title: titles.get(match[0])! } : {}),
          }),
        );
  });
  return DecorationSet.create(doc, found);
}

async function resolve(pageId: string, ticket: string) {
  const response = await fetch(`/api/ticket-ref?page=${pageId}&key=${encodeURIComponent(ticket)}`, { cache: "no-store" });
  return response.ok ? ((await response.json()) as { pageId: string; rowId: string; title: string; status: string; database: string }) : null;
}

export const TicketRefs = Extension.create<{ pageId: string }>({
  name: "ticketRefs",
  addOptions() {
    return { pageId: "" };
  },
  addProseMirrorPlugins() {
    const pageId = this.options.pageId;
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => ({ prefixes: new Set<string>(), titles: new Map(), decorations: decorate(state.doc, new Set(), new Map()) }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(key) as Partial<Pick<State, "prefixes" | "titles">> | undefined;
            if (!tr.docChanged && !meta) return value;
            const next = { ...value, ...meta };
            return { ...next, decorations: decorate(state.doc, next.prefixes, next.titles) };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          handleDOMEvents: {
            mouseover(view, event) {
              const target = (event.target as HTMLElement).closest?.(".ticket-ref") as HTMLElement | null;
              const ticket = target?.dataset.ticket;
              const titles = key.getState(view.state)?.titles;
              if (!ticket || !titles || titles.has(ticket) || !pageId) return false;
              titles.set(ticket, "…");
              void resolve(pageId, ticket).then((found) => {
                if (view.isDestroyed) return;
                const hint = view.editable ? tr("⌘/Strg-Klick öffnet den Eintrag", "⌘/Ctrl-click opens the record") : "";
                const text = found
                  ? [[found.title, found.status, found.database].filter(Boolean).join(" · "), hint].filter(Boolean).join("\n")
                  : tr("Kein Eintrag mit dieser Nummer", "No record with this number");
                view.dispatch(view.state.tr.setMeta(key, { titles: new Map(titles).set(ticket, text) }));
              });
              return false;
            },
            click(view, event) {
              const target = (event.target as HTMLElement).closest?.(".ticket-ref") as HTMLElement | null;
              if (!target || !pageId) return false;
              // While writing a plain click places the cursor; Cmd/Ctrl-click
              // (or any click when reading) opens the record.
              if (view.editable && !(event.metaKey || event.ctrlKey)) return false;
              event.preventDefault();
              void resolve(pageId, target.dataset.ticket || "").then((found) => {
                if (found) location.hash = pageLocationHash({ pageId: found.pageId, rowId: found.rowId });
              });
              return true;
            },
          },
        },
        view: (view) => {
          let alive = true;
          if (pageId)
            void fetch(`/api/ticket-refs?page=${pageId}`, { cache: "no-store" })
              .then((r) => (r.ok ? r.json() : []))
              .then((list: { prefix: string }[]) => {
                if (alive && list.length && !view.isDestroyed)
                  view.dispatch(view.state.tr.setMeta(key, { prefixes: new Set(list.map((p) => p.prefix)) }));
              })
              .catch(() => {});
          return { destroy: () => void (alive = false) };
        },
      }),
    ];
  },
});
