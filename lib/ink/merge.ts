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
// The order of items (back to front) follows theirs, our additions on top –
// unless only we changed the order (bring to front/back): then ours, with
// their additions on top.
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
  // Brought to the front or back by us only: our order, their additions on top.
  if (reordered(base, ours) && !reordered(base, theirs)) {
    const rank = new Map(ours.map((i, n) => [i.id, n]));
    out.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }
  return out.slice(0, INK_LIMITS.itemsPerPage);
}
// Did the items both lists share change their order?
function reordered(base: InkItem[], list: InkItem[]) {
  const inList = new Set(list.map((i) => i.id));
  const a = base.map((i) => i.id).filter((id) => inList.has(id));
  const inBase = new Set(a);
  const b = list.map((i) => i.id).filter((id) => inBase.has(id));
  return a.some((id, i) => id !== b[i]);
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
