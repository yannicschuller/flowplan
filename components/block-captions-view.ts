"use client";
// Captions in the editor (lib/block-captions.ts): a line below every image,
// table and code block. With a caption it is a field to type in; without,
// "Add caption" appears while the block is pointed at or selected. The
// field writes the block's `caption` attribute as it is typed (so it is
// shared live and undone with the document); Enter or ↓ go on below the
// block, Escape or ↑ back into it, and an empty caption goes away when the
// field is left. Read-only editors show the text only.
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CAPTION_KINDS, MAX_CAPTION, captionInput, captionLabel, captionText, type CaptionKind } from "@/lib/block-captions";
import { tr } from "@/lib/locale-tag";

type CaptionState = { decorations: DecorationSet; numbers: Map<number, { kind: CaptionKind; number: number }> };
export const captionKey = new PluginKey<CaptionState>("blockCaptions");

type Slot = HTMLDivElement & {
  captionView?: EditorView;
  captionPos?: () => number | undefined;
  parts?: { add: HTMLButtonElement; label: HTMLSpanElement; field: HTMLTextAreaElement; text: HTMLSpanElement };
};

// One walk through the document: a slot after every block that can have a
// caption, and the numbers of those that have one (as captionNumbers()).
function build(doc: PMNode): CaptionState {
  const widgets: Decoration[] = [];
  const numbers: CaptionState["numbers"] = new Map();
  const counts: Record<CaptionKind, number> = { figure: 0, table: 0, listing: 0 };
  doc.descendants((node, pos) => {
    const kind = CAPTION_KINDS[node.type.name];
    if (kind && captionText(node.attrs.caption)) numbers.set(pos, { kind, number: ++counts[kind] });
    if (kind)
      widgets.push(
        Decoration.widget(pos + node.nodeSize, slotDom, {
          side: -1,
          // One key for all: the field stays (and keeps the focus) while
          // its caption changes; sync() fills it in after every change.
          key: "block-caption",
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    return !node.isTextblock;
  });
  return { decorations: DecorationSet.create(doc, widgets), numbers };
}

// The block a slot belongs to: the node right before it.
function blockOf(slot: Slot, state: EditorState) {
  const at = slot.captionPos?.();
  if (at === undefined || at > state.doc.content.size) return null;
  const node = state.doc.resolve(at).nodeBefore;
  return node && CAPTION_KINDS[node.type.name] ? { node, pos: at - node.nodeSize } : null;
}
const slotsOf = (view: EditorView) =>
  Array.from(view.dom.querySelectorAll<Slot>(".block-caption")).filter((slot) => slot.captionView === view);

function setCaption(view: EditorView, pos: number, caption: string | null) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !CAPTION_KINDS[node.type.name] || node.attrs.caption === caption) return;
  view.dispatch(view.state.tr.setNodeAttribute(pos, "caption", caption));
}
// The field keeps what was typed; leaving it tidies up (spaces, nothing left).
function commit(view: EditorView, slot: Slot) {
  const block = blockOf(slot, view.state);
  if (!block || block.node.attrs.caption === null) return;
  setCaption(view, block.pos, captionText(block.node.attrs.caption) || null);
}
// Back into the block (Escape, ↑) or on below it (Enter, ↓).
function leave(view: EditorView, slot: Slot, where: "block" | "after") {
  commit(view, slot);
  const block = blockOf(slot, view.state);
  if (!block) return view.focus();
  const { node, pos } = block;
  let tr = view.state.tr;
  if (where === "block")
    tr.setSelection(
      node.type.name === "image" ? NodeSelection.create(tr.doc, pos) : Selection.near(tr.doc.resolve(pos + node.nodeSize - 1), -1),
    );
  else {
    const after = pos + node.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) {
      const paragraph = view.state.schema.nodes.paragraph?.create();
      if (paragraph) tr = tr.insert(after, paragraph);
    }
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(after + 1, tr.doc.content.size)), 1));
  }
  view.focus();
  view.dispatch(tr.scrollIntoView());
}
// Opens the caption of the block at `pos` for typing (the add button, the
// block menu).
export function editCaption(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || !CAPTION_KINDS[node.type.name] || !view.editable) return;
  if (node.attrs.caption === null) setCaption(view, pos, "");
  const end = pos + view.state.doc.nodeAt(pos)!.nodeSize;
  const slot = slotsOf(view).find((s) => s.captionPos?.() === end);
  const field = slot?.parts?.field;
  if (!field) return;
  field.focus({ preventScroll: true });
  field.setSelectionRange(field.value.length, field.value.length);
  field.scrollIntoView({ block: "nearest" });
}

const fit = (field: HTMLTextAreaElement) => {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
};
const lineHeight = (field: HTMLTextAreaElement) => parseFloat(getComputedStyle(field).lineHeight) || 20;

function slotDom(view: EditorView, getPos: () => number | undefined) {
  const slot = document.createElement("div") as Slot;
  slot.className = "block-caption";
  slot.captionView = view;
  slot.captionPos = getPos;
  const add = document.createElement("button");
  add.type = "button";
  add.className = "block-caption-add";
  add.textContent = tr("Beschriftung hinzufügen", "Add caption");
  // The editor keeps its selection until the field takes over.
  add.addEventListener("mousedown", (event) => event.preventDefault());
  add.addEventListener("click", () => {
    const block = blockOf(slot, view.state);
    if (block) editCaption(view, block.pos);
  });
  const label = document.createElement("span");
  label.className = "block-caption-label";
  const field = document.createElement("textarea");
  field.className = "block-caption-field";
  field.rows = 1;
  field.maxLength = MAX_CAPTION;
  field.spellcheck = true;
  field.placeholder = tr("Beschriftung …", "Caption …");
  field.setAttribute("aria-label", tr("Beschriftung", "Caption"));
  field.addEventListener("input", () => {
    const block = blockOf(slot, view.state);
    const value = captionInput(field.value);
    if (value !== field.value) field.value = value;
    fit(field);
    if (block) setCaption(view, block.pos, value);
  });
  field.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const { selectionStart: start, selectionEnd: end, value } = field;
    const oneLine = field.scrollHeight < lineHeight(field) * 1.8;
    if (event.key === "Enter" || (event.key === "ArrowDown" && start === end && (oneLine || end === value.length))) {
      event.preventDefault();
      event.stopPropagation();
      leave(view, slot, "after");
    } else if (event.key === "Escape" || (event.key === "ArrowUp" && start === end && (oneLine || start === 0))) {
      event.preventDefault();
      event.stopPropagation();
      leave(view, slot, "block");
    } else if (event.key === "Backspace" && !value) {
      // Backspace in an empty caption removes it.
      event.preventDefault();
      leave(view, slot, "block");
    }
  });
  field.addEventListener("blur", () => {
    commit(view, slot);
    // Its look follows the caption again (an empty one is gone).
    sync(view);
  });
  const text = document.createElement("span");
  text.className = "block-caption-text";
  slot.parts = { add, label, field, text };
  slot.append(add, label, field, text);
  fill(slot, view, null, false);
  return slot;
}

// Fills a slot from its block: the add button, the field or the text.
function fill(slot: Slot, view: EditorView, active: number | null, numbered: boolean) {
  const parts = slot.parts;
  const block = blockOf(slot, view.state);
  if (!parts) return;
  if (!block) {
    slot.dataset.state = "none";
    return;
  }
  const { node, pos } = block;
  const raw: string | null = typeof node.attrs.caption === "string" ? node.attrs.caption : null;
  const editable = view.editable;
  const focused = document.activeElement === parts.field;
  const state = editable ? (raw !== null || focused ? "edit" : "add") : captionText(raw) ? "text" : "none";
  slot.dataset.state = state;
  slot.dataset.kind = CAPTION_KINDS[node.type.name];
  if (active === pos) slot.dataset.active = "";
  else delete slot.dataset.active;
  const number = numbered ? captionKey.getState(view.state)?.numbers.get(pos) : undefined;
  const label = number ? `${captionLabel(number.kind, number.number, tr)}:` : "";
  if (parts.label.textContent !== label) parts.label.textContent = label;
  parts.label.hidden = !label;
  parts.add.hidden = state !== "add";
  parts.field.hidden = state !== "edit";
  parts.text.hidden = state !== "text";
  if (state === "edit" && !focused && parts.field.value !== (raw || "")) {
    parts.field.value = raw || "";
    fit(parts.field);
  }
  if (state === "text") parts.text.textContent = captionText(raw);
}

// The block the selection is in (or on): its caption's add button shows.
function activeBlock(state: EditorState) {
  const { selection } = state;
  if (selection instanceof NodeSelection && CAPTION_KINDS[selection.node.type.name]) return selection.from;
  const $from = selection.$from;
  for (let depth = $from.depth; depth > 0; depth--)
    if (CAPTION_KINDS[$from.node(depth).type.name]) return $from.before(depth);
  return null;
}

const numberedOf = new WeakMap<EditorView, () => boolean>();
function sync(view: EditorView) {
  const numbered = numberedOf.get(view)?.() ?? false;
  const active = activeBlock(view.state);
  for (const slot of slotsOf(view)) fill(slot, view, active, numbered);
}

// Refreshes the captions after the page's numbering switch changed.
export const refreshCaptions = (view: EditorView) => view.dispatch(view.state.tr.setMeta(captionKey, true));

export const BlockCaptions = Extension.create<{ numbered: () => boolean }>({
  name: "blockCaptions",
  addOptions: () => ({ numbered: () => false }),
  addProseMirrorPlugins() {
    const numbered = () => this.options.numbered();
    return [
      new Plugin<CaptionState>({
        key: captionKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, value) => (tr.docChanged || tr.getMeta(captionKey) ? build(tr.doc) : value),
        },
        props: { decorations: (state) => captionKey.getState(state)?.decorations },
        view(view) {
          numberedOf.set(view, numbered);
          queueMicrotask(() => !view.isDestroyed && sync(view));
          return {
            update: (current) => sync(current),
            destroy: () => {
              numberedOf.delete(view);
            },
          };
        },
      }),
    ];
  },
});
