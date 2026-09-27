import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  isStructuralTransaction,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  cursorColor,
  type Cursor,
  type CursorPeer,
  type CursorRequest,
} from "./cursor-protocol";
import { fromTextPoint, toTextCursor } from "./text-anchors";

export type Peer = CursorPeer & { deadline: number };
type PresenceState = { peers: Peer[]; decorations: DecorationSet };
const key = new PluginKey<PresenceState>("flowplanCursors");

export function decorations(state: EditorState, peers: Peer[]) {
  const sync = ySyncPluginKey.getState(state);
  const yjs = !!sync?.binding?.mapping.size && !sync.snapshot && !sync.prevSnapshot;
  if (sync && !yjs) return DecorationSet.empty;
  const marks: Decoration[] = [];
  for (const peer of peers) {
    if (peer.deadline <= Date.now()) continue;
    const resolve = (position: Cursor["anchor"]) => {
      if (!yjs) return null;
      try {
        return relativePositionToAbsolutePosition(
          sync.doc,
          sync.type,
          Y.createRelativePositionFromJSON(position),
          sync.binding.mapping,
        );
      } catch {
        return null;
      }
    };
    // Guests (and members seen by guests) come as text addresses.
    const a = peer.cursor ? resolve(peer.cursor.anchor) : peer.text ? fromTextPoint(state.doc, peer.text.anchor) : null,
      h = peer.cursor ? resolve(peer.cursor.head) : peer.text ? fromTextPoint(state.doc, peer.text.head) : null;
    if (a === null || h === null) continue;
    const max = Math.max(0, state.doc.content.size - 1),
      anchor = Math.min(a, max),
      head = Math.min(h, max);
    const color = cursorColor(peer.userId);
    marks.push(
      Decoration.widget(
        head,
        () => {
          const caret = document.createElement("span");
          caret.className = "collaborator-cursor";
          caret.dataset.peer = peer.id;
          caret.style.setProperty("--cursor-color", color);
          caret.setAttribute("aria-label", `${peer.name}: Cursor`);
          caret.setAttribute("role", "img");
          caret.contentEditable = "false";
          const label = document.createElement("span");
          label.className = "collaborator-name";
          label.textContent = peer.name;
          caret.append(label);
          return caret;
        },
        { key: `${peer.id}:${peer.name}`, side: 10 },
      ),
    );
    if (anchor !== head)
      marks.push(
        Decoration.inline(
          Math.min(anchor, head),
          Math.max(anchor, head),
          {
            class: "collaborator-selection",
            style: `background-color:${color}30`,
            "data-peer": peer.id,
          },
          { inclusiveStart: false, inclusiveEnd: true },
        ),
      );
  }
  return DecorationSet.create(state.doc, marks);
}

function localCursor(view: EditorView): Cursor | null {
  const sync = ySyncPluginKey.getState(view.state);
  if (
    !view.hasFocus() ||
    !sync?.binding?.mapping.size ||
    sync.snapshot ||
    sync.prevSnapshot
  )
    return null;
  const position = (pos: number) =>
    Y.relativePositionToJSON(
      absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping),
    );
  try {
    return {
      anchor: position(view.state.selection.anchor),
      head: position(view.state.selection.head),
    } as Cursor;
  } catch {
    return null;
  }
}

// Presence is intentionally separate from Y.Doc: no cursor data enters content,
// IndexedDB, undo history or exports. Relative positions share the existing binding.
export function collaborationCursors(
  scope: Pick<CursorRequest, "pageId" | "rowId" | "generation">,
  // The editor's live channel id, so its own cursor moves are not echoed.
  liveClientId?: string,
) {
  return Extension.create({
    name: "flowplanCursors",
    addProseMirrorPlugins() {
      return [
        new Plugin<PresenceState>({
          key,
          state: {
            init: () => ({ peers: [], decorations: DecorationSet.empty }),
            apply(tr, previous, oldState, newState) {
              const peers: Peer[] = tr.getMeta(key) ?? previous.peers;
              const remote = ySyncPluginKey.getState(newState)?.isChangeOrigin;
              // The Yjs mapping is not current during a local structural move.
              if (
                tr.docChanged &&
                !remote &&
                isStructuralTransaction(tr, oldState.doc)
              )
                return { peers, decorations: DecorationSet.empty };
              return {
                peers,
                decorations:
                  tr.getMeta(key) || remote
                    ? decorations(newState, peers)
                    : previous.decorations.map(tr.mapping, tr.doc),
              };
            },
          },
          props: { decorations: (state) => key.getState(state)?.decorations },
          view(view) {
            const clientId = liveClientId || crypto.randomUUID();
            let layoutFrame = 0;
            function alignLabels() {
              cancelAnimationFrame(layoutFrame);
              layoutFrame = requestAnimationFrame(() => {
                for (const caret of view.dom.querySelectorAll<HTMLElement>(
                  ".collaborator-cursor",
                )) {
                  const label = caret.firstElementChild as HTMLElement;
                  const right =
                    caret.getBoundingClientRect().left >
                    window.innerWidth - 160;
                  label.style.left = right ? "auto" : "-2px";
                  label.style.right = right ? "0" : "auto";
                }
              });
            }
            let sequence = 0,
              destroyed = false,
              stopped = false,
              pending = false;
            let controller: AbortController | null = null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let scheduledAt = Infinity;
            let lastCursor = "",
              nextSend = 0;
            const active = () =>
              !destroyed && !stopped && !document.hidden && navigator.onLine;
            const show = (peers: Peer[]) => {
              if (destroyed || view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(key, peers));
            };
            const request = (cursor: Cursor | null): CursorRequest => ({
              ...scope,
              clientId,
              sequence: ++sequence,
              cursor,
            });
            function schedule(delay = 40) {
              if (!active()) return;
              if (controller) {
                pending = true;
                return;
              }
              const wait = Math.max(delay, nextSend - Date.now());
              if (scheduledAt <= Date.now() + wait) return;
              clearTimeout(timer);
              scheduledAt = Date.now() + wait;
              timer = setTimeout(send, wait);
            }
            async function send() {
              scheduledAt = Infinity;
              if (!active() || controller) return;
              const ownController = new AbortController();
              controller = ownController;
              pending = false;
              const timeout = setTimeout(() => ownController.abort(), 8000);
              nextSend = Date.now() + 80;
              let delay = 1000;
              try {
                const response = await fetch("/api/presence", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  cache: "no-store",
                  body: JSON.stringify({
                    ...request(localCursor(view)),
                    // Also as text address, so guests on share links see it.
                    text: view.hasFocus()
                      ? toTextCursor(view.state.doc, view.state.selection.anchor, view.state.selection.head)
                      : null,
                  }),
                  signal: ownController.signal,
                });
                if (!response.ok) {
                  if ([401, 403, 404, 409].includes(response.status))
                    stopped = true;
                  throw new Error("Presence unavailable");
                }
                const result = (await response.json()) as {
                  peers: CursorPeer[];
                };
                if (controller === ownController && active())
                  show(
                    result.peers.map((p) => ({
                      ...p,
                      deadline:
                        Date.now() +
                        Math.min(15_000, Math.max(0, p.expiresInMs)),
                    })),
                  );
              } catch {
                if (controller === ownController) show([]);
                delay = 3000;
              } finally {
                clearTimeout(timeout);
                if (controller === ownController) {
                  controller = null;
                  schedule(pending ? 40 : delay);
                }
              }
            }
            function leave() {
              clearTimeout(timer);
              scheduledAt = Infinity;
              controller?.abort();
              controller = null;
              show([]);
              // A higher sequence tombstone also defeats an older in-flight update.
              if (!stopped)
                void fetch("/api/presence", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(request(null)),
                  keepalive: true,
                }).catch(() => {});
            }
            function environment() {
              if (active()) schedule(0);
              else leave();
            }
            function changed() {
              alignLabels();
              const next = JSON.stringify(localCursor(view));
              if (next !== lastCursor) {
                lastCursor = next;
                schedule();
              }
            }
            // Someone else moved: ask for the current cursors now.
            const liveKey = `${scope.pageId}:${scope.rowId || ""}:${scope.generation}`;
            const ping = (event: Event) => {
              if ((event as CustomEvent<string>).detail === liveKey) schedule(0);
            };
            window.addEventListener("flowplan:presence", ping);
            view.dom.addEventListener("focusin", changed);
            view.dom.addEventListener("focusout", changed);
            document.addEventListener("visibilitychange", environment);
            window.addEventListener("online", environment);
            window.addEventListener("offline", environment);
            window.addEventListener("pagehide", leave);
            window.addEventListener("resize", alignLabels);
            const expiry = setInterval(() => {
              const peers = key.getState(view.state)?.peers || [];
              if (peers.some((p) => p.deadline <= Date.now()))
                show(peers.filter((p) => p.deadline > Date.now()));
            }, 1000);
            schedule(0);
            return {
              update: changed,
              destroy() {
                destroyed = true;
                leave();
                clearInterval(expiry);
                cancelAnimationFrame(layoutFrame);
                window.removeEventListener("flowplan:presence", ping);
                view.dom.removeEventListener("focusin", changed);
                view.dom.removeEventListener("focusout", changed);
                document.removeEventListener("visibilitychange", environment);
                window.removeEventListener("online", environment);
                window.removeEventListener("offline", environment);
                window.removeEventListener("pagehide", leave);
                window.removeEventListener("resize", alignLabels);
              },
            };
          },
        }),
      ];
    },
  });
}
