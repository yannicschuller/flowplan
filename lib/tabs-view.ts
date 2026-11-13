// Tabs in the editor (#272): the tab strip above the tabs of a tabs block,
// and which tab is shown.
//
// The shown tab is a way of looking at the document, like closed toggles
// (lib/toggle-view.ts): plugin state, not part of the document. Switching
// tabs is a transaction without a document change – nothing is synced or
// saved, no version is made – and others editing at the same time keep
// their own tab. Hidden tabs get a class through decorations; exports,
// print and published pages show every tab one after another with its
// title (lib/tabs-block.ts renders them so). The tab shown is remembered
// per person and device by the block id (lib/tabs-memory.ts).
//
// The strip is no part of ProseMirror's DOM (stopEvent, ignoreMutation):
// tabs with role="tab" in a role="tablist", ← → Home End to switch, F2 or a
// double click to rename, ⌘⇧← ⌘⇧→ (Ctrl+Shift on other systems) or
// dragging to reorder, Delete to delete (with an undo offer); "+" adds a
// tab, "⋯" opens the same actions as a menu (for phones).
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "@tiptap/pm/view";
import { undo as yUndo, yUndoPluginKey } from "@tiptap/y-tiptap";
import { tr } from "./locale-tag";
import { validBlockId } from "./block-ids";
import { browserStorage, readActiveTabs, writeActiveTabs } from "./tabs-memory";
import { addTab, deleteTab, moveTab, renameTab, tabsOf } from "./tabs-commands";

type TabsState = {
  active: ReadonlyMap<string, number>;
  hasTabs: boolean;
  decorations: DecorationSet;
};
type TabsMeta = { select: number; index: number } | { rebuild: true };
export const tabsKey = new PluginKey<TabsState>("tabsBlocks");

// How a tabs block is known: its block id, or its position ("@12").
export const tabsIdentity = (node: PMNode, pos: number) => validBlockId(node.attrs.blockId) || `@${pos}`;

// The number of the tab shown in the tabs block at `pos`.
export function activeTab(state: EditorState, pos: number): number {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "tabs") return 0;
  const value = tabsKey.getState(state);
  return clampIndex(value?.active.get(tabsIdentity(node, pos)) ?? 0, node);
}
const clampIndex = (index: number, node: PMNode) => Math.max(0, Math.min(index, node.childCount - 1));

// Element ids of a tab and its panel (only for blocks with a block id).
const tabElementId = (blockId: string, index: number) => `tabs-${blockId}-tab-${index}`;
const panelElementId = (blockId: string, index: number) => `tabs-${blockId}-panel-${index}`;

function buildDecorations(doc: PMNode, active: ReadonlyMap<string, number>) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "tabs") return !node.isTextblock && !node.isAtom;
    const shown = clampIndex(active.get(tabsIdentity(node, pos)) ?? 0, node);
    const id = validBlockId(node.attrs.blockId);
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {}, { tabsActive: shown }));
    node.forEach((tab, offset, index) => {
      const from = pos + 1 + offset;
      decorations.push(
        Decoration.node(from, from + tab.nodeSize, {
          class: index === shown ? "editor-tab-active" : "editor-tab-hidden",
          role: "tabpanel",
          ...(id ? { id: panelElementId(id, index), "aria-labelledby": tabElementId(id, index) } : {}),
        }),
      );
    });
    // Nested tabs are found inside.
    return true;
  });
  return { decorations: DecorationSet.create(doc, decorations), hasTabs: decorations.length > 0 };
}

// Positional identities follow their block through changes.
function mapActive(active: ReadonlyMap<string, number>, trn: Transaction) {
  if (![...active.keys()].some((id) => id.startsWith("@"))) return active;
  const next = new Map<string, number>();
  for (const [id, index] of active) {
    if (!id.startsWith("@")) next.set(id, index);
    else {
      const result = trn.mapping.mapResult(Number(id.slice(1)), 1);
      if (result.deleted) continue;
      const node = trn.doc.nodeAt(result.pos);
      next.set(node?.type.name === "tabs" ? tabsIdentity(node, result.pos) : `@${result.pos}`, index);
    }
  }
  return next;
}

// Whether a transaction's steps bring tabs blocks in (paste, moves).
function stepsWithTabs(trn: Transaction) {
  return trn.steps.some((step) => {
    const slice = (step as unknown as { slice?: { content: { descendants: (f: (n: PMNode) => boolean | void) => void } } }).slice;
    if (!slice) return false;
    let found = false;
    slice.content.descendants((node) => {
      if (node.type.name === "tabs" || node.type.name === "tab") found = true;
      return !found;
    });
    return found;
  });
}

// The tab around a position, innermost first: the tabs block and the
// number of the tab.
function tabsAround(doc: PMNode, pos: number) {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const out: { pos: number; node: PMNode; index: number }[] = [];
  for (let d = $pos.depth; d > 1; d--)
    if ($pos.node(d).type.name === "tab" && $pos.node(d - 1).type.name === "tabs")
      out.push({ pos: $pos.before(d - 1), node: $pos.node(d - 1), index: $pos.index(d - 1) });
  return out;
}

export function tabsBlocksPlugin({ storageKey = null }: { storageKey?: string | null } = {}) {
  return new Plugin<TabsState>({
    key: tabsKey,
    state: {
      init: (_config, state) => {
        const active = storageKey ? readActiveTabs(browserStorage(), storageKey) : new Map<string, number>();
        return { active, ...buildDecorations(state.doc, active) };
      },
      apply: (trn, value, _old, state) => {
        let active = trn.docChanged ? mapActive(value.active, trn) : value.active;
        const meta = trn.getMeta(tabsKey) as TabsMeta | undefined;
        const sync = trn.getMeta("y-sync$") as { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean } | undefined;
        const remote = !!sync?.isChangeOrigin;
        if (meta && "select" in meta) {
          const node = trn.doc.nodeAt(meta.select);
          if (node?.type.name === "tabs") {
            const next = new Map(active);
            next.set(tabsIdentity(node, meta.select), clampIndex(meta.index, node));
            active = next;
          }
        }
        // The caret getting into a hidden tab (a jump to a block, a search
        // hit, undo) shows that tab. Not for others' changes.
        if (trn.selectionSet && !meta && (!remote || sync?.isUndoRedoOperation)) {
          for (const around of tabsAround(trn.doc, state.selection.head)) {
            const id = tabsIdentity(around.node, around.pos);
            if (clampIndex(active.get(id) ?? 0, around.node) === around.index) continue;
            const next = new Map(active);
            next.set(id, around.index);
            active = next;
          }
        }
        const rebuild =
          active !== value.active || !!meta || (trn.docChanged && (value.hasTabs || remote || stepsWithTabs(trn)));
        if (!rebuild) return trn.docChanged && value.hasTabs ? { ...value, active, decorations: value.decorations.map(trn.mapping, trn.doc) } : active === value.active ? value : { ...value, active };
        return { active, ...buildDecorations(trn.doc, active) };
      },
    },
    props: {
      decorations: (state) => tabsKey.getState(state)?.decorations,
    },
    view: (initial) => {
      let saved = tabsKey.getState(initial.state)?.active;
      return {
        update: (view) => {
          const value = tabsKey.getState(view.state);
          if (!value || !storageKey || value.active === saved) return;
          saved = value.active;
          writeActiveTabs(
            browserStorage(),
            storageKey,
            new Map([...value.active].filter(([id]) => !id.startsWith("@"))),
          );
        },
      };
    },
  });
}

// Shows the tab `index` of the tabs block at `pos`. When the caret is in
// that block, it goes into the tab shown.
export function showTab(view: EditorView, pos: number, index: number) {
  const trn = view.state.tr.setMeta(tabsKey, { select: pos, index } satisfies TabsMeta);
  const node = view.state.doc.nodeAt(pos);
  const { from } = view.state.selection;
  if (node && from > pos && from < pos + node.nodeSize) {
    const tab = tabsOf(view.state.doc, pos)[index];
    const target = tab && Selection.findFrom(view.state.doc.resolve(tab.pos + 1), 1, true);
    if (tab && target && target.from < tab.pos + tab.node.nodeSize) trn.setSelection(target);
  }
  view.dispatch(trn.setMeta("addToHistory", false));
}

const PLUS =
  '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8h-80v80a8 8 0 0 1-16 0v-80H40a8 8 0 0 1 0-16h80V40a8 8 0 0 1 16 0v80h80a8 8 0 0 1 8 8Z"/></svg>';
const DOTS =
  '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M140 128a12 12 0 1 1-12-12 12 12 0 0 1 12 12Zm56-12a12 12 0 1 0 12 12 12 12 0 0 0-12-12Zm-136 0a12 12 0 1 0 12 12 12 12 0 0 0-12-12Z"/></svg>';

const SKIPPED_ATTRIBUTES = new Set(["class"]);
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type TabsViewOptions = {
  // A tab was deleted: offer to take it back (components/toast.tsx).
  onTabDeleted?: ((title: string, undo: () => void) => void) | null;
};

export function tabsNodeView({
  node: initial,
  view,
  getPos,
  decorations,
  attributesOf,
  options = {},
}: {
  node: PMNode;
  view: EditorView;
  getPos: () => number | undefined;
  decorations: readonly Decoration[];
  attributesOf: (node: PMNode) => Record<string, unknown>;
  options?: TabsViewOptions;
}): NodeView {
  let node = initial;
  const dom = document.createElement("div");
  dom.className = "editor-tabs";
  let applied = new Map<string, string>();
  const applyAttributes = () => {
    const next = new Map<string, string>();
    for (const [name, value] of Object.entries(attributesOf(node)))
      if (!SKIPPED_ATTRIBUTES.has(name) && value !== null && value !== undefined && value !== false) next.set(name, String(value));
    for (const name of applied.keys()) if (!next.has(name)) dom.removeAttribute(name);
    for (const [name, value] of next) if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
    applied = next;
  };
  applyAttributes();
  const strip = document.createElement("div");
  strip.className = "tabs-strip";
  strip.contentEditable = "false";
  const list = document.createElement("div");
  list.className = "tabs-list";
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", tr("Tabs", "Tabs"));
  list.setAttribute("aria-orientation", "horizontal");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "tabs-add";
  add.innerHTML = PLUS;
  add.setAttribute("aria-label", tr("Tab hinzufügen", "Add tab"));
  add.title = tr("Tab hinzufügen", "Add tab");
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tabs-more";
  more.innerHTML = DOTS;
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", tr("Tab-Aktionen", "Tab actions"));
  more.title = tr("Tab-Aktionen", "Tab actions");
  strip.append(list, add, more);
  const panels = document.createElement("div");
  panels.className = "tabs-panels";
  dom.append(strip, panels);

  const shownIn = (decos: readonly Decoration[]) => {
    for (const d of decos) {
      const spec = (d as Decoration & { spec: { tabsActive?: number } }).spec;
      if (typeof spec?.tabsActive === "number") return spec.tabsActive;
    }
    return 0;
  };
  let active = clampIndex(shownIn(decorations), node);
  let renaming: number | null = null;
  let renderedKey = "";
  let menu: HTMLElement | null = null;
  const editable = () => view.editable;
  const titles = () => {
    const out: string[] = [];
    node.forEach((tab) => out.push(String(tab.attrs.title ?? "")));
    return out;
  };
  const buttons = () => Array.from(list.querySelectorAll<HTMLButtonElement>(":scope > [role=tab]"));
  const pos = () => getPos();

  function render(force = false) {
    const names = titles();
    const key = JSON.stringify([names, active, editable(), validBlockId(node.attrs.blockId)]);
    if (!force && key === renderedKey) return;
    if (renaming !== null && renaming >= names.length) renaming = null;
    if (renaming !== null && !force) return;
    renderedKey = key;
    const focused = list.contains(document.activeElement) && document.activeElement?.getAttribute("role") === "tab";
    const id = validBlockId(node.attrs.blockId);
    const made = names.map((title, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tabs-tab" + (index === active ? " active" : "");
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", index === active ? "true" : "false");
      button.tabIndex = index === active ? 0 : -1;
      button.dataset.index = String(index);
      if (id) {
        button.id = tabElementId(id, index);
        button.setAttribute("aria-controls", panelElementId(id, index));
      }
      const label = document.createElement("span");
      label.className = "tabs-tab-label";
      label.textContent = title || tr("Ohne Titel", "Untitled");
      if (!title) label.classList.add("untitled");
      button.append(label);
      return button;
    });
    list.replaceChildren(...made);
    const canEdit = editable();
    add.hidden = !canEdit || names.length >= 30;
    more.hidden = !canEdit;
    if (!canEdit) closeMenu(false);
    const current = made[active];
    if (current) {
      // The tab shown stays in sight in a long strip (phones).
      if (current.offsetLeft < list.scrollLeft) list.scrollLeft = current.offsetLeft;
      else if (current.offsetLeft + current.offsetWidth > list.scrollLeft + list.clientWidth)
        list.scrollLeft = current.offsetLeft + current.offsetWidth - list.clientWidth;
      if (focused) current.focus({ preventScroll: true });
    }
  }

  const select = (index: number, focus = false) => {
    const at = pos();
    if (typeof at !== "number") return;
    const target = clampIndex(index, node);
    if (target !== active) showTab(view, at, target);
    if (focus) buttons()[target]?.focus({ preventScroll: true });
  };
  const stopCapturing = () => yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
  const change = (make: (trn: Transaction, at: number) => boolean | number | null, after?: (trn: Transaction, result: number | boolean | null) => void) => {
    const at = pos();
    if (typeof at !== "number" || !editable()) return false;
    const trn = view.state.tr;
    const result = make(trn, at);
    if (result === false || result === null) return false;
    after?.(trn, result);
    stopCapturing();
    view.dispatch(trn);
    stopCapturing();
    return true;
  };
  const move = (from: number, to: number) => {
    const target = clampIndex(to, node);
    change(
      (trn, at) => moveTab(trn, at, from, target),
      (trn) => {
        // The tab shown stays shown, wherever it went.
        const shown = active === from ? target : from < active && target >= active ? active - 1 : from > active && target <= active ? active + 1 : active;
        trn.setMeta(tabsKey, { select: pos()!, index: shown } satisfies TabsMeta);
      },
    );
    buttons()[active]?.focus({ preventScroll: true });
  };
  const remove = (index: number) => {
    const title = titles()[index] || tr("Ohne Titel", "Untitled");
    const done = change(
      (trn, at) => deleteTab(trn, at, index),
      (trn) => {
        const at = pos()!;
        const shown = index < active ? active - 1 : index === active ? Math.min(index, node.childCount - 2) : active;
        trn.setMeta(tabsKey, { select: at, index: Math.max(0, shown) } satisfies TabsMeta);
      },
    );
    if (!done) return;
    buttons()[active]?.focus({ preventScroll: true });
    options.onTabDeleted?.(title, () => {
      if (view.isDestroyed) return;
      if (yUndoPluginKey.getState(view.state)) yUndo(view.state);
    });
  };
  const addOne = () => {
    let index: number | null = null;
    change(
      (trn, at) => (index = addTab(trn, at, tr(`Tab ${node.childCount + 1}`, `Tab ${node.childCount + 1}`))),
      (trn, result) => trn.setMeta(tabsKey, { select: pos()!, index: Number(result) } satisfies TabsMeta),
    );
    if (index !== null) startRename(index);
  };

  // Renaming in place: a field over the tab.
  function startRename(index: number) {
    if (!editable()) return;
    closeMenu(false);
    const button = buttons()[index];
    if (!button) return;
    renaming = index;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tabs-rename";
    input.maxLength = 200;
    input.value = titles()[index] || "";
    input.setAttribute("aria-label", tr("Name des Tabs", "Tab name"));
    input.size = Math.max(6, Math.min(30, input.value.length + 1));
    button.hidden = true;
    button.after(input);
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      const value = input.value;
      renaming = null;
      if (save) {
        const at = pos();
        if (typeof at === "number" && editable()) {
          const trn = view.state.tr;
          if (renameTab(trn, at, index, value)) view.dispatch(trn);
        }
      }
      input.remove();
      render(true);
      buttons()[index]?.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("input", () => (input.size = Math.max(6, Math.min(30, input.value.length + 1))));
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  // The actions as a menu (phones, and for everyone who looks for them).
  function closeMenu(refocus = true) {
    if (!menu) return;
    menu.remove();
    menu = null;
    more.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) more.focus({ preventScroll: true });
  }
  function outside(e: Event) {
    if (menu && !menu.contains(e.target as globalThis.Node) && e.target !== more && !more.contains(e.target as globalThis.Node)) closeMenu(false);
  }
  function openMenu() {
    if (menu) return closeMenu();
    const count = node.childCount;
    const index = active;
    const items: { label: string; run: () => void; disabled?: boolean; danger?: boolean }[] = [
      { label: tr("Umbenennen", "Rename"), run: () => startRename(index) },
      { label: tr("Nach links verschieben", "Move left"), run: () => move(index, index - 1), disabled: index === 0 },
      { label: tr("Nach rechts verschieben", "Move right"), run: () => move(index, index + 1), disabled: index >= count - 1 },
      { label: tr("Tab löschen", "Delete tab"), run: () => remove(index), disabled: count < 2, danger: true },
    ];
    menu = document.createElement("div");
    menu.className = "tabs-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", tr("Tab-Aktionen", "Tab actions"));
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      if (item.danger) button.classList.add("danger");
      if (item.disabled) button.setAttribute("aria-disabled", "true");
      button.tabIndex = -1;
      button.addEventListener("click", (e) => {
        e.preventDefault();
        if (item.disabled) return;
        closeMenu(false);
        item.run();
      });
      menu.append(button);
    }
    menu.addEventListener("keydown", (e) => {
      const entries = Array.from(menu!.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
      const at = entries.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        entries[(at + (e.key === "ArrowDown" ? 1 : entries.length - 1)) % entries.length]?.focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        entries[e.key === "Home" ? 0 : entries.length - 1]?.focus();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        closeMenu();
      }
    });
    strip.append(menu);
    more.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside, true);
    (menu.querySelector<HTMLButtonElement>("[role=menuitem]:not([aria-disabled])") || menu.querySelector("button"))?.focus();
  }

  // The caret into the tab's content.
  const enterContent = (index: number) => {
    const at = pos();
    if (typeof at !== "number") return;
    select(index);
    const tab = tabsOf(view.state.doc, at)[index];
    if (!tab) return;
    const target = Selection.findFrom(view.state.doc.resolve(tab.pos + 1), 1, true);
    view.focus();
    if (target && target.from < tab.pos + tab.node.nodeSize) view.dispatch(view.state.tr.setSelection(target).scrollIntoView());
  };

  // Mouse and keyboard on the tabs.
  let dragged: { index: number; x: number; id: number; moving: boolean; target: number } | null = null;
  let suppressClick = false;
  const tabIndexOf = (target: EventTarget | null) => {
    const button = (target as HTMLElement | null)?.closest?.<HTMLElement>("[role=tab]");
    return button && list.contains(button) ? Number(button.dataset.index) : null;
  };
  list.addEventListener("click", (e) => {
    const index = tabIndexOf(e.target);
    if (index === null) return;
    e.preventDefault();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    select(index, true);
  });
  list.addEventListener("dblclick", (e) => {
    const index = tabIndexOf(e.target);
    if (index === null || !editable()) return;
    e.preventDefault();
    startRename(index);
  });
  list.addEventListener("keydown", (e) => {
    const index = tabIndexOf(e.target);
    if (index === null) return;
    const count = node.childCount;
    const rtl = getComputedStyle(dom).direction === "rtl";
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    const next = e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    if (next && mod && e.shiftKey) {
      e.preventDefault();
      if (editable()) move(index, index + next);
      return;
    }
    if (next && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      select((index + next + count) % count, true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      select(e.key === "Home" ? 0 : count - 1, true);
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename(index);
    } else if ((e.key === "Delete" || e.key === "Backspace") && editable()) {
      e.preventDefault();
      remove(index);
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      enterContent(index);
    } else if (e.key === " ") {
      e.preventDefault();
      select(index, true);
    }
  });
  // Reordering by dragging (mouse and pen; on touch the strip scrolls,
  // the menu moves tabs).
  const clearDrop = () => list.querySelectorAll(".drop-before, .drop-after, .dragging").forEach((el) => el.classList.remove("drop-before", "drop-after", "dragging"));
  list.addEventListener("pointerdown", (e) => {
    const index = tabIndexOf(e.target);
    if (index === null || e.button !== 0 || e.pointerType === "touch" || !editable() || renaming !== null) return;
    dragged = { index, x: e.clientX, id: e.pointerId, moving: false, target: index };
  });
  const onMove = (e: PointerEvent) => {
    if (!dragged || e.pointerId !== dragged.id) return;
    if (!dragged.moving && Math.abs(e.clientX - dragged.x) < 6) return;
    dragged.moving = true;
    const all = buttons();
    // The slot between tabs the pointer is over.
    let slot = all.length;
    for (const [i, button] of all.entries()) {
      const rect = button.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        slot = i;
        break;
      }
    }
    dragged.target = slot > dragged.index ? slot - 1 : slot;
    clearDrop();
    all[dragged.index]?.classList.add("dragging");
    if (slot < all.length) all[slot].classList.add("drop-before");
    else all[all.length - 1]?.classList.add("drop-after");
  };
  const onUp = (e: PointerEvent) => {
    if (!dragged || e.pointerId !== dragged.id) return;
    const { index, target, moving } = dragged;
    dragged = null;
    clearDrop();
    if (!moving) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (target !== index) move(index, target);
  };
  const onCancel = () => {
    dragged = null;
    clearDrop();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  add.addEventListener("mousedown", (e) => e.preventDefault());
  add.addEventListener("click", (e) => {
    e.preventDefault();
    addOne();
  });
  more.addEventListener("click", (e) => {
    e.preventDefault();
    openMenu();
  });

  render(true);

  return {
    dom,
    contentDOM: panels,
    update(next, decos) {
      if (next.type !== node.type) return false;
      const changed = Object.keys({ ...next.attrs, ...node.attrs }).some((k) => next.attrs[k] !== node.attrs[k]);
      node = next;
      if (changed) applyAttributes();
      active = clampIndex(shownIn(decos), node);
      render();
      return true;
    },
    stopEvent: (event) => strip.contains(event.target as globalThis.Node),
    ignoreMutation: (mutation: ViewMutationRecord) => {
      if (strip.contains(mutation.target)) return true;
      return mutation.type === "attributes" && mutation.target === dom;
    },
    destroy() {
      closeMenu(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    },
  };
}
