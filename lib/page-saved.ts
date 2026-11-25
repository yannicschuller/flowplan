// A document was saved from this window (components/editor.tsx): views of
// its content elsewhere in the window – page cards on whiteboards (#549,
// components/whiteboard/card-preview.tsx) – fetch it anew. The detail is
// the page's id.
export const PAGE_SAVED_EVENT = "flowplan:page-saved";
export function announcePageSaved(pageId: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<string>(PAGE_SAVED_EVENT, { detail: pageId }));
}
