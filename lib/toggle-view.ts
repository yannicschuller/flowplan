// Toggle blocks in the editor (#137): the arrow opens and closes the block,
// the title is edited in place.
//
// Without a node view of its own a toggle was drawn from the schema
// (`<details open>`): the browser's own opening and closing changed the
// `open` attribute, ProseMirror took that for a foreign change of its DOM
// and drew the node again – open. Here the arrow is a button of its own, the
// summary is no part of ProseMirror's DOM (stopEvent, ignoreMutation) and
// whether a toggle is open is plugin state.
//
// Open or closed is a way of looking at the document, like folded headings
// (#71, lib/heading-folds.ts): it is not stored in the document, so others
// editing at the same time, exports and published pages are not affected
// (they show toggles as before). A toggle is known by its block id (it
// travels with the block through moves and Yjs), by its position without
// one. What is closed opens again when the caret gets into it.
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "@tiptap/pm/view";
import { tr } from "./locale-tag";

type ToggleState = { closed: ReadonlySet<string>; focusTitle: number | null; decorations: DecorationSet };
type ToggleMeta = { toggle: number; focusTitle?: boolean } | { open: number[] };
export const toggleKey = new PluginKey<ToggleState>("toggleBlocks");

// How a toggle is known: its block id, or its position ("@12").
export const toggleIdentity = (node: PMNode, pos: number) =>
  typeof node.attrs.blockId === "string" && node.attrs.blockId ? node.attrs.blockId : `@${pos}`;

// The toggles around a position (innermost last) whose content holds it.
export function togglesAround(doc: PMNode, pos: number): { node: PMNode; pos: number }[] {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  const out: { node: PMNode; pos: number }[] = [];
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d);
    if (node.type.name === "toggle") out.push({ node, pos: $pos.before(d) });
  }
  return out;
}

function buildDecorations(doc: PMNode, closed: ReadonlySet<string>) {
  if (!closed.size) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "toggle" && closed.has(toggleIdentity(node, pos)))
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "toggle-closed" }, { toggleClosed: true }));
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
}

export function isToggleClosed(state: EditorState, pos: number) {
  const node = state.doc.nodeAt(pos);
  const value = toggleKey.getState(state);
  return !!node && node.type.name === "toggle" && !!value?.closed.has(toggleIdentity(node, pos));
}
export function toggleOpen(view: EditorView, pos: number, focusTitle = false) {
  view.dispatch(view.state.tr.setMeta(toggleKey, { toggle: pos, focusTitle } satisfies ToggleMeta));
}
export function openToggles(view: EditorView, positions: number[]) {
  view.dispatch(view.state.tr.setMeta(toggleKey, { open: positions } satisfies ToggleMeta));
}

// Positional identities follow their toggle through changes.
function mapClosed(closed: ReadonlySet<string>, trn: Transaction) {
  if (![...closed].some((id) => id.startsWith("@"))) return closed;
  const next = new Set<string>();
  for (const id of closed) {
    if (!id.startsWith("@")) next.add(id);
    else {
      const result = trn.mapping.mapResult(Number(id.slice(1)), 1);
      if (!result.deleted) next.add(`@${result.pos}`);
    }
  }
  return next;
}

export function toggleBlocksPlugin() {
  return new Plugin<ToggleState>({
    key: toggleKey,
    state: {
      init: () => ({ closed: new Set(), focusTitle: null, decorations: DecorationSet.empty }),
      apply: (trn, value, _old, state) => {
        let closed = trn.docChanged ? mapClosed(value.closed, trn) : value.closed;
        // Kept through the transaction appended right after (the caret
        // leaving), so the view sees it.
        let focusTitle: number | null =
          trn.getMeta("appendedTransaction") && value.focusTitle !== null ? trn.mapping.map(value.focusTitle) : null;
        const meta = trn.getMeta(toggleKey) as ToggleMeta | undefined;
        if (meta && "toggle" in meta) {
          const node = trn.doc.nodeAt(meta.toggle);
          if (node?.type.name === "toggle") {
            const id = toggleIdentity(node, meta.toggle);
            const next = new Set(closed);
            if (next.has(id)) next.delete(id);
            else {
              next.add(id);
              if (meta.focusTitle) focusTitle = meta.toggle;
            }
            closed = next;
          }
        } else if (meta && "open" in meta) {
          const next = new Set(closed);
          for (const pos of meta.open) {
            const node = trn.doc.nodeAt(pos);
            if (node?.type.name === "toggle") next.delete(toggleIdentity(node, pos));
          }
          closed = next;
        }
        // The caret never stays in a closed toggle: what it got into opens.
        if (trn.selectionSet && !meta && closed.size) {
          const sel = state.selection;
          const around = [sel.from, sel.to].flatMap((pos) => togglesAround(trn.doc, pos)).filter(({ node, pos }) => {
            // A selected toggle itself is not inside it.
            return !(sel.from <= pos && sel.to >= pos + node.nodeSize);
          });
          const ids = around.map(({ node, pos }) => toggleIdentity(node, pos)).filter((id) => closed.has(id));
          if (ids.length) {
            const next = new Set(closed);
            for (const id of ids) next.delete(id);
            closed = next;
          }
        }
        if (closed === value.closed && !trn.docChanged && focusTitle === value.focusTitle) return value;
        return {
          closed,
          focusTitle,
          decorations:
            closed === value.closed && trn.docChanged
              ? value.decorations.map(trn.mapping, trn.doc)
              : closed === value.closed
                ? value.decorations
                : buildDecorations(trn.doc, closed),
        };
      },
    },
    // Closing moves the caret out of what is now hidden: before the toggle
    // (or after it, when nothing comes before).
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((t) => t.getMeta(toggleKey))) return null;
      const value = toggleKey.getState(state);
      if (!value?.closed.size) return null;
      const { from, to } = state.selection;
      const hidden = [...togglesAround(state.doc, from), ...togglesAround(state.doc, to)].find(
        ({ node, pos }) => value.closed.has(toggleIdentity(node, pos)) && !(from <= pos && to >= pos + node.nodeSize),
      );
      if (!hidden) return null;
      const outer = togglesAround(state.doc, hidden.pos).find(({ node, pos }) => value.closed.has(toggleIdentity(node, pos))) || hidden;
      const before = Selection.findFrom(state.doc.resolve(outer.pos), -1, true);
      const after = Selection.findFrom(state.doc.resolve(outer.pos + outer.node.nodeSize), 1, true);
      const target = before || after;
      if (!target) return null;
      return state.tr.setSelection(target).setMeta("addToHistory", false);
    },
    props: {
      decorations: (state) => toggleKey.getState(state)?.decorations,
    },
    view: () => {
      let handled: ToggleState | undefined;
      return {
      // Closed by keyboard from inside: the caret goes to the title.
      update: (view) => {
        const value = toggleKey.getState(view.state);
        if (!value || value === handled) return;
        handled = value;
        const pos = value.focusTitle;
        if (typeof pos !== "number") return;
        const dom = view.nodeDOM(pos);
        const title = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(":scope > summary .toggle-title") : null;
        if (title) focusEnd(title);
      },
      };
    },
  });
}

function focusEnd(el: HTMLElement) {
  el.focus({ preventScroll: true });
  const selection = el.ownerDocument.getSelection();
  if (!selection) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// The caret at the start of the toggle's content (opening it).
function enterContent(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const target = Selection.findFrom(view.state.doc.resolve(pos + 1), 1, true);
  const trn = view.state.tr;
  if (target && target.from < pos + node.nodeSize) trn.setSelection(target);
  view.focus();
  view.dispatch(trn.scrollIntoView());
}

// Whether the caret is at the very start of a toggle's content: there,
// ↑ and ← go to its title.
export function titleAbove(state: EditorState): number | null {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection) || sel.$from.parentOffset !== 0) return null;
  const around = togglesAround(state.doc, sel.from);
  const inner = around[around.length - 1];
  if (!inner) return null;
  const first = Selection.findFrom(state.doc.resolve(inner.pos + 1), 1, true);
  return first && first.from === sel.from ? inner.pos : null;
}
export function focusToggleTitle(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos);
  const title = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(":scope > summary .toggle-title") : null;
  if (!title?.isContentEditable) return false;
  focusEnd(title);
  return true;
}

const CARET =
  '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M181.66 133.66l-80 80a8 8 0 0 1-11.32-11.32L164.69 128 90.34 53.66a8 8 0 0 1 11.32-11.32l80 80a8 8 0 0 1 0 11.32Z"/></svg>';

// Not taken from the node's attributes: the title is the summary (not a
// tooltip), open is plugin state, classes come from decorations too.
const SKIPPED_ATTRIBUTES = new Set(["title", "open", "class"]);

export function toggleNodeView({
  node: initial,
  view,
  getPos,
  decorations,
  attributesOf,
}: {
  node: PMNode;
  view: EditorView;
  getPos: () => number | undefined;
  decorations: readonly Decoration[];
  // The node's HTML attributes (block id, direction …).
  attributesOf: (node: PMNode) => Record<string, unknown>;
}): NodeView {
  let node = initial;
  const dom = document.createElement("details");
  dom.className = "toggle-block";
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
  const summary = document.createElement("summary");
  summary.className = "toggle-summary";
  summary.contentEditable = "false";
  const arrow = document.createElement("button");
  arrow.type = "button";
  arrow.className = "toggle-arrow";
  arrow.tabIndex = -1;
  arrow.innerHTML = CARET;
  const title = document.createElement("span");
  title.className = "toggle-title";
  title.spellcheck = true;
  title.setAttribute("role", "textbox");
  title.setAttribute("aria-label", tr("Titel des aufklappbaren Blocks", "Toggle title"));
  title.dataset.placeholder = tr("Titel", "Title");
  title.textContent = String(node.attrs.title ?? "");
  summary.append(arrow, title);
  const content = document.createElement("div");
  dom.append(summary, content);

  let open = true;
  let labelled: boolean | null = null;
  const setOpen = (value: boolean) => {
    open = value;
    if (labelled === value) {
      if (dom.open !== value) dom.open = value;
      return;
    }
    labelled = value;
    if (dom.open !== value) dom.open = value;
    const label = value ? tr("Zuklappen", "Collapse") : tr("Aufklappen", "Expand");
    arrow.setAttribute("aria-expanded", value ? "true" : "false");
    arrow.setAttribute("aria-label", label);
    arrow.title = label;
  };
  const closedIn = (decos: readonly Decoration[]) => decos.some((d) => (d as Decoration & { spec: { toggleClosed?: boolean } }).spec?.toggleClosed);
  setOpen(!closedIn(decorations));
  const editable = () => view.editable;
  // Only when it changes: setting it again blurs a focused title.
  const syncEditable = () => {
    const want = editable();
    if (want === title.isContentEditable) return;
    if (!want) {
      title.contentEditable = "false";
      return;
    }
    try {
      title.contentEditable = "plaintext-only";
    } catch {
      // Browsers without "plaintext-only".
      title.contentEditable = "true";
    }
  };
  syncEditable();

  const flip = (focusTitle = false) => {
    const pos = getPos();
    if (typeof pos === "number") toggleOpen(view, pos, focusTitle);
  };
  // The caret stays where it is; the arrow opens or closes.
  arrow.addEventListener("mousedown", (e) => e.preventDefault());
  arrow.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    flip();
  });
  arrow.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    flip();
  });
  // The summary never opens or closes by itself (the browser's own toggle):
  // the arrow does, and in a read-only document the whole line.
  summary.addEventListener("click", (e) => {
    e.preventDefault();
    if (!editable() && !arrow.contains(e.target as globalThis.Node)) flip();
  });
  // Opened from outside (find in the page, a jump to a block in it).
  dom.addEventListener("toggle", () => {
    if (dom.open === open) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (dom.open) openToggles(view, [pos]);
    else toggleOpen(view, pos);
  });

  const commit = () => {
    const pos = getPos();
    if (typeof pos !== "number" || !editable()) return;
    const text = (title.textContent || "").replace(/\s*\n\s*/g, " ");
    if (text !== title.textContent) title.textContent = text;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "toggle" || current.attrs.title === text) return;
    view.dispatch(view.state.tr.setNodeAttribute(pos, "title", text));
  };
  title.addEventListener("beforeinput", (e) => {
    if (!editable()) e.preventDefault();
  });
  title.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    commit();
  });
  title.addEventListener("compositionend", commit);
  title.addEventListener("blur", () => {
    commit();
    const text = String(node.attrs.title ?? "");
    if (title.textContent !== text) title.textContent = text;
  });
  title.addEventListener("keydown", (e) => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    // ⌘⌥↵ / Ctrl+Alt+Enter: open or close, as inside the toggle.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.altKey) {
      e.preventDefault();
      flip();
      return;
    }
    // Esc: back to the document, the caret where it was.
    if (e.key === "Escape") {
      e.preventDefault();
      commit();
      view.focus();
      return;
    }
    // ↵ or ↓: into the content (opening it).
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "ArrowDown") {
      e.preventDefault();
      commit();
      if (!open) openToggles(view, [pos]);
      enterContent(view, pos);
    }
  });

  return {
    dom,
    contentDOM: content,
    update(next, decos) {
      if (next.type !== node.type) return false;
      // Other attributes (block id, direction …) change in place: a title
      // being edited keeps its focus.
      const changed = Object.keys({ ...next.attrs, ...node.attrs }).some((k) => k !== "title" && next.attrs[k] !== node.attrs[k]);
      node = next;
      if (changed) applyAttributes();
      const text = String(next.attrs.title ?? "");
      if (title.textContent !== text && title.ownerDocument.activeElement !== title) title.textContent = text;
      syncEditable();
      setOpen(!closedIn(decos));
      return true;
    },
    stopEvent: (event) => summary.contains(event.target as globalThis.Node),
    ignoreMutation: (mutation: ViewMutationRecord) => {
      if (mutation.type === "selection") return summary.contains(mutation.target);
      if (summary.contains(mutation.target)) return true;
      return mutation.type === "attributes" && mutation.target === dom;
    },
  };
}
