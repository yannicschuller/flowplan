// Fixed suggestion lists for a form's text question (#385): entries the
// form's author typed in, offered while answering in every form – public
// ones too, since they hold nothing but what the author wrote. Merged with
// earlier answers (#374, lib/form-suggestions.ts) where those are allowed:
// the fixed list first, no duplicates. Client-safe (no imports).

// At most this many entries per question, each at most this long.
export const SUGGESTION_LIST_MAX = 200;
export const SUGGESTION_LIST_ITEM_MAX = 200;
// Suggestions shown while typing; browsing an empty field shows more.
export const SUGGESTION_SHOWN = 8;
export const SUGGESTION_BROWSE = 50;

const fold = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();

// Trimmed, inner whitespace collapsed, empty lines dropped, the first
// spelling of an entry kept (case-insensitive).
export function cleanSuggestionList(lines: readonly string[]): string[] {
  const seen = new Set<string>(),
    out: string[] = [];
  for (const line of lines) {
    const text = line.trim().replace(/\s+/g, " ");
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// The textarea's text as a list (one entry per line), cleaned.
export const suggestionListFromText = (text: string) => cleanSuggestionList(text.split(/\r?\n/));

// What is wrong with a list, if anything: too many or too long entries.
export function suggestionListProblem(list: readonly string[]): "count" | "length" | undefined {
  if (list.length > SUGGESTION_LIST_MAX) return "count";
  if (list.some((s) => s.length > SUGGESTION_LIST_ITEM_MAX)) return "length";
  return undefined;
}

// Entries matching the query, from the first character: those starting
// with it first, then those containing it, each in the author's order.
// An empty query (browsing with the arrow key) gives the list's start.
export function matchSuggestionList(list: readonly string[] | undefined, query: string, limit = SUGGESTION_SHOWN) {
  if (!list?.length) return [];
  const q = fold(query.slice(0, SUGGESTION_LIST_ITEM_MAX));
  if (!q) return list.slice(0, limit);
  const prefix: string[] = [],
    contains: string[] = [];
  for (const entry of list) {
    const key = fold(entry);
    // What was typed already is no suggestion.
    if (key === q) continue;
    if (key.startsWith(q)) prefix.push(entry);
    else if (key.includes(q)) contains.push(entry);
  }
  return [...prefix, ...contains].slice(0, limit);
}

// The fixed list's matches first, then earlier answers not already in it.
export function mergeSuggestions(fixed: readonly string[], earlier: readonly string[], limit = SUGGESTION_SHOWN) {
  const seen = new Set<string>(),
    out: string[] = [];
  for (const entry of [...fixed, ...earlier]) {
    const key = fold(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.slice(0, limit);
}
