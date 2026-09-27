// Live channel for documents and record contents: changes and cursor moves
// are pushed to everyone who has the same document open (server-sent
// events), instead of waiting for their next poll. The database stays the
// source of truth; this only shortens the way. Flowplan runs as a single
// process, so one hub reaches every open editor.
type Listener = { clientId: string; send: (event: string) => void };

const hub = globalThis as unknown as { flowplanDocuments?: Map<string, Set<Listener>> };
const documents = (hub.flowplanDocuments ??= new Map());

export function documentKey(pageId: string, rowId: string | null | undefined, generation: string) {
  return `${pageId}:${rowId || ""}:${generation}`;
}

function broadcast(key: string, payload: unknown, except?: string) {
  const listeners = documents.get(key);
  if (!listeners) return;
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners)
    if (listener.clientId !== except)
      try {
        listener.send(event);
      } catch {
        listeners.delete(listener);
      }
}

// A Yjs update (base64) that was just stored; the sender already has it.
export function publishDocumentUpdate(key: string, update: string, from?: string) {
  broadcast(key, { type: "update", update }, from);
}

// Someone moved their cursor: the others ask for the current cursors.
export function publishPresence(key: string, from?: string) {
  broadcast(key, { type: "presence" }, from);
}

// Stored some other way (guest link, journal, version restore, linked
// database): open editors fetch the current state right away.
export function documentChanged(pageId: string, rowId?: string | null) {
  const prefix = `${pageId}:${rowId || ""}:`;
  for (const key of documents.keys())
    if (key.startsWith(prefix)) broadcast(key, { type: "check" });
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

export function documentWatchers(key: string) {
  return documents.get(key)?.size || 0;
}
