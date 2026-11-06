// Folding headings (#71): every heading at the top level of a document can
// be folded, which hides everything below it up to the next heading of the
// same or a higher level (like Notion or Obsidian). Folding is a way of
// looking at the document, not a change of it: what is folded is stored per
// person and device (localStorage), never in the shared document. Default:
// unfolded.
//
// Only headings directly in the document fold: a heading inside a callout,
// toggle, table, column or list stays as it is (the box it is in has its own
// way of hiding, or none), and a section ends at the document's next heading
// of the same or a higher level – blocks inside boxes are simply part of the
// section the box is in.
//
// A heading is identified by its text and its occurrence among headings of
// the same text ("Notes", the second "Notes" …), as a short hash so the
// stored list carries no document text (encrypted pages included). While the
// document is open the identity follows the heading itself (carryFolds):
// typing in a folded heading, others' edits around it, moving it – the
// section stays folded.

// One top-level block of a document: a heading (level, text) or anything else.
export type FoldBlock = { heading: { level: number; text: string } | null; size: number; node?: unknown };

// A heading's section: the heading at `pos`, the hidden part from
// `headingEnd` to `end` with `hidden` blocks.
export type FoldSection = {
  index: number;
  pos: number;
  headingEnd: number;
  end: number;
  level: number;
  id: string;
  hidden: number;
  node?: unknown;
};

// A short stable hash (cyrb53) as base 36.
function hash(text: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const normalizeHeadingText = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

// The identity of a heading: its text (spacing and case ignored) and which
// occurrence of that text it is, counted from 0.
export function headingId(text: string, occurrence: number): string {
  return `${hash(normalizeHeadingText(text))}.${occurrence}`;
}

// The sections of a document's top-level blocks, starting at `start` (the
// position of the first block; 0 in a ProseMirror document).
export function foldSections(blocks: FoldBlock[], start = 0): FoldSection[] {
  const positions: number[] = [];
  let at = start;
  for (const block of blocks) {
    positions.push(at);
    at += block.size;
  }
  const docEnd = at;
  const seen = new Map<string, number>();
  const sections: FoldSection[] = [];
  blocks.forEach((block, index) => {
    if (!block.heading) return;
    const level = block.heading.level;
    let next = index + 1;
    while (next < blocks.length && !(blocks[next].heading && blocks[next].heading!.level <= level)) next++;
    const key = normalizeHeadingText(block.heading.text);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    sections.push({
      index,
      pos: positions[index],
      headingEnd: positions[index] + block.size,
      end: next < blocks.length ? positions[next] : docEnd,
      level,
      id: headingId(block.heading.text, occurrence),
      hidden: next - index - 1,
      node: block.node,
    });
  });
  return sections;
}

// After a change of the document: the folded ids for the new sections. A
// folded heading stays folded when it is still there – found as the same
// node (others' edits elsewhere keep unchanged blocks), at its mapped
// position (typing in it, moving it), by its id, or as a changed heading of
// the same level at the same place (someone else edited its text). Ids
// without a heading (yet) stay: the document may still be loading.
export function carryFolds(
  folded: ReadonlySet<string>,
  before: FoldSection[],
  after: FoldSection[],
  map: (pos: number) => number | null = () => null,
): Set<string> {
  const next = new Set(folded);
  if (!before.length) return next;
  const beforeIds = new Set(before.map((s) => s.id));
  const taken = new Set<FoldSection>();
  const byNode = new Map<unknown, FoldSection>();
  const byPos = new Map<number, FoldSection>();
  const byId = new Map<string, FoldSection>();
  for (const s of after) {
    if (s.node !== undefined && !byNode.has(s.node)) byNode.set(s.node, s);
    byPos.set(s.pos, s);
    byId.set(s.id, s);
  }
  const moves: [string, string][] = [];
  for (const old of before) {
    if (!folded.has(old.id)) continue;
    const free = (s: FoldSection | undefined) => (s && !taken.has(s) ? s : undefined);
    const mapped = map(old.pos);
    const found =
      free(old.node !== undefined ? byNode.get(old.node) : undefined) ||
      free(mapped === null ? undefined : byPos.get(mapped)) ||
      free(byId.get(old.id)) ||
      free(after.find((s) => s.index === old.index && s.level === old.level && !beforeIds.has(s.id)));
    if (!found) continue;
    taken.add(found);
    if (found.id !== old.id) moves.push([old.id, found.id]);
  }
  for (const [from] of moves) next.delete(from);
  for (const [, to] of moves) next.add(to);
  return next;
}

// The folded sections that hide something, outermost only (a folded section
// inside another folded one is hidden with it).
export function hiddenRanges(sections: FoldSection[], folded: ReadonlySet<string>): FoldSection[] {
  const out: FoldSection[] = [];
  for (const s of sections) {
    if (!folded.has(s.id) || !s.hidden) continue;
    const last = out.at(-1);
    if (last && s.pos < last.end) continue;
    out.push(s);
  }
  return out;
}

// Whether a position lies in the hidden part of a section.
export const hides = (s: FoldSection, pos: number) => pos >= s.headingEnd && pos < s.end;

// The folded sections whose hidden part holds `pos` (all levels).
export function foldedAround(sections: FoldSection[], folded: ReadonlySet<string>, pos: number): FoldSection[] {
  return sections.filter((s) => folded.has(s.id) && s.hidden && hides(s, pos));
}

// The ids of all sections that have something to hide (fold everything).
export const foldableIds = (sections: FoldSection[]) => sections.filter((s) => s.hidden > 0).map((s) => s.id);

// Positions of blocks, extended by the hidden blocks of folded headings
// among them: moving a folded heading moves its section.
export function withFoldedSections(
  positions: number[],
  sections: FoldSection[],
  folded: ReadonlySet<string>,
  blockStarts: number[],
): number[] {
  const out = new Set(positions);
  for (const pos of positions) {
    const s = sections.find((x) => x.pos === pos);
    if (!s || !folded.has(s.id) || !s.hidden) continue;
    for (const start of blockStarts) if (start >= s.headingEnd && start < s.end) out.add(start);
  }
  return [...out].sort((a, b) => a - b);
}

// ---- Storage: per device, keyed by page (and record) ----

type Store = Record<string, { ids: string[]; at: number }>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const FOLD_STORAGE_KEY = "flowplan.folds";
// At most this many documents are remembered (the least recently changed
// go first) and this many folded headings per document.
export const MAX_FOLD_DOCUMENTS = 300;
export const MAX_FOLDS = 500;

export const foldDocumentKey = (pageId: string, rowId?: string | null) => (rowId ? `${pageId}/${rowId}` : pageId);

function readStore(storage: StorageLike | null): Store {
  try {
    const raw = storage?.getItem(FOLD_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Store) : {};
  } catch {
    return {};
  }
}

export function readFolds(storage: StorageLike | null, key: string): string[] {
  const entry = readStore(storage)[key];
  if (!entry || !Array.isArray(entry.ids)) return [];
  return entry.ids.filter((id) => typeof id === "string" && /^[0-9a-z]{1,16}\.\d{1,5}$/.test(id)).slice(0, MAX_FOLDS);
}

export function writeFolds(storage: StorageLike | null, key: string, ids: Iterable<string>, now = Date.now()) {
  if (!storage) return;
  const store = readStore(storage);
  const list = [...new Set(ids)].slice(0, MAX_FOLDS);
  if (list.length) store[key] = { ids: list, at: now };
  else delete store[key];
  const keys = Object.keys(store).filter((k) => store[k] && Array.isArray(store[k].ids));
  const kept = keys.sort((a, b) => (store[b].at || 0) - (store[a].at || 0)).slice(0, MAX_FOLD_DOCUMENTS);
  try {
    if (!kept.length) storage.removeItem(FOLD_STORAGE_KEY);
    else storage.setItem(FOLD_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept.map((k) => [k, store[k]]))));
  } catch {}
}

// ---- Outside the editor: unfolding what an element is in, fold all ----

// Asks the editor to unfold the section an element is hidden in (find on
// the page, jumps to a block). True when it was hidden.
export const FOLD_UNFOLD_EVENT = "flowplan-unfold";
// Closed toggles around it open as well (#137; in the editor the toggle's
// node view follows its element).
export function unfoldElement(el: Element | null | undefined): boolean {
  const toggles = closedToggles(el);
  for (const details of toggles) details.open = true;
  const hidden = el?.closest?.(".fold-hidden");
  if (!hidden) return toggles.length > 0;
  hidden.dispatchEvent(new CustomEvent(FOLD_UNFOLD_EVENT, { bubbles: true }));
  return true;
}
// The closed toggles (<details>) whose content holds an element.
function closedToggles(el: Element | null | undefined): HTMLDetailsElement[] {
  const out: HTMLDetailsElement[] = [];
  for (let d = el?.closest?.("details"); d; d = d.parentElement?.closest("details"))
    if (d instanceof HTMLDetailsElement && !d.open && !d.querySelector(":scope > summary")?.contains(el!)) out.push(d);
  return out;
}
export const isFolded = (el: Element | null | undefined) => !!el?.closest?.(".fold-hidden") || closedToggles(el).length > 0;

// "Alle Abschnitte einklappen / ausklappen": the open document's editor
// (the record's in an open dialog) folds or unfolds everything.
export const FOLD_ALL_EVENT = "flowplan-fold-all";
export function foldAllSections(fold: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOLD_ALL_EVENT, { detail: { fold } }));
}
