// Tabs (#272): the changes to a tabs block, as plain ProseMirror
// transactions – one undo step each – shared by the tab strip
// (lib/tabs-view.ts), the block menu and tests. A tabs block holds one or
// more tabs; each tab a title and any blocks.
import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Selection, type Transaction } from "@tiptap/pm/state";
import { newBlockId, validBlockId } from "./block-ids";

// Upper bound of tabs in one block (the strip scrolls long before).
export const MAX_TABS = 30;
export const MAX_TAB_TITLE = 200;

// A title as stored: one line, trimmed, bounded.
export const tabTitle = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAB_TITLE);

export type TabEntry = { node: PMNode; pos: number; index: number };
// The tabs of the tabs block at `pos`, with their positions.
export function tabsOf(doc: PMNode, pos: number): TabEntry[] {
  const node = doc.nodeAt(pos);
  if (node?.type.name !== "tabs") return [];
  const out: TabEntry[] = [];
  node.forEach((tab, offset, index) => out.push({ node: tab, pos: pos + 1 + offset, index }));
  return out;
}

// A new tab with an empty paragraph (or the blocks given).
export function newTab(schema: Schema, title: string, content?: PMNode[] | Fragment) {
  const { tab, paragraph } = schema.nodes;
  const body = content && (Array.isArray(content) ? content.length : content.childCount) ? content : paragraph.create();
  return tab.create({ title: tabTitle(title) }, body);
}
// A new tabs block with these titles, each tab with an empty paragraph.
export function newTabs(schema: Schema, titles: string[]) {
  return schema.nodes.tabs.create(
    { blockId: newBlockId() },
    titles.map((title) => newTab(schema, title)),
  );
}

// The selection into the tab at `tabPos`: the start of its first text.
function caretInto(trn: Transaction, tabPos: number) {
  const tab = trn.doc.nodeAt(tabPos);
  if (!tab) return;
  const target = Selection.findFrom(trn.doc.resolve(tabPos + 1), 1, true);
  if (target && target.from < tabPos + tab.nodeSize) trn.setSelection(target);
}

// A tab after the last one (or at `index`). Returns its index, or null.
export function addTab(trn: Transaction, pos: number, title: string, index?: number): number | null {
  const node = trn.doc.nodeAt(pos);
  if (node?.type.name !== "tabs" || node.childCount >= MAX_TABS) return null;
  const at = Math.max(0, Math.min(index ?? node.childCount, node.childCount));
  const tabs = tabsOf(trn.doc, pos);
  const insertAt = at < tabs.length ? tabs[at].pos : pos + node.nodeSize - 1;
  trn.insert(insertAt, newTab(trn.doc.type.schema, title));
  caretInto(trn, insertAt);
  return at;
}

export function renameTab(trn: Transaction, pos: number, index: number, title: string): boolean {
  const tab = tabsOf(trn.doc, pos)[index];
  if (!tab) return false;
  const text = tabTitle(title);
  if (tab.node.attrs.title === text) return false;
  trn.setNodeAttribute(tab.pos, "title", text);
  return true;
}

// Moves the tab at `from` to index `to` (counted before the move).
export function moveTab(trn: Transaction, pos: number, from: number, to: number): boolean {
  const tabs = tabsOf(trn.doc, pos);
  const tab = tabs[from];
  const target = Math.max(0, Math.min(to, tabs.length - 1));
  if (!tab || target === from) return false;
  trn.delete(tab.pos, tab.pos + tab.node.nodeSize);
  const after = tabsOf(trn.doc, pos);
  const node = trn.doc.nodeAt(pos)!;
  const insertAt = target < after.length ? after[target].pos : pos + node.nodeSize - 1;
  trn.insert(insertAt, tab.node);
  return true;
}

// Deletes a tab; the last one stays (the whole block goes through its
// block menu).
export function deleteTab(trn: Transaction, pos: number, index: number): boolean {
  const tabs = tabsOf(trn.doc, pos);
  const tab = tabs[index];
  if (!tab || tabs.length < 2) return false;
  trn.delete(tab.pos, tab.pos + tab.node.nodeSize);
  const next = tabsOf(trn.doc, pos)[Math.min(index, tabs.length - 2)];
  if (next) caretInto(trn, next.pos);
  return true;
}

// "Turn into tabs" for neighbouring blocks (from `from` to `to`, one
// level): each heading of the highest level among them starts a tab named
// after it; without headings they all go into one tab. Not inside a tab.
export function blocksToTabs(trn: Transaction, from: number, to: number, fallbackTitle: (n: number) => string): boolean {
  const { schema } = trn.doc.type;
  if (!schema.nodes.tabs) return false;
  const blocks: PMNode[] = [];
  trn.doc.slice(from, to).content.forEach((node) => blocks.push(node));
  if (!blocks.length || blocks.some((b) => !b.isBlock || ["listItem", "taskItem", "tab", "tabs", "column"].includes(b.type.name))) return false;
  const $from = trn.doc.resolve(from);
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "tab") return false;
  const levels = blocks.filter((b) => b.type.name === "heading").map((b) => Number(b.attrs.level) || 1);
  const top = levels.length ? Math.min(...levels) : 0;
  const parts: { title: string; content: PMNode[] }[] = [];
  for (const block of blocks) {
    if (top && block.type.name === "heading" && Number(block.attrs.level) === top) {
      parts.push({ title: block.textContent, content: [] });
      continue;
    }
    if (!parts.length) parts.push({ title: "", content: [] });
    parts[parts.length - 1].content.push(block);
  }
  const tabs = parts.slice(0, MAX_TABS).map((part, i) => newTab(schema, part.title || fallbackTitle(i + 1), part.content));
  // More tabs than allowed: the rest goes into the last one.
  for (const part of parts.slice(MAX_TABS)) {
    const last = tabs[tabs.length - 1];
    const heading = schema.nodes.heading.create({ level: top || 2 }, part.title ? schema.text(part.title) : null);
    tabs[tabs.length - 1] = last.copy(last.content.append(Fragment.from([heading, ...part.content])));
  }
  const fragment = Fragment.from(schema.nodes.tabs.create({ blockId: newBlockId() }, tabs));
  if (!$from.parent.canReplace($from.index(), trn.doc.resolve(to).index(), fragment)) return false;
  trn.replaceWith(from, to, fragment);
  caretInto(trn, from + 1);
  return true;
}

// A tabs block back into plain blocks: each tab's title as a heading of
// `level`, its content after it (the reverse of blocksToTabs).
export function tabsToBlocks(trn: Transaction, pos: number, level = 3): boolean {
  const node = trn.doc.nodeAt(pos);
  if (node?.type.name !== "tabs") return false;
  const { schema } = trn.doc.type;
  const blocks: PMNode[] = [];
  node.forEach((tab, _offset, index) => {
    const title = tabTitle(tab.attrs.title);
    blocks.push(
      schema.nodes.heading.create(
        { level, blockId: index === 0 ? validBlockId(node.attrs.blockId) : null },
        title ? schema.text(title) : null,
      ),
    );
    tab.forEach((child) => blocks.push(child));
  });
  const fragment = Fragment.from(blocks);
  const $pos = trn.doc.resolve(pos);
  if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, fragment)) return false;
  trn.replaceWith(pos, pos + node.nodeSize, fragment);
  trn.setSelection(Selection.near(trn.doc.resolve(pos + 1)));
  return true;
}
