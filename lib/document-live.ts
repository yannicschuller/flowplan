// Live channel for documents and record contents: changes and cursor moves
// are pushed to everyone who has the same document open (server-sent
// events), instead of waiting for their next poll. The database stays the
// source of truth; this only shortens the way. One hub per process reaches
// the editors connected to it; in cluster mode every signal also goes to
// the other instances (lib/cluster/bus.ts), whose hubs deliver it to theirs.
import { onBus, publish } from "./cluster/bus";

type Listener = { clientId: string; send: (event: string) => void };

const hub = globalThis as unknown as {
  flowplanDocuments?: Map<string, Set<Listener>>;
  flowplanDocumentPrefixes?: Map<string, Set<Listener>>;
};
const documents = (hub.flowplanDocuments ??= new Map());
// Guests on share links follow a document without its Yjs identity: they
// get "check" (fetch your projection) and "presence" signals.
const prefixes = (hub.flowplanDocumentPrefixes ??= new Map());

export function documentKey(pageId: string, rowId: string | null | undefined, generation: string) {
  return `${pageId}:${rowId || ""}:${generation}`;
}

function send(listeners: Set<Listener>, payload: unknown, except?: string) {
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners)
    if (listener.clientId !== except)
      try {
        listener.send(event);
      } catch {
        listeners.delete(listener);
      }
}
function notifyPrefix(key: string, type: "check" | "presence", except?: string) {
  const prefix = key.split(":").slice(0, 2).join(":");
  const listeners = prefixes.get(prefix);
  if (listeners) send(listeners, { type }, except);
}
function broadcast(key: string, payload: { type: string; [key: string]: unknown }, except?: string) {
  notifyPrefix(key, payload.type === "presence" ? "presence" : "check", except);
  const listeners = documents.get(key);
  if (listeners) send(listeners, payload, except);
}

// What the other instances may ask this hub to deliver (cluster mode).
type Signal =
  | { k: "update"; key: string; update: string; from?: string }
  | { k: "e2ee"; key: string; update: { seq: number; version: number; data: string }; from?: string }
  | { k: "presence"; key: string; from?: string }
  | { k: "changed"; pageId: string; rowId?: string | null; except?: string }
  | { k: "presenceFor"; pageId: string; rowId?: string | null; from?: string };
const bus = globalThis as unknown as { flowplanDocumentBus?: boolean };
if (!bus.flowplanDocumentBus) {
  bus.flowplanDocumentBus = true;
  onBus("document", (payload) => deliver(payload as Signal));
}
function deliver(signal: Signal) {
  switch (signal.k) {
    case "update":
      return broadcast(signal.key, { type: "update", update: signal.update }, signal.from);
    case "e2ee": {
      const listeners = documents.get(signal.key);
      if (listeners) send(listeners, { type: "e2ee", ...signal.update }, signal.from);
      return;
    }
    case "presence":
      return broadcast(signal.key, { type: "presence" }, signal.from);
    case "changed":
      return changedHere(signal.pageId, signal.rowId, signal.except);
    case "presenceFor":
      return presenceHere(signal.pageId, signal.rowId, signal.from);
  }
}
// Here, then on the other instances.
function signal(message: Signal) {
  deliver(message);
  publish("document", message);
}

// A Yjs update (base64) that was just stored; the sender already has it.
export function publishDocumentUpdate(key: string, update: string, from?: string) {
  signal({ k: "update", key, update, from });
}

// An encrypted document update was appended (lib/e2ee-server.ts): the
// ciphertext with its sequence number; only members with the key read it.
export function publishEncryptedUpdate(key: string, update: { seq: number; version: number; data: string }, from?: string) {
  signal({ k: "e2ee", key, update, from });
}

// Someone moved their cursor: the others ask for the current cursors.
export function publishPresence(key: string, from?: string) {
  signal({ k: "presence", key, from });
}

// Stored some other way (guest link, journal, version restore, linked
// database): open editors fetch the current state right away.
export function documentChanged(pageId: string, rowId?: string | null, except?: string) {
  signal({ k: "changed", pageId, rowId, except });
}
function changedHere(pageId: string, rowId?: string | null, except?: string) {
  const prefix = `${pageId}:${rowId || ""}:`;
  const guests = prefixes.get(`${pageId}:${rowId || ""}`);
  if (guests) send(guests, { type: "check" }, except);
  for (const key of documents.keys())
    if (key.startsWith(prefix)) {
      const listeners = documents.get(key);
      if (listeners) send(listeners, { type: "check" }, except);
    }
}

// Guests of a share link: "check" and "presence" for one page or record.
export function watchPrefix(pageId: string, rowId: string | null | undefined, clientId: string, emit: (event: string) => void) {
  const prefix = `${pageId}:${rowId || ""}`;
  let listeners = prefixes.get(prefix);
  if (!listeners) {
    listeners = new Set();
    prefixes.set(prefix, listeners);
  }
  const listener = { clientId, send: emit };
  listeners.add(listener);
  emit(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  return () => {
    const set = prefixes.get(prefix);
    set?.delete(listener);
    if (set && !set.size) prefixes.delete(prefix);
  };
}

// A guest moved their cursor: members and other guests ask again.
export function publishPresenceFor(pageId: string, rowId: string | null | undefined, from?: string) {
  signal({ k: "presenceFor", pageId, rowId, from });
}
function presenceHere(pageId: string, rowId: string | null | undefined, from?: string) {
  const prefix = `${pageId}:${rowId || ""}`;
  const guests = prefixes.get(prefix);
  if (guests) send(guests, { type: "presence" }, from);
  for (const key of documents.keys())
    if (key.startsWith(`${prefix}:`)) {
      const listeners = documents.get(key);
      if (listeners) send(listeners, { type: "presence" }, from);
    }
}

export function watchDocument(key: string, clientId: string, send: (event: string) => void) {
  let listeners = documents.get(key);
  if (!listeners) {
    listeners = new Set();
    documents.set(key, listeners);
  }
  const listener = { clientId, send };
  listeners.add(listener);
  send(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  return () => {
    const set = documents.get(key);
    set?.delete(listener);
    if (set && !set.size) documents.delete(key);
  };
}
