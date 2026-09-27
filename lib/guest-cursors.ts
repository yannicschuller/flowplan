// Cursors in the guest editor of an edit link: the guest's position goes
// out as text address, members and other guests come back the same way
// (lib/share-presence.ts). Rendering is shared with collaboration-cursors.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { decorations, type Peer } from "./collaboration-cursors";
import { toTextCursor } from "./text-anchors";
import type { CursorPeer } from "./cursor-protocol";

type State = { peers: Peer[]; decorations: DecorationSet };
const key = new PluginKey<State>("flowplanGuestCursors");

export function guestCursors(scope: { token: string; pageId: string; rowId?: string; clientId: string }) {
  return Extension.create({
    name: "flowplanGuestCursors",
    addProseMirrorPlugins() {
      return [
        new Plugin<State>({
          key,
          state: {
            init: () => ({ peers: [], decorations: DecorationSet.empty }),
            apply(tr, previous, _old, next) {
              const peers: Peer[] = tr.getMeta(key) ?? previous.peers;
              return {
                peers,
                decorations: tr.getMeta(key) || tr.docChanged ? decorations(next, peers) : previous.decorations,
              };
            },
          },
          props: { decorations: (state) => key.getState(state)?.decorations },
          view(view) {
            let timer: ReturnType<typeof setTimeout> | undefined,
              sending = false,
              again = false,
              destroyed = false,
              last = "";
            const liveKey = `guest:${scope.pageId}:${scope.rowId || ""}`;
            const show = (peers: CursorPeer[]) => {
              if (destroyed || view.isDestroyed) return;
              view.dispatch(
                view.state.tr.setMeta(
                  key,
                  peers.map((p) => ({ ...p, deadline: Date.now() + Math.min(15_000, p.expiresInMs) })),
                ),
              );
            };
            const send = async () => {
              if (sending) {
                again = true;
                return;
              }
              sending = true;
              const text = view.hasFocus()
                ? toTextCursor(view.state.doc, view.state.selection.anchor, view.state.selection.head)
                : null;
              try {
                const response = await fetch(`/api/share/${scope.token}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "presence",
                    pageId: scope.pageId,
                    rowId: scope.rowId,
                    clientId: scope.clientId,
                    text,
                  }),
                });
                if (response.ok) show(((await response.json()) as { peers: CursorPeer[] }).peers);
              } catch {
                /* The next move or heartbeat tries again. */
              } finally {
                sending = false;
                if (again) {
                  again = false;
                  void send();
                }
              }
            };
            const schedule = (delay = 60) => {
              clearTimeout(timer);
              timer = setTimeout(() => void send(), delay);
            };
            const ping = (event: Event) => {
              if ((event as CustomEvent<string>).detail === liveKey) schedule(0);
            };
            // Heartbeat keeps the cursor alive for the others and expires theirs.
            const heartbeat = setInterval(() => {
              if (!document.hidden) void send();
            }, 5000);
            window.addEventListener("flowplan:presence", ping);
            view.dom.addEventListener("focusin", () => schedule(0));
            view.dom.addEventListener("focusout", () => schedule(0));
            schedule(0);
            return {
              update() {
                const next = JSON.stringify([view.state.selection.anchor, view.state.selection.head, view.hasFocus()]);
                if (next !== last) {
                  last = next;
                  schedule();
                }
              },
              destroy() {
                destroyed = true;
                clearTimeout(timer);
                clearInterval(heartbeat);
                window.removeEventListener("flowplan:presence", ping);
                void fetch(`/api/share/${scope.token}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "presence", pageId: scope.pageId, rowId: scope.rowId, clientId: scope.clientId, text: null }),
                  keepalive: true,
                }).catch(() => {});
              },
            };
          },
        }),
      ];
    },
  });
}
