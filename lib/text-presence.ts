// Cursors between members and guests of share links, as text addresses
// (lib/text-anchors.ts), kept in memory for a few seconds per document.
import { CURSOR_LEASE_MS, type CursorPeer, type TextCursorValue } from "./cursor-protocol";

type Entry = {
  id: string;
  userId: string;
  name: string;
  text: TextCursorValue;
  at: number;
  source: "member" | "guest";
};
const hub = globalThis as unknown as { flowplanTextPresence?: Map<string, Map<string, Entry>> };
const documents = (hub.flowplanTextPresence ??= new Map());

export const presencePrefix = (pageId: string, rowId?: string | null) => `${pageId}:${rowId || ""}`;

function sweep(prefix: string, now: number) {
  const entries = documents.get(prefix);
  if (!entries) return undefined;
  for (const [id, entry] of entries) if (now - entry.at > CURSOR_LEASE_MS) entries.delete(id);
  if (!entries.size) documents.delete(prefix);
  return documents.get(prefix);
}

// Stores or removes one cursor; true when the others should hear about it.
export function setTextPresence(
  prefix: string,
  entry: Omit<Entry, "at"> | { id: string; text: null },
  now = Date.now(),
) {
  const entries = sweep(prefix, now) || new Map<string, Entry>();
  const before = entries.get(entry.id);
  if (!entry.text) {
    if (!before) return false;
    entries.delete(entry.id);
  } else entries.set(entry.id, { ...(entry as Omit<Entry, "at">), at: now });
  if (entries.size) documents.set(prefix, entries);
  else documents.delete(prefix);
  return !before || !entry.text || JSON.stringify(before.text) !== JSON.stringify(entry.text);
}

// Cursors for one viewer: guests see everyone, members only the guests
// (members see each other through their Yjs cursors).
export function textPeers(prefix: string, exceptId: string, only?: "guest", now = Date.now()): CursorPeer[] {
  const entries = sweep(prefix, now);
  if (!entries) return [];
  return [...entries.values()]
    .filter((e) => e.id !== exceptId && (!only || e.source === only))
    .map((e) => ({
      id: e.id,
      userId: e.userId,
      name: e.name,
      text: e.text,
      expiresInMs: Math.max(0, e.at + CURSOR_LEASE_MS - now),
    }));
}
