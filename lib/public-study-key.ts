// Where the practice of a public link keeps its state in the browser
// (lib/public-study-progress.ts): small, for the page that only browses.
export const progressKey = (token: string) => `flowplan-study:${token}`;
// Whether this browser holds ratings or states for the link.
export function hasProgress(token: string, storage: Pick<Storage, "getItem"> | null) {
  try {
    const value = JSON.parse(storage?.getItem(progressKey(token)) || "null") as { decks?: Record<string, { base?: object; reviews?: unknown[] }> } | null;
    return Object.values(value?.decks || {}).some((d) => (d?.reviews?.length || 0) > 0 || Object.keys(d?.base || {}).length > 0);
  } catch {
    return false;
  }
}
