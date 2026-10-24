// Undo and redo for ink: whole states (immutable, pages that did not change
// are shared), so one step can touch several pages (paste, restore).
export type History<T> = { past: T[]; future: T[] };
export const HISTORY_LIMIT = 200;

export const emptyHistory = <T>(): History<T> => ({ past: [], future: [] });
// `before` is the state the change replaced.
export function record<T>(history: History<T>, before: T, limit = HISTORY_LIMIT): History<T> {
  return { past: [...history.past, before].slice(-limit), future: [] };
}
export function undo<T>(history: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!history.past.length) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [...history.future, current] },
    state: history.past[history.past.length - 1],
  };
}
export function redo<T>(history: History<T>, current: T): { history: History<T>; state: T } | null {
  if (!history.future.length) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(0, -1) },
    state: history.future[history.future.length - 1],
  };
}
