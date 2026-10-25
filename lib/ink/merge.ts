// Three-way merge of ink: what two people changed since the same saved
// state both survive. Items are compared by id (strokes are never edited in
// place without a new state of the whole item, so an item is the unit):
//
//   added by either side            → kept (theirs first, then ours)
//   deleted by one, untouched by the other → deleted
//   changed by one side             → that side's state
//   changed by both                 → ours (the later save)
//   deleted by one, changed by the other   → the changed item stays
//
// The order of items (back to front) follows theirs, our additions on top.
import { emptyInk, INK_LIMITS, type InkDoc, type InkItem } from "./model";

const same = (a: InkItem | undefined, b: InkItem | undefined) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export function mergePage(base: InkItem[], ours: InkItem[], theirs: InkItem[]): InkItem[] {
  const before = new Map(base.map((i) => [i.id, i]));
  const mine = new Map(ours.map((i) => [i.id, i]));
  const other = new Map(theirs.map((i) => [i.id, i]));
  const out: InkItem[] = [];
  for (const item of theirs) {
    const original = before.get(item.id);
    const own = mine.get(item.id);
    if (own) out.push(original && same(own, original) ? item : own);
    else if (!original || !same(item, original)) out.push(item);
  }
  for (const own of ours) {
    if (other.has(own.id)) continue;
    const original = before.get(own.id);
    if (!original || !same(own, original)) out.push(own);
  }
  return out.slice(0, INK_LIMITS.itemsPerPage);
}

export function mergeInk(base: InkDoc, ours: InkDoc, theirs: InkDoc): InkDoc {
  const doc = emptyInk();
  const keys = new Set([...Object.keys(base.pages), ...Object.keys(ours.pages), ...Object.keys(theirs.pages)]);
  for (const key of keys) {
    const items = mergePage(base.pages[key] || [], ours.pages[key] || [], theirs.pages[key] || []);
    if (items.length) doc.pages[key] = items;
  }
  return doc;
}
