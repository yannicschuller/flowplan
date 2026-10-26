"use client";
// Summaries are shown outside the editor (the side panel, a record's
// dialog) but inserted into it: each open editor registers here for its
// page or record, the panel hands over the Markdown and where it goes.
export type AiInsertPlace = "top" | "caret";
type Inserter = (markdown: string, place: AiInsertPlace) => boolean;
const inserters = new Map<string, Set<Inserter>>();
const keyOf = (pageId: string, rowId?: string | null) => `${pageId}:${rowId || ""}`;

export function registerAiInserter(pageId: string, rowId: string | null | undefined, insert: Inserter) {
  const key = keyOf(pageId, rowId);
  if (!inserters.has(key)) inserters.set(key, new Set());
  inserters.get(key)!.add(insert);
  return () => {
    inserters.get(key)?.delete(insert);
    if (!inserters.get(key)?.size) inserters.delete(key);
  };
}
// Whether an editable editor is open for it.
export const aiCanInsert = (pageId: string, rowId?: string | null) => !!inserters.get(keyOf(pageId, rowId))?.size;
// Summaries on the device (lib/ai/device.ts) read the open document from
// its editor – the server's copy is not there to read (end-to-end
// encrypted) and must not be asked.
type Reader = () => string;
const readers = new Map<string, Set<Reader>>();
export function registerAiReader(pageId: string, rowId: string | null | undefined, read: Reader) {
  const key = keyOf(pageId, rowId);
  if (!readers.has(key)) readers.set(key, new Set());
  readers.get(key)!.add(read);
  return () => {
    readers.get(key)?.delete(read);
    if (!readers.get(key)?.size) readers.delete(key);
  };
}
// The open document as Markdown, or null when no editor has it open.
export function aiReadOpen(pageId: string, rowId?: string | null): string | null {
  for (const read of readers.get(keyOf(pageId, rowId)) || []) return read();
  return null;
}
// Inserts into the (first) open editor; false when none took it.
export function aiInsertInto(pageId: string, rowId: string | null | undefined, markdown: string, place: AiInsertPlace) {
  for (const insert of inserters.get(keyOf(pageId, rowId)) || []) if (insert(markdown, place)) return true;
  return false;
}
