import { useSyncExternalStore } from "react";
import { DEFAULT_COMMENT_MARGIN, commentMarginOf } from "./comment-margin-pref";

// "Textkommentare: am Rand / unter dem Dokument" (#387,
// lib/comment-margin-pref.ts) in the browser: set from the bootstrap
// (components/workspace-app.tsx) and by the settings; the text comments
// (components/inline-comments.tsx) read it.
const listeners = new Set<() => void>();
let current = DEFAULT_COMMENT_MARGIN;
export function commentMargin(): boolean {
  return current;
}
export function setCommentMarginLocal(value: unknown) {
  const next = commentMarginOf(value);
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useCommentMargin(): boolean {
  return useSyncExternalStore(subscribe, commentMargin, () => DEFAULT_COMMENT_MARGIN);
}
