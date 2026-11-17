// Finding tags by typing (#328): the tag filter of the search and the
// suggestions after `#` in the search input. Pure, so tests can call it.
import { tagToken } from "./page-properties";

// Case and diacritics do not count ("über" finds "Uber"), nor do runs of
// spaces.
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();

// The tags whose name contains `query` anywhere, the best first: the same
// name, then names that start with it, then a word in the name that starts
// with it, then the rest; within each, shorter names first, then by name.
// An empty query keeps every tag in the given order.
export function rankTags<T extends { name: string }>(tags: readonly T[], query: string): T[] {
  const q = fold(query.replace(/^#/, ""));
  if (!q) return [...tags];
  const scored: { tag: T; name: string; score: number; index: number }[] = [];
  tags.forEach((tag, index) => {
    const name = fold(tag.name);
    const at = name.indexOf(q);
    if (at < 0) return;
    const score = name === q ? 0 : at === 0 ? 1 : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q)}`, "u").test(name) ? 2 : 3;
    scored.push({ tag, name, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.index - b.index)
    .map((s) => s.tag);
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The `#…` being typed at the caret: from the `#` (after the start or a
// space, with a `-` in front for "without this tag") over the letters up to
// the caret and on to the end of that word. `#"two words` counts as well.
// `query` is what follows the `#` (without the quote). Null when the caret
// is not in such a fragment.
export type TagFragment = { start: number; end: number; query: string; exclude: boolean };
export function tagFragmentAt(value: string, caret: number): TagFragment | null {
  if (caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const m = /(^|\s)(-?)#(?:"([^"]*)|([^\s"#]*))$/u.exec(before);
  if (!m) return null;
  const start = m.index + m[1].length;
  const quoted = m[3] !== undefined;
  // The rest of the word (or of the quoted name, with its closing quote).
  const after = value.slice(caret);
  const rest = quoted ? /^[^"]*"?/.exec(after) : /^[^\s"#]*/.exec(after);
  const end = caret + (rest ? rest[0].length : 0);
  return { start, end, query: (quoted ? m[3] : m[4]) ?? "", exclude: m[2] === "-" };
}

// The query with the fragment replaced by the tag's token (quoted where the
// name needs it) and one space after it; `caret` is just after that space.
export function insertTagToken(value: string, fragment: TagFragment, name: string): { value: string; caret: number } {
  const token = `${fragment.exclude ? "-" : ""}${tagToken(name)}`;
  const after = value.slice(fragment.end);
  const head = value.slice(0, fragment.start) + token + " ";
  return { value: head + after.replace(/^\s/, ""), caret: head.length };
}
