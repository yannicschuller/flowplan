// Which documents have their live channel open in this tab
// (components/editor.tsx reports it): parts of the page that would
// otherwise poll – the cursors (lib/collaboration-cursors.ts), the comment
// threads (components/inline-comments.tsx) – rely on its signals then and
// only ask now and then.
export type LiveState = { key: string; open: boolean };
export const LIVE_EVENT = "flowplan:live-state";
// "pageId:rowId:generation" (lib/document-live.ts documentKey()).
const open = new Set<string>();

export function setLiveState(key: string, isOpen: boolean) {
  if (isOpen) open.add(key);
  else open.delete(key);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<LiveState>(LIVE_EVENT, { detail: { key, open: isOpen } }));
}
export const liveOpen = (key: string) => open.has(key);
// Any generation of this page or record.
export function liveOpenFor(pageId: string, rowId?: string | null) {
  const prefix = `${pageId}:${rowId || ""}:`;
  for (const key of open) if (key.startsWith(prefix)) return true;
  return false;
}
// The live channel's signal that the comment threads of a page or record
// changed (lib/document-live.ts threadsChanged()).
export const THREADS_EVENT = "flowplan:threads";
export const threadsKey = (pageId: string, rowId?: string | null) => `${pageId}:${rowId || ""}`;
