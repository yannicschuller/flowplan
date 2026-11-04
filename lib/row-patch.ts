// A change of some properties of a record against a version that is no
// longer current (#104): it still applies when none of the properties it
// changes was changed since – the values the person saw (`base`) are the
// stored ones. Then the newer version only holds other properties (their own
// previous save, a colleague's edit of another property) and nothing is
// overwritten. A property changed meanwhile stays a conflict.
// Shared by the server (lib/api.ts) and the browser; no Node APIs here.

const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

// Key order does not matter for objects (date ranges and similar values).
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}
export function sameCell(a: unknown, b: unknown) {
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// True when every changed property still has the value the change was made
// on. Without a base for each of them it is a conflict.
export function patchStillApplies(
  stored: Record<string, unknown>,
  base: unknown,
  patch: Record<string, unknown>,
) {
  if (!base || typeof base !== "object" || Array.isArray(base)) return false;
  const seen = base as Record<string, unknown>;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => Object.hasOwn(seen, k) && sameCell(stored[k], seen[k]));
}

// The base of a change: the values of its properties as the person saw them.
export function patchBase(cells: Record<string, unknown> | undefined, patch: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(patch).map((k) => [k, cells?.[k] ?? null]));
}
