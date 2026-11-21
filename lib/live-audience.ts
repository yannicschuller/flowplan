// Who else has a document or a whiteboard open live (#383): the live
// streams (lib/document-live.ts, lib/whiteboard-presence.ts) join a "room"
// per document or board, and each stream is told whether anyone else is in
// it. A tab alone in its room keeps its cursor moves to itself – nobody
// would see them – and sends them again as soon as someone arrives. Most
// editing happens alone, so most cursor requests never need to be made.
//
// An entry is one live stream under an id: the editor's client id for
// documents (each tab has its own cursor), the person (or guest) for boards
// (one cursor per person). Several streams under one id are one entry for
// the others: a person's second tab on a board is no audience for the first.
//
// Cluster mode: the instances tell each other which ids they hold per room
// (lib/cluster/bus.ts) – when the first stream of an id joins or the last
// one leaves, and every 20 s while it stays (an instance that went away
// without saying so is forgotten after a minute). An instance that learns
// of a newcomer answers with its own ids for that room at once, so a tab on
// a freshly started instance finds the others within a round trip. Errors
// lean towards "someone is there", which only means cursors go out as
// before.
import { onBus, publish } from "./cluster/bus";
import { hasPeers } from "./cluster/processes";

type Tell = (others: boolean) => void;
type Entry = { id: string; tell: Tell; told?: boolean };
type Room = { entries: Set<Entry>; remote: Map<string, number> };
type Message = { k: "join" | "here" | "leave"; room: string; ids: string[] };

const REFRESH_MS = 20_000;
const REMOTE_TTL_MS = 60_000;

const hub = globalThis as unknown as { flowplanAudience?: Map<string, Room>; flowplanAudienceBus?: boolean; flowplanAudienceTimer?: ReturnType<typeof setInterval> };
const rooms = (hub.flowplanAudience ??= new Map());

function room(name: string) {
  let r = rooms.get(name);
  if (!r) rooms.set(name, (r = { entries: new Set(), remote: new Map() }));
  return r;
}
function localIds(r: Room) {
  return new Set([...r.entries].map((e) => e.id));
}
function sweepRemote(r: Room, now = Date.now()) {
  for (const [key, until] of r.remote) if (until <= now) r.remote.delete(key);
}
function othersFor(r: Room, id: string) {
  for (const e of r.entries) if (e.id !== id) return true;
  sweepRemote(r);
  for (const key of r.remote.keys()) if (key.slice(key.indexOf("|") + 1) !== id) return true;
  return false;
}
// Tells every stream of the room whose answer changed.
function update(name: string) {
  const r = rooms.get(name);
  if (!r) return;
  for (const e of r.entries) {
    const others = othersFor(r, e.id);
    if (e.told === others) continue;
    e.told = others;
    try {
      e.tell(others);
    } catch {}
  }
  if (!r.entries.size && !r.remote.size) rooms.delete(name);
}

if (!hub.flowplanAudienceBus) {
  hub.flowplanAudienceBus = true;
  onBus("audience", (payload, origin) => {
    const m = payload as Message;
    if (!m || typeof m.room !== "string" || !Array.isArray(m.ids)) return;
    const r = m.k === "leave" ? rooms.get(m.room) : room(m.room);
    if (!r) return;
    const until = Date.now() + REMOTE_TTL_MS;
    for (const id of m.ids)
      if (typeof id === "string") {
        if (m.k === "leave") r.remote.delete(`${origin}|${id}`);
        else r.remote.set(`${origin}|${id}`, until);
      }
    // A newcomer elsewhere: who is here answers right away.
    if (m.k === "join" && r.entries.size) publish("audience", { k: "here", room: m.room, ids: [...localIds(r)] } satisfies Message);
    update(m.room);
  });
}
function refreshLater() {
  if (hub.flowplanAudienceTimer || !hasPeers()) return;
  hub.flowplanAudienceTimer = setInterval(() => {
    let any = false;
    for (const [name, r] of rooms)
      if (r.entries.size) {
        any = true;
        publish("audience", { k: "here", room: name, ids: [...localIds(r)] } satisfies Message);
      } else {
        sweepRemote(r);
        update(name);
      }
    if (!any) {
      clearInterval(hub.flowplanAudienceTimer);
      hub.flowplanAudienceTimer = undefined;
    }
  }, REFRESH_MS);
  hub.flowplanAudienceTimer.unref?.();
}

// A live stream joins `name` under `id`; `tell` hears at once and on every
// change whether anyone else is in the room. Returns the leave function.
export function joinAudience(name: string, id: string, tell: Tell = () => {}) {
  const r = room(name);
  const first = !localIds(r).has(id);
  const entry: Entry = { id, tell };
  r.entries.add(entry);
  if (first) publish("audience", { k: "join", room: name, ids: [id] } satisfies Message);
  refreshLater();
  update(name);
  // The newcomer hears even when the answer is "alone" (update() tells only changes).
  if (entry.told === undefined) {
    entry.told = othersFor(r, id);
    try {
      tell(entry.told);
    } catch {}
  }
  let left = false;
  return () => {
    if (left) return;
    left = true;
    r.entries.delete(entry);
    if (!localIds(r).has(id)) publish("audience", { k: "leave", room: name, ids: [id] } satisfies Message);
    update(name);
  };
}

// Whether anyone but `id` is in the room (here or on another instance).
export function audienceOthers(name: string, id: string) {
  const r = rooms.get(name);
  return !!r && othersFor(r, id);
}

// The live event a stream sends for it.
export const audienceEvent = (others: boolean) => `data: ${JSON.stringify({ type: "audience", others })}\n\n`;

export const documentRoom = (pageId: string, rowId?: string | null) => `doc:${pageId}:${rowId || ""}`;
export const boardRoom = (pageId: string) => `board:${pageId}`;
