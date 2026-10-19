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
// Inserts into the (first) open editor; false when none took it.
export function aiInsertInto(pageId: string, rowId: string | null | undefined, markdown: string, place: AiInsertPlace) {
  for (const insert of inserters.get(keyOf(pageId, rowId)) || []) if (insert(markdown, place)) return true;
  return false;
}
