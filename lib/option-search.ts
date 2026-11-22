// Finding the options of a select or multi-select property by typing, and
// creating the typed one when it does not exist yet (#423,
// components/option-picker.tsx). Client-safe (no server imports).

// As the database schema allows them (lib/database-schema.ts `options`).
export const MAX_OPTION_LENGTH = 100;
export const MAX_FIELD_OPTIONS = 1000;

// Case, accents and runs of spaces do not count: "cafe" finds "Café",
// "in  arbeit" finds "In Arbeit" (as the search and @ mentions fold, lib/aliases.ts).
export const foldOption = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase("de");
// A typed name as it is stored: trimmed, inner spaces collapsed.
export const cleanOptionName = (text: string) => text.replace(/\s+/g, " ").trim();

export type OptionSearch = {
  // The options to offer: the one written like the query first, then those
  // starting with it, then those containing it – each in the property's order.
  matches: string[];
  // The option written like the query (case and accents aside), chosen or not.
  exact?: string;
  // The name to create, when allowed: typed, not there yet, within the limits.
  create?: string;
};

export function searchOptions(
  options: readonly string[],
  query: string,
  { exclude = [], canCreate = false }: { exclude?: readonly string[]; canCreate?: boolean } = {},
): OptionSearch {
  const typed = cleanOptionName(query);
  const q = foldOption(typed);
  const skip = new Set(exclude);
  const exact = q ? options.find((o) => foldOption(o) === q) : undefined;
  const first: string[] = [],
    prefix: string[] = [],
    contains: string[] = [];
  for (const option of options) {
    if (skip.has(option)) continue;
    const key = foldOption(option);
    if (!q) contains.push(option);
    else if (key === q) first.push(option);
    else if (key.startsWith(q)) prefix.push(option);
    else if (key.includes(q)) contains.push(option);
  }
  const create =
    canCreate && typed && !exact && typed.length <= MAX_OPTION_LENGTH && options.length < MAX_FIELD_OPTIONS ? typed : undefined;
  return { matches: [...first, ...prefix, ...contains], exact, create };
}

// Options a schema change adds that are written like another option of
// the same property (case and accents aside) – the server refuses them.
// Duplicates the property already had stay allowed (older imports).
export function duplicateNewOptions(
  fields: readonly { id: string; type: string; options?: readonly string[] }[],
  before: readonly { id: string; options?: readonly string[] }[],
): { field: string; option: string } | undefined {
  for (const f of fields) {
    if ((f.type !== "select" && f.type !== "multiselect") || !f.options?.length) continue;
    const known = new Set(before.find((b) => b.id === f.id)?.options || []);
    const seen = new Map<string, number>();
    for (const o of f.options) seen.set(foldOption(o), (seen.get(foldOption(o)) || 0) + 1);
    for (const o of f.options)
      if (!known.has(o) && (seen.get(foldOption(o)) || 0) > 1) return { field: f.id, option: o };
  }
  return undefined;
}
