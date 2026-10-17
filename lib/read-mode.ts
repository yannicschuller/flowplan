// Pages and records opened for reading, per device (ids in one list).
export const READ_MODE_KEY = "flowplan-read-pages";

export function readModeIds(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(READ_MODE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
// Switches one page or record; the list is read again first, so pages and
// records opened elsewhere in the meantime stay in it.
export function toggleReadMode(id: string): string[] {
  const current = readModeIds();
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current.slice(-199), id];
  try {
    localStorage.setItem(READ_MODE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}
