import { z } from "zod";

// "Formatierungsleiste anpassen" (#292, Settings → Appearance & language →
// Editor): which buttons the fixed formatting toolbar of pages and records
// (components/editor.tsx) shows, in which order, which share one button
// with a small menu (a group), and where dividers separate them. Stored per
// person on the server (users.toolbar_layout, JSON; NULL = the default), so
// it follows the person to every device.
//
// A layout is the order of every button – a button on its own, a group (an
// array of buttons, rendered as one button opening a menu of them) or a
// divider ("|") – plus the hidden buttons. A hidden button keeps its place,
// so showing it again puts it back where it was. Buttons a later version
// adds are not in a stored layout: they appear at their default place
// (after the button they follow by default), shown unless the default
// hides them – never hidden without a choice.

// An administrator may set a default for everyone without a layout of
// their own (Administration → Instanz, instance setting
// toolbarLayoutDefault, null = the built-in default below); a person's own
// layout wins, "Zurücksetzen" goes back to the instance's default.
//
// Every button of the toolbar, in the default order. Some only show while
// they apply (an image, a video or a task is selected); "Hide keyboard" on
// phones is not part of it and always stays at the end.
export const TOOLBAR_BUTTONS = [
  "undo",
  "redo",
  "imageTools",
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "highlight",
  "comment",
  "color",
  "mediaWidth",
  "superscript",
  "subscript",
  "spoiler",
  "cloze",
  "suggest",
  "authors",
  "link",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "taskDue",
  "align",
  "blockUp",
  "blockDown",
  "indent",
  "outdent",
  "outline",
  "inlineMath",
  "addBlock",
] as const;
export type ToolbarButton = (typeof TOOLBAR_BUTTONS)[number];
// The blocks of the "/" menu (components/editor.tsx, `commands`) as buttons
// of their own: "block:" and the slash entry's id. A click inserts the
// block as choosing it in the menu does (the callout opens its kinds).
// They are not in the toolbar until someone adds one: a stored layout
// without them stays as it is, they are never put back at a default place,
// and one taken out again leaves the order. Entries that are buttons
// already (task, bulleted and numbered list, spoiler, inline formula) and
// the blocks of extensions (they differ per instance) are not among them.
export const TOOLBAR_BLOCKS = [
  "block:ai",
  "block:text",
  "block:h1",
  "block:h2",
  "block:h3",
  "block:h4",
  "block:quote",
  "block:divider",
  "block:page-break",
  "block:citation",
  "block:bibliography",
  "block:callout",
  "block:toggle",
  "block:code",
  "block:table",
  "block:columns",
  "block:tabs",
  "block:footnote",
  "block:file",
  "block:embed",
  "block:mermaid",
  "block:drawio",
  "block:draw",
  "block:whiteboard",
  "block:meet",
  "block:voice",
  "block:scan",
  "block:math",
  "block:plot",
  "block:fraction",
  "block:metric",
  "block:dashboard",
  "block:mention",
  "block:linked-database",
  "block:synced",
  "block:synced-insert",
  "block:workflow-button",
] as const;
export type ToolbarBlock = (typeof TOOLBAR_BLOCKS)[number];
export const TOOLBAR_ITEMS = [...TOOLBAR_BUTTONS, ...TOOLBAR_BLOCKS] as const;
export type ToolbarItem = (typeof TOOLBAR_ITEMS)[number];
const blocks = new Set<string>(TOOLBAR_BLOCKS);
export const isToolbarBlock = (value: unknown): value is ToolbarBlock => typeof value === "string" && blocks.has(value);
// The id of the "/" menu entry a block button stands for.
export const slashIdOf = (block: ToolbarBlock) => block.slice("block:".length);
export const TOOLBAR_DIVIDER = "|";
export type ToolbarDivider = typeof TOOLBAR_DIVIDER;

// Buttons that can share a group's menu: plain actions and toggles, and
// every block. Menus of their own (colour, text style, alignment, media
// width), the image tools (two buttons), the due date (it opens a picker at
// itself) and the table of contents (it toggles a panel anchored to its
// button) stay buttons of their own.
export const GROUPABLE_BUTTONS = [
  "undo",
  "redo",
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "highlight",
  "comment",
  "superscript",
  "subscript",
  "spoiler",
  "cloze",
  "suggest",
  "authors",
  "link",
  "bulletList",
  "orderedList",
  "taskList",
  "blockUp",
  "blockDown",
  "indent",
  "outdent",
  "inlineMath",
  "addBlock",
] as const satisfies readonly ToolbarButton[];
export type GroupableButton = (typeof GROUPABLE_BUTTONS)[number];
export const GROUPABLE_ITEMS = [...GROUPABLE_BUTTONS, ...TOOLBAR_BLOCKS] as const;
export type GroupableItem = (typeof GROUPABLE_ITEMS)[number];
export type ToolbarGroup = GroupableItem[];
export type ToolbarEntry = ToolbarItem | ToolbarDivider | ToolbarGroup;
export type ToolbarLayout = { order: ToolbarEntry[]; hidden: ToolbarItem[] };

export const isToolbarGroup = (entry: ToolbarEntry): entry is ToolbarGroup => Array.isArray(entry);
const known = new Set<string>(TOOLBAR_ITEMS);
const groupable = new Set<string>(GROUPABLE_ITEMS);
export const isToolbarItem = (value: unknown): value is ToolbarItem => typeof value === "string" && known.has(value);
export const isGroupableItem = (value: unknown): value is GroupableItem => typeof value === "string" && groupable.has(value);

export const DEFAULT_TOOLBAR_ORDER: ToolbarEntry[] = [
  "undo",
  "redo",
  "imageTools",
  "|",
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "highlight",
  "comment",
  "color",
  "mediaWidth",
  "superscript",
  "subscript",
  "spoiler",
  "cloze",
  "suggest",
  "authors",
  "link",
  "|",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "taskDue",
  "align",
  "blockUp",
  "blockDown",
  "indent",
  "outdent",
  "outline",
  "inlineMath",
  "addBlock",
];
// Bulleted and numbered lists were not in the toolbar before #292 (the
// slash menu and Markdown shortcuts make them); they are there to be shown
// or grouped ("Listen"), hidden by default so the toolbar stays as it was.
//
// Indent and outdent (#302, what Tab / ⇧Tab do, for touch screens) came
// later and are hidden by default too: a stored layout without them gets
// them back at their place, hidden (parsedToolbarLayout).
//
// The cloze of flashcards (lib/cloze-mark.ts, ⌘⌥G) came with phase 5 of
// the flashcards and is hidden by default as well: only people who make
// cards need it.
//
// Inline code (#465, the `code` mark, ⌘E) came after that and is shown:
// on a phone the toolbar is the only way to it (no text menu, no ⌘E), so a
// stored layout without it gets it right after strikethrough (or the group
// holding it), shown – as spoiler and suggest did. Not to be confused with
// "block:code", the code block of the "/" menu.
export const DEFAULT_HIDDEN: ToolbarItem[] = ["bulletList", "orderedList", "indent", "outdent", "cloze"];
export function defaultToolbarLayout(): ToolbarLayout {
  return { order: [...DEFAULT_TOOLBAR_ORDER], hidden: [...DEFAULT_HIDDEN] };
}

// Groups to apply with one click in the settings (#292's examples).
export const TOOLBAR_GROUP_PRESETS = {
  lists: ["bulletList", "orderedList", "taskList"],
  scripts: ["strike", "superscript", "subscript"],
} as const satisfies Record<string, readonly GroupableItem[]>;
export type ToolbarGroupPreset = keyof typeof TOOLBAR_GROUP_PRESETS;

// At most one divider between two entries, so this bounds what is stored.
export const TOOLBAR_ORDER_MAX = TOOLBAR_ITEMS.length * 2;

// What the server accepts: only known buttons, each once in the whole
// order, groups of groupable buttons, bounded. null clears the layout (back
// to the default).
const groupSchema = z.array(z.enum(GROUPABLE_ITEMS)).min(2).max(GROUPABLE_ITEMS.length);
const entrySchema = z.union([z.enum(TOOLBAR_ITEMS), z.literal(TOOLBAR_DIVIDER), groupSchema]);
const itemsOf = (order: readonly ToolbarEntry[]): ToolbarItem[] => order.flatMap((e) => (isToolbarGroup(e) ? e : e === TOOLBAR_DIVIDER ? [] : [e]));
export const toolbarLayoutSchema = z
  .object({
    order: z
      .array(entrySchema)
      .max(TOOLBAR_ORDER_MAX)
      .refine((order) => {
        const items = itemsOf(order);
        return new Set(items).size === items.length;
      }, "A button may appear only once."),
    hidden: z
      .array(z.enum(TOOLBAR_ITEMS))
      .max(TOOLBAR_ITEMS.length)
      .refine((hidden) => new Set(hidden).size === hidden.length, "A button may be hidden only once."),
  })
  .strict()
  .nullable();

// Dividers only between two entries: none at the ends, never two in a row.
function tidy(order: ToolbarEntry[]): ToolbarEntry[] {
  const out: ToolbarEntry[] = [];
  for (const entry of order) {
    if (entry === TOOLBAR_DIVIDER && (!out.length || out[out.length - 1] === TOOLBAR_DIVIDER)) continue;
    out.push(entry);
  }
  while (out[out.length - 1] === TOOLBAR_DIVIDER) out.pop();
  return out;
}
// The index of the entry holding a button (itself or its group), or -1.
export function entryIndexOf(order: readonly ToolbarEntry[], item: ToolbarItem): number {
  return order.findIndex((e) => e === item || (isToolbarGroup(e) && (e as string[]).includes(item)));
}

// What a stored value means, leniently: unknown buttons (from a newer or
// broken value) are dropped, duplicates keep their first place, groups
// keep only groupable buttons (one left: a button of its own), dividers
// are tidied, and every known button missing from the order is put back at
// its default place – right after the entry holding the nearest button
// that precedes it by default, or at the start – hidden only if the
// default hides it. Anything that is not a layout is the default.
// `fallback` is what applies otherwise (the instance's default).
export function toolbarLayoutOf(value: unknown, fallback: ToolbarLayout = defaultToolbarLayout()): ToolbarLayout {
  return parsedToolbarLayout(value) ?? fallback;
}
// The same, null for anything that is not a layout.
export function parsedToolbarLayout(value: unknown): ToolbarLayout | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { order?: unknown }).order)) return null;
  const seen = new Set<ToolbarItem>();
  const order: ToolbarEntry[] = [];
  for (const entry of (raw as { order: unknown[] }).order.slice(0, TOOLBAR_ORDER_MAX * 2)) {
    if (entry === TOOLBAR_DIVIDER) order.push(TOOLBAR_DIVIDER);
    else if (isToolbarItem(entry) && !seen.has(entry)) {
      seen.add(entry);
      order.push(entry);
    } else if (Array.isArray(entry)) {
      const group: GroupableItem[] = [];
      for (const item of entry.slice(0, GROUPABLE_ITEMS.length * 2))
        if (isGroupableItem(item) && !seen.has(item)) {
          seen.add(item);
          group.push(item);
        }
      if (group.length > 1) order.push(group);
      else if (group.length === 1) order.push(group[0]);
    }
  }
  const hiddenRaw = (raw as { hidden?: unknown }).hidden;
  const hidden = new Set<ToolbarItem>(Array.isArray(hiddenRaw) ? TOOLBAR_ITEMS.filter((item) => hiddenRaw.includes(item)) : []);
  // A hidden block of its own is out of the toolbar: it leaves the order
  // (a hidden block in a group keeps its place there).
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = order[i];
    if (isToolbarBlock(entry) && hidden.has(entry)) order.splice(i, 1);
  }
  for (const item of hidden) if (isToolbarBlock(item) && entryIndexOf(order, item) < 0) hidden.delete(item);
  TOOLBAR_BUTTONS.forEach((item, index) => {
    if (seen.has(item)) return;
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const before = entryIndexOf(order, TOOLBAR_BUTTONS[i]);
      if (before >= 0) {
        at = before + 1;
        break;
      }
    }
    order.splice(at, 0, item);
    seen.add(item);
    if (DEFAULT_HIDDEN.includes(item)) hidden.add(item);
  });
  return { order: tidy(order), hidden: TOOLBAR_ITEMS.filter((item) => hidden.has(item)) };
}

const keyOf = (layout: ToolbarLayout) => JSON.stringify([layout.order, [...layout.hidden].sort()]);
export function sameToolbarLayout(a: ToolbarLayout, b: ToolbarLayout) {
  return keyOf(a) === keyOf(b);
}
export function isDefaultToolbarLayout(layout: ToolbarLayout) {
  return sameToolbarLayout(layout, defaultToolbarLayout());
}

// What the toolbar renders, given which buttons apply right now (the image
// tools only while an image is selected, …): the shown entries in order,
// hidden buttons left out – a group with one shown button left is that
// button, one with none falls away – and a divider only between two
// rendered entries.
export function toolbarEntries(layout: ToolbarLayout, applies: (item: ToolbarItem) => boolean = () => true): ToolbarEntry[] {
  const hidden = new Set(layout.hidden);
  const shown = (item: ToolbarItem) => !hidden.has(item) && applies(item);
  const out: ToolbarEntry[] = [];
  for (const entry of layout.order) {
    if (entry === TOOLBAR_DIVIDER) out.push(entry);
    else if (isToolbarGroup(entry)) {
      const items = entry.filter(shown);
      if (items.length > 1) out.push(items);
      else if (items.length === 1) out.push(items[0]);
    } else if (shown(entry)) out.push(entry);
  }
  return tidy(out);
}

// ---- Edits in the settings, each returning a new layout. ----

export function moveToolbarEntry(layout: ToolbarLayout, from: number, to: number): ToolbarLayout {
  if (from === to || from < 0 || to < 0 || from >= layout.order.length || to >= layout.order.length) return layout;
  const order = [...layout.order];
  const [entry] = order.splice(from, 1);
  order.splice(to, 0, entry);
  return { ...layout, order };
}
// A divider right after the entry at `index`, unless one is already next
// to it there.
export function addToolbarDivider(layout: ToolbarLayout, index: number): ToolbarLayout {
  if (index < 0 || index >= layout.order.length - 1) return layout;
  if (layout.order[index] === TOOLBAR_DIVIDER || layout.order[index + 1] === TOOLBAR_DIVIDER) return layout;
  const order = [...layout.order];
  order.splice(index + 1, 0, TOOLBAR_DIVIDER);
  return { ...layout, order };
}
export function removeToolbarEntry(layout: ToolbarLayout, index: number): ToolbarLayout {
  if (layout.order[index] !== TOOLBAR_DIVIDER) return layout;
  return { ...layout, order: layout.order.filter((_, i) => i !== index) };
}
// A block not in the toolbar yet is added at its end; one of its own taken
// out leaves the order again (back among the blocks of the settings).
export function setToolbarItemShown(layout: ToolbarLayout, item: ToolbarItem, shown: boolean): ToolbarLayout {
  const hidden = layout.hidden.filter((h) => h !== item);
  const at = entryIndexOf(layout.order, item);
  if (isToolbarBlock(item)) {
    if (shown && at < 0) return { order: [...layout.order, item], hidden };
    if (!shown && layout.order[at] === item) return { order: tidy(layout.order.filter((_, i) => i !== at)), hidden };
  }
  if (!shown) hidden.push(item);
  return { ...layout, hidden: TOOLBAR_ITEMS.filter((i) => hidden.includes(i)) };
}
// The blocks not in the toolbar: what the settings offer to add.
export function blocksOutside(layout: ToolbarLayout): ToolbarBlock[] {
  return TOOLBAR_BLOCKS.filter((block) => entryIndexOf(layout.order, block) < 0);
}
// Where a divider may go: after every entry but the last, unless one is
// already next to it there.
export function dividerPlaces(layout: ToolbarLayout): number[] {
  const { order } = layout;
  return order.flatMap((entry, i) => (i < order.length - 1 && entry !== TOOLBAR_DIVIDER && order[i + 1] !== TOOLBAR_DIVIDER ? [i] : []));
}
// Whether the entry at `index` can join the next entry in one group: both
// a groupable button or a group.
export function canGroupWithNext(layout: ToolbarLayout, index: number): boolean {
  const a = layout.order[index],
    b = layout.order[index + 1];
  const fits = (e: ToolbarEntry | undefined) => e !== undefined && (isToolbarGroup(e) || isGroupableItem(e));
  return fits(a) && fits(b);
}
// The entry at `index` and the next one become one group.
export function groupWithNext(layout: ToolbarLayout, index: number): ToolbarLayout {
  if (!canGroupWithNext(layout, index)) return layout;
  const members = (e: ToolbarEntry) => (isToolbarGroup(e) ? e : [e as GroupableItem]);
  const order = [...layout.order];
  order.splice(index, 2, [...members(order[index]), ...members(order[index + 1])]);
  return { ...layout, order };
}
// The group at `index` becomes its buttons again, in its order.
export function ungroupToolbarEntry(layout: ToolbarLayout, index: number): ToolbarLayout {
  const group = layout.order[index];
  if (!group || !isToolbarGroup(group)) return layout;
  const order = [...layout.order];
  order.splice(index, 1, ...group);
  return { ...layout, order };
}
// A button out of its group, placed right after the group (a group of two
// becomes two buttons).
export function takeOutOfGroup(layout: ToolbarLayout, index: number, member: number): ToolbarLayout {
  const group = layout.order[index];
  if (!group || !isToolbarGroup(group) || member < 0 || member >= group.length) return layout;
  const rest = group.filter((_, i) => i !== member);
  const order = [...layout.order];
  order.splice(index, 1, ...(rest.length > 1 ? [rest] : rest), group[member]);
  return { ...layout, order };
}
// A button up or down inside its group's menu.
export function moveInGroup(layout: ToolbarLayout, index: number, from: number, to: number): ToolbarLayout {
  const group = layout.order[index];
  if (!group || !isToolbarGroup(group) || from === to || from < 0 || to < 0 || from >= group.length || to >= group.length) return layout;
  const next = [...group];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  const order = [...layout.order];
  order[index] = next;
  return { ...layout, order };
}
// A preset group: its buttons taken from wherever they are and put
// together, shown, where the first of them was.
export function applyGroupPreset(layout: ToolbarLayout, preset: ToolbarGroupPreset): ToolbarLayout {
  const items: readonly GroupableItem[] = TOOLBAR_GROUP_PRESETS[preset];
  const at = Math.min(...items.map((item) => entryIndexOf(layout.order, item)).filter((i) => i >= 0));
  const order: (ToolbarEntry | null)[] = layout.order.map((entry) => {
    if (isToolbarGroup(entry)) {
      const rest = entry.filter((item) => !items.includes(item));
      return rest.length > 1 ? rest : rest.length === 1 ? rest[0] : null;
    }
    return items.includes(entry as GroupableItem) ? null : entry;
  });
  order.splice(Number.isFinite(at) ? at : order.length, 0, [...items]);
  return {
    order: tidy(order.filter((e): e is ToolbarEntry => e !== null)),
    hidden: layout.hidden.filter((item) => !items.includes(item as GroupableItem)),
  };
}
// Whether the layout already has exactly this preset group.
export function hasGroupPreset(layout: ToolbarLayout, preset: ToolbarGroupPreset): boolean {
  const items: readonly string[] = TOOLBAR_GROUP_PRESETS[preset];
  return layout.order.some((e) => isToolbarGroup(e) && e.length === items.length && e.every((item, i) => item === items[i])) && !layout.hidden.some((h) => items.includes(h));
}
