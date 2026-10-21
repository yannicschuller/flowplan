// Aliases: other names of a page or record ("PAC" for "Chauffage", as
// Obsidian keeps them in `aliases:`). Records keep them in a property of
// type "aliases" (at most one per database), pages in the column
// pages.aliases (a JSON array). @ mentions, the search and unlinked
// mentions find an item by its aliases like by its title.
import type { Frontmatter } from "./frontmatter";
import type { Field } from "./types";

export const MAX_ALIASES = 10;
export const MAX_ALIAS_LENGTH = 100;
// Unlinked mentions look for an alias as a whole word of at least this length.
export const MIN_ALIAS_MENTION = 2;

export const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("de");

// Trimmed, empty ones dropped, duplicates (ignoring case) removed. Lenient:
// imports pass anything, and a string is split at commas.
export function aliasList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    const alias = String(item).replace(/\s+/g, " ").trim().slice(0, MAX_ALIAS_LENGTH);
    if (!alias || seen.has(fold(alias))) continue;
    seen.add(fold(alias));
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

export const aliasField = (fields: Field[]) => fields.find((f) => f.type === "aliases");
export const recordAliases = (fields: Field[], cells: Record<string, unknown>) => {
  const field = aliasField(fields);
  return field ? aliasList(cells[field.id]) : [];
};
// The stored column of a page (JSON or empty).
export function pageAliases(page: { aliases?: string | null }): string[] {
  if (!page.aliases) return [];
  try {
    return aliasList(JSON.parse(page.aliases));
  } catch {
    return [];
  }
}
export const storedAliases = (list: string[]) => (list.length ? JSON.stringify(list) : null);

// The alias the query matched when the title did not (for "Title · alias").
export function matchedAlias(title: string, aliases: string[], query: string): string | undefined {
  const q = fold(query.trim());
  if (!q || fold(title).includes(q)) return undefined;
  return aliases.find((alias) => fold(alias).includes(q));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Where an alias stands as a whole word in a text (case-insensitive), or -1.
export function aliasIndex(text: string, alias: string): number {
  if ([...alias].length < MIN_ALIAS_MENTION) return -1;
  const match = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(alias)}(?![\\p{L}\\p{N}_])`, "iu").exec(text);
  return match ? match.index : -1;
}

// Obsidian's `aliases:` (a list or one string) and `alias:` in frontmatter.
export function frontmatterAliases(data: Frontmatter): string[] {
  const values = Object.entries(data)
    .filter(([key]) => ["aliases", "alias"].includes(key.trim().toLowerCase()))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .flatMap((value) => (typeof value === "string" ? value.split(",") : typeof value === "number" ? [String(value)] : []));
  return aliasList(values);
}
