// Moving a space in the sidebar (issue #48), shared by the drag and drop,
// the "Nach oben"/"Nach unten" menu items and the settings: the new order of
// the visible spaces, sent as "space.reorder" (lib/space-order.ts). Pure, no
// browser or Node APIs.

// `id` one place up (-1) or down (+1); null when it is already at that end.
export function moveSpaceBy(order: string[], id: string, delta: -1 | 1): string[] | null {
  const at = order.indexOf(id),
    to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return null;
  const next = [...order];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

// `source` dropped before or after `target`; null when nothing changes.
export function dropSpace(order: string[], source: string, target: string, placement: "before" | "after"): string[] | null {
  if (source === target || !order.includes(source) || !order.includes(target)) return null;
  const next = order.filter((id) => id !== source);
  next.splice(next.indexOf(target) + (placement === "after" ? 1 : 0), 0, source);
  return next.every((id, i) => id === order[i]) ? null : next;
}

// The spaces folded in the sidebar, kept per device (localStorage). Storage
// may be missing or refuse (private windows, blocked site data): then the
// state lives only as long as the tab.
export const COLLAPSED_SPACES_KEY = "flowplan-collapsed-spaces";
export function readCollapsedSpaces(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_SPACES_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").slice(0, 1000) : []);
  } catch {
    return new Set();
  }
}
export function writeCollapsedSpaces(ids: Set<string>) {
  try {
    if (ids.size) localStorage.setItem(COLLAPSED_SPACES_KEY, JSON.stringify([...ids]));
    else localStorage.removeItem(COLLAPSED_SPACES_KEY);
  } catch {
    /* kept for this tab only */
  }
}
