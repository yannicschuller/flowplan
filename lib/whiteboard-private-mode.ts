// Private mode on whiteboards (workshops: everyone brainstorms on their own,
// then all notes are revealed at once). Client-safe; the server part is in
// lib/whiteboard-facilitation.ts and lib/whiteboard-private-guard.ts.
//
// How the content stays private: a board is one Yjs document, and Yjs keeps
// the changes of every writer ("client") in its own chain. While private mode
// runs, each browser tab writes everything that belongs to its private
// notes under a second client id of its own (registered on the server for
// that person and session). Those changes never go out with the board's
// normal sync; they travel to the server separately and are stored per
// person, outside the board. Nobody else's browser receives them – not the
// board state, the search summary, exports, previews or AI features, which
// all read the shared board. "Aufdecken" merges every person's changes into
// the board; from then on they are ordinary board content.
//
// Which client a change is written under is decided where Yjs creates it
// (Y.Map#set, Y.Array#insert/push/unshift and undo/redo): a change goes to
// the private client when it belongs to a private item (or would refer to a
// private change, which the others could not apply), and new items count as
// private when private mode runs and they lie in its area (the whole board
// or one frame).
import * as Y from "yjs";

export const PRIVATE_LIMITS = {
  // Per person and session: stored changes and items.
  bytes: 4_000_000,
  items: 300,
  // One request.
  update: 4_000_000,
};
// Clock beyond any real one: a state vector with it excludes the client.
const ALL = 0x7fffffff;

type Rect = { x: number; y: number; w: number; h: number };
// The board's "items" map (any value type).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ItemsMap = Y.Map<any>;
type Routing = {
  // The tab's ordinary client id (Yjs may change it; the setter keeps it).
  shared: number;
  // The tab's private client id while private mode runs here, else null.
  client: number | null;
  // Every private client of this person in the running session (other
  // tabs, earlier visits): their items are private too.
  own: Set<number>;
  items: ItemsMap;
  // Whether a new item (its properties) lies in the private area.
  inArea: (item: Record<string, unknown>) => boolean;
};
type Internal = {
  _map: Map<string, Y.Item>;
  _start: Y.Item | null;
  _item: Y.Item | null;
  _prelimContent?: Map<string, unknown>;
  doc: Y.Doc | null;
};
const routings = new WeakMap<Y.Doc, Routing>();
// The decision for the change being made right now (nested calls – the
// properties of a new item – follow the outer one).
let current: { doc: Y.Doc; private: boolean } | null = null;
let patched = false;

const internal = (type: unknown) => type as Internal;
function insidePrivate(r: Routing, type: unknown) {
  let item = internal(type)._item;
  while (item) {
    if (r.own.has(item.id.client)) return true;
    item = item.parent instanceof Y.AbstractType ? internal(item.parent)._item : null;
  }
  return false;
}
function listTouchesPrivate(r: Routing, type: unknown) {
  for (let n = internal(type)._start; n; n = n.right) if (r.own.has(n.id.client)) return true;
  return false;
}
function mapTarget(r: Routing, type: unknown, key: string, value: unknown) {
  const latest = internal(type)._map.get(key);
  if (type === r.items) {
    if (latest) return r.own.has(latest.id.client);
    return value instanceof Y.Map && r.inArea(prelim(value));
  }
  return insidePrivate(r, type) || (!!latest && r.own.has(latest.id.client));
}
const prelim = (map: Y.Map<unknown>): Record<string, unknown> =>
  Object.fromEntries(internal(map)._prelimContent || new Map());

function routed<T>(type: unknown, decide: (r: Routing) => boolean, run: () => T): T {
  const doc = internal(type).doc;
  const r = doc ? routings.get(doc) : undefined;
  if (!doc || !r || r.client === null || current) return run();
  current = { doc, private: decide(r) };
  try {
    return run();
  } finally {
    current = null;
  }
}
// Undo and redo restore earlier changes: private when any of them (or what
// they refer to) is private. Mixed steps go private as a whole – nothing
// private may end up in the shared chain.
type StackItem = { insertions: { clients: Map<number, { clock: number; len: number }[]> }; deletions: { clients: Map<number, { clock: number; len: number }[]> } };
function stackTouchesPrivate(r: Routing, doc: Y.Doc, item: StackItem) {
  try {
    for (const set of [item.insertions, item.deletions])
      for (const [client, ranges] of set.clients) {
        if (r.own.has(client)) return true;
        const structs = doc.store.clients.get(client);
        if (!structs) continue;
        for (const range of ranges)
          for (let i = Y.findIndexSS(structs, range.clock); i < structs.length && structs[i].id.clock < range.clock + range.len; i++) {
            const struct = structs[i];
            if (!(struct instanceof Y.Item) || !(struct.parent instanceof Y.AbstractType)) continue;
            if (insidePrivate(r, struct.parent)) return true;
            if (struct.parentSub ? mapTarget(r, struct.parent, struct.parentSub, undefined) : listTouchesPrivate(r, struct.parent)) return true;
          }
      }
  } catch {
    return true;
  }
  return false;
}
function patchYjs() {
  if (patched) return;
  patched = true;
  const map = Y.Map.prototype as unknown as { set: (key: string, value: unknown) => unknown };
  const set = map.set;
  map.set = function (this: unknown, key: string, value: unknown) {
    return routed(this, (r) => mapTarget(r, this, key, value), () => set.call(this, key, value));
  };
  const list = Y.Array.prototype as unknown as Record<"insert" | "push" | "unshift", (...args: unknown[]) => unknown>;
  for (const name of ["insert", "push", "unshift"] as const) {
    const original = list[name];
    list[name] = function (this: unknown, ...args: unknown[]) {
      return routed(this, (r) => insidePrivate(r, this) || listTouchesPrivate(r, this), () => original.apply(this, args));
    };
  }
  const undo = Y.UndoManager.prototype as unknown as Record<"undo" | "redo", () => unknown>;
  for (const [name, stack] of [["undo", "undoStack"], ["redo", "redoStack"]] as const) {
    const original = undo[name];
    undo[name] = function (this: { doc: Y.Doc } & Record<typeof stack, StackItem[]>) {
      const r = routings.get(this.doc);
      const top = this[stack][this[stack].length - 1];
      if (!r || r.client === null || current || !top) return original.call(this);
      current = { doc: this.doc, private: stackTouchesPrivate(r, this.doc, top) };
      try {
        return original.call(this);
      } finally {
        current = null;
      }
    };
  }
}

// Prepares a board document for private mode (once per document).
export function installPrivateRouting(doc: Y.Doc, items: ItemsMap) {
  if (routings.has(doc)) return;
  patchYjs();
  const r: Routing = { shared: doc.clientID, client: null, own: new Set(), items, inArea: () => true };
  routings.set(doc, r);
  Object.defineProperty(doc, "clientID", {
    configurable: true,
    enumerable: true,
    get: () => (current?.doc === doc && current.private && r.client !== null ? r.client : r.shared),
    set: (value: number) => {
      r.shared = value;
    },
  });
}
// Private mode starts (a client id for this tab), changes (other tabs) or
// ends (client null, no own clients: everything is shared again).
export function setPrivateRouting(
  doc: Y.Doc,
  next: { client: number | null; own?: Iterable<number>; area?: () => Rect | null },
) {
  const r = routings.get(doc);
  if (!r) return;
  r.client = next.client;
  r.own = new Set([...(next.own || []), ...(next.client === null ? [] : [next.client])]);
  r.inArea = (item) => {
    const area = next.area?.();
    return !area || inside(area, anchor(item));
  };
}
export const privateClients = (doc: Y.Doc) => new Set(routings.get(doc)?.own || []);
// A fresh client id that this document has not seen.
export function newClientId(doc: Y.Doc) {
  const values = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(values);
    if (values[0] && !doc.store.clients.has(values[0]) && values[0] !== doc.clientID) return values[0];
  }
}
// Where an item sits for the area check: its middle (connectors: between
// their ends).
export function anchor(item: Record<string, unknown>) {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const end = (v: unknown) => (v && typeof v === "object" ? (v as { x?: unknown; y?: unknown }) : null);
  const from = end(item.from),
    to = end(item.to);
  if (item.type === "connector" && from && to) return { x: (num(from.x) + num(to.x)) / 2, y: (num(from.y) + num(to.y)) / 2 };
  return { x: num(item.x) + num(item.w) / 2, y: num(item.y) + num(item.h) / 2 };
}
export const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

// The board's changes for the normal sync, without anything private.
export function sharedUpdate(doc: Y.Doc, since: Uint8Array | null) {
  const own = routings.get(doc)?.own;
  if (!own?.size) return Y.encodeStateAsUpdate(doc, since || undefined);
  const vector = since ? Y.decodeStateVector(since) : new Map<number, number>();
  for (const client of own) vector.set(client, Math.max(vector.get(client) || 0, Y.getState(doc.store, client)));
  return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(vector));
}
// The private changes of these clients since `acked` (plus the deletions).
export function privateUpdate(doc: Y.Doc, own: Iterable<number>, acked: Map<number, number>) {
  const mine = new Set(own);
  const vector = new Map<number, number>();
  for (const client of doc.store.clients.keys()) if (!mine.has(client)) vector.set(client, Y.getState(doc.store, client));
  for (const client of mine) vector.set(client, acked.get(client) || 0);
  return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(vector));
}
export function clientClocks(doc: Y.Doc, clients: Iterable<number>) {
  return new Map([...clients].map((c) => [c, Y.getState(doc.store, c)] as const));
}
// Ids of the items on this board that only this person sees.
export function privateItemIds(doc: Y.Doc, items: ItemsMap) {
  const own = routings.get(doc)?.own;
  const ids: string[] = [];
  if (!own?.size) return ids;
  for (const [key, item] of internal(items)._map) if (!item.deleted && own.has(item.id.client)) ids.push(key);
  return ids;
}

// ---- server side (pure) ----
// The clients whose changes an update carries.
export function updateClients(update: Uint8Array) {
  const clients = new Set<number>();
  for (const struct of Y.decodeUpdate(update).structs) if (!(struct instanceof Y.Skip)) clients.add(struct.id.client);
  return clients;
}
// An update without the changes of these clients (deletions stay).
export function withoutClients(update: Uint8Array, clients: Iterable<number>) {
  const vector = new Map<number, number>();
  for (const client of clients) vector.set(client, ALL);
  return vector.size ? Y.diffUpdate(update, Y.encodeStateVector(vector)) : update;
}
// How many items a person's private changes add to the board.
export function privateItemCount(state: Uint8Array) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return doc.getMap("items").size;
  } finally {
    doc.destroy();
  }
}
