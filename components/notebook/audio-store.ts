"use client";
// Recordings of notebooks on this device until the server has them
// (components/notebook/notebook-audio.tsx): each piece MediaRecorder hands
// over is kept in IndexedDB at once, so a reload, a crash or a lost
// connection costs at most the last few seconds. Removed once the upload is
// finished or discarded. Without IndexedDB (private windows of some
// browsers) the pieces stay in memory only – `durable` says which.
export type StoredSession = {
  id: string;
  pageId: string;
  mime: string;
  name: string;
  startedAt: number;
  // Audio time so far (pauses not counted) and when it was last written.
  durationMs: number;
  updatedAt: number;
  bytes: number;
  chunks: number;
  state: "recording" | "stopped";
};

const DB = "flowplan-notebook-audio";
const SESSIONS = "sessions";
const CHUNKS = "chunks";

const memory = { sessions: new Map<string, StoredSession>(), chunks: new Map<string, Blob[]>() };
let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((done) => {
    try {
      if (typeof indexedDB === "undefined") return done(null);
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ["session", "seq"] }).createIndex("session", "session");
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return opening;
}
const finished = (tx: IDBTransaction) =>
  new Promise<boolean>((done) => {
    tx.oncomplete = () => done(true);
    tx.onerror = () => done(false);
    tx.onabort = () => done(false);
  });
const result = <T,>(request: IDBRequest<T>) =>
  new Promise<T | undefined>((done) => {
    request.onsuccess = () => done(request.result);
    request.onerror = () => done(undefined);
  });

// Whether pieces survive a reload on this device.
export async function durable() {
  return !!(await openDb());
}

export async function saveSession(session: StoredSession) {
  memory.sessions.set(session.id, session);
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(SESSIONS, "readwrite");
    tx.objectStore(SESSIONS).put(session);
    return await finished(tx);
  } catch {
    return false;
  }
}

// One piece, in order; the session's counters move with it.
export async function addChunk(session: StoredSession, blob: Blob) {
  const seq = session.chunks;
  const next = { ...session, chunks: seq + 1, bytes: session.bytes + blob.size, updatedAt: Date.now() };
  memory.sessions.set(session.id, next);
  const list = memory.chunks.get(session.id) || [];
  list.push(blob);
  memory.chunks.set(session.id, list);
  const db = await openDb();
  if (db) {
    try {
      const tx = db.transaction([SESSIONS, CHUNKS], "readwrite");
      tx.objectStore(CHUNKS).put({ session: session.id, seq, blob });
      tx.objectStore(SESSIONS).put(next);
      // Kept on disk: the copy in memory is not needed for this piece.
      if (await finished(tx)) list[seq] = new Blob([], { type: blob.type });
    } catch {}
  }
  return next;
}

// Sessions of a notebook that are still on this device (newest first).
export async function pendingSessions(pageId: string): Promise<StoredSession[]> {
  const found = new Map<string, StoredSession>();
  for (const s of memory.sessions.values()) if (s.pageId === pageId) found.set(s.id, s);
  const db = await openDb();
  if (db) {
    try {
      const all = (await result(db.transaction(SESSIONS).objectStore(SESSIONS).getAll())) as StoredSession[] | undefined;
      for (const s of all || []) if (s.pageId === pageId) found.set(s.id, s);
    } catch {}
  }
  return [...found.values()].sort((a, b) => b.startedAt - a.startedAt);
}

// The whole recording so far as one file.
export async function sessionBlob(id: string, mime: string): Promise<Blob> {
  const parts: Blob[] = [];
  const db = await openDb();
  let stored: { seq: number; blob: Blob }[] = [];
  if (db) {
    try {
      stored = ((await result(db.transaction(CHUNKS).objectStore(CHUNKS).index("session").getAll(id))) as typeof stored | undefined) || [];
    } catch {}
  }
  const inMemory = memory.chunks.get(id) || [];
  const count = Math.max(inMemory.length, ...stored.map((c) => c.seq + 1), 0);
  const bySeq = new Map(stored.map((c) => [c.seq, c.blob]));
  for (let seq = 0; seq < count; seq++) {
    const kept = bySeq.get(seq);
    const held = inMemory[seq];
    parts.push(kept && kept.size ? kept : held || new Blob([]));
  }
  return new Blob(parts, { type: mime.split(";")[0] });
}

export async function removeSession(id: string) {
  memory.sessions.delete(id);
  memory.chunks.delete(id);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([SESSIONS, CHUNKS], "readwrite");
    tx.objectStore(SESSIONS).delete(id);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await finished(tx);
  } catch {}
}
