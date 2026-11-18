"use client";
// Where content made offline waits on this device (#370,
// lib/offline-create.ts): the blobs of pictures and files to upload
// (IndexedDB, also in the iPhone/iPad and Android app's web view), the
// handwriting of a notebook made offline (localStorage) and the names of
// the IndexedDB stores the editor and the whiteboard keep their content in.
import type { InkItem } from "@/lib/ink/model";

const DB = "flowplan-offline-uploads";
const STORE = "files";
type Stored = { fileId: string; userId: string; blob: Blob; name: string; type: string; at: number };

function open(): Promise<IDBDatabase | null> {
  return new Promise((done) => {
    try {
      if (typeof indexedDB === "undefined") return done(null);
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "fileId" });
      };
      request.onsuccess = () => done(request.result);
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}
async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  try {
    return await new Promise<T | null>((done) => {
      const tx = db.transaction(STORE, mode);
      const request = act(tx.objectStore(STORE));
      tx.oncomplete = () => done(request.result ?? null);
      tx.onerror = () => done(null);
      tx.onabort = () => done(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}
// Keeps a file for later; false when the device does not keep it (no
// IndexedDB, storage full).
export async function keepUpload(userId: string, fileId: string, file: Blob, name: string, type: string): Promise<boolean> {
  const stored: Stored = { fileId, userId, blob: file, name, type, at: Date.now() };
  const done = await run("readwrite", (store) => store.put(stored));
  return done !== null;
}
export async function keptUpload(fileId: string): Promise<Stored | null> {
  return await run<Stored>("readonly", (store) => store.get(fileId) as IDBRequest<Stored>);
}
export async function dropUpload(fileId: string) {
  await run("readwrite", (store) => store.delete(fileId));
}
export async function keptUploads(userId: string): Promise<Stored[]> {
  const all = (await run<Stored[]>("readonly", (store) => store.getAll() as IDBRequest<Stored[]>)) || [];
  return all.filter((s) => s.userId === userId);
}

// The editor's IndexedDB store of a document (components/editor.tsx; a new
// document's generation is "1", lib/db.ts) and the whiteboard's of a board
// made offline.
export const documentStore = (userId: string, pageId: string) => `flowplan:${userId}:${pageId}:page:1`;
export const OFFLINE_BOARD_GENERATION = "offline";
export const boardStore = (userId: string, pageId: string) => `flowplan:${userId}:${pageId}:whiteboard:${OFFLINE_BOARD_GENERATION}`;

// Handwriting on the sheets of a notebook made offline, per sheet.
const inkKey = (pageId: string) => `flowplan:offline-ink:${pageId}`;
export function keptInk(pageId: string): Record<string, InkItem[]> {
  try {
    const value = JSON.parse(localStorage.getItem(inkKey(pageId)) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
export function keepInk(pageId: string, surface: string, items: InkItem[]) {
  const all = keptInk(pageId);
  all[surface] = items;
  localStorage.setItem(inkKey(pageId), JSON.stringify(all));
}
export function dropInk(pageId: string) {
  try {
    localStorage.removeItem(inkKey(pageId));
  } catch {}
}
export function dropStore(name: string) {
  try {
    indexedDB.deleteDatabase(name);
  } catch {}
}
