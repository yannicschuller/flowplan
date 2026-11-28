// The editor's view of the columns block (lib/columns-block.ts): the
// columns in a row, and a handle in every gap between two of them that
// resizes them – dragged, or with the arrow keys; a double click gives equal
// widths again. While dragging, the widths are shown through the columns'
// --column-width (no style attribute is written into the document); the
// new widths become the columns' width attributes when the pointer is let
// go, in one change. The handles are hidden while the columns are stacked
// (narrow panes, phones) and in documents that cannot be changed.
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import { tr } from "./locale-tag";
import { columnShares, resizedWidths, setColumnWidths } from "./columns-block";

type Props = {
  node: PMNode;
  view: EditorView;
  getPos: () => number | undefined;
  attributesOf: (node: PMNode) => Record<string, unknown>;
};
const KEY_STEP = 5;

function applyAttributes(dom: HTMLElement, attributes: Record<string, unknown>, fixed: Record<string, string>, applied: Set<string>) {
  const next = new Map<string, string>(Object.entries(fixed));
  for (const [name, value] of Object.entries(attributes))
    if (name !== "class" && value !== null && value !== undefined && value !== false) next.set(name, String(value));
  for (const name of applied) if (!next.has(name)) dom.removeAttribute(name);
  applied.clear();
  for (const [name, value] of next) {
    if (dom.getAttribute(name) !== value) dom.setAttribute(name, value);
    applied.add(name);
  }
}

export function columnNodeView({ node: initial, attributesOf }: Props): NodeView {
  let node = initial;
  const dom = document.createElement("div");
  dom.className = "editor-column";
  const applied = new Set<string>();
  const apply = () => applyAttributes(dom, attributesOf(node), { "data-column": "true" }, applied);
  apply();
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      apply();
      return true;
    },
    // Its own attributes (the width shown while resizing) are not content.
    ignoreMutation: (mutation: ViewMutationRecord) => mutation.type === "attributes" && mutation.target === dom,
  };
}

export function columnsNodeView({ node: initial, view, getPos, attributesOf }: Props): NodeView {
  let node = initial;
  const dom = document.createElement("div");
  dom.className = "editor-columns";
  const applied = new Set<string>();
  const apply = () => applyAttributes(dom, attributesOf(node), { "data-columns": "true" }, applied);
  apply();
  const row = document.createElement("div");
  row.className = "editor-columns-row";
  const handles = document.createElement("div");
  handles.className = "editor-columns-handles";
  handles.contentEditable = "false";
  dom.append(row, handles);

  const columnsShown = () => Array.from(row.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("editor-column"));
  const rtl = () => getComputedStyle(row).direction === "rtl";
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  // The handles in the middle of each gap.
  function place() {
    const columns = columnsShown();
    const wanted = Math.max(0, columns.length - 1);
    while (handles.children.length > wanted) handles.lastElementChild!.remove();
    while (handles.children.length < wanted) handles.append(handle(handles.children.length));
    const box = dom.getBoundingClientRect();
    const rects = columns.map((c) => c.getBoundingClientRect());
    const stacked = rects.length > 1 && Math.abs(rects[1].top - rects[0].top) > 2;
    dom.toggleAttribute("data-stacked", stacked);
    Array.from(handles.children).forEach((el, i) => {
      const a = rects[i],
        b = rects[i + 1];
      if (!a || !b) return;
      const middle = (Math.min(a.right, b.right) + Math.max(a.left, b.left)) / 2;
      (el as HTMLElement).style.setProperty("--handle-left", `${Math.round(middle - box.left)}px`);
      el.setAttribute("aria-valuenow", String(Math.round(columnShares(node)[i] ?? 0)));
    });
  }
  function commit(widths: (number | null)[] | null) {
    const pos = getPos();
    if (pos === undefined || !view.editable) return;
    const change = setColumnWidths(view.state.tr, pos, widths);
    if (change.docChanged) view.dispatch(change);
  }
  function handle(index: number) {
    const el = document.createElement("div");
    el.className = "editor-columns-resize";
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "vertical");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.setAttribute("aria-label", tr("Spaltenbreite ändern", "Resize columns"));
    el.title = tr("Ziehen ändert die Breite · Doppelklick: gleich breit", "Drag to resize · Double-click: equal widths");
    el.tabIndex = 0;
    el.addEventListener("pointerdown", (event) => {
      if (!view.editable || event.button !== 0) return;
      event.preventDefault();
      const columns = columnsShown();
      const widths = columns.map((c) => c.getBoundingClientRect().width);
      const total = widths.reduce((a, b) => a + b, 0);
      if (!total || !columns[index + 1]) return;
      const shares = widths.map((w) => (w * 100) / total);
      const startX = event.clientX,
        flip = rtl() ? -1 : 1;
      let next: number[] | null = null;
      el.setPointerCapture(event.pointerId);
      dom.classList.add("resizing");
      const move = (e: PointerEvent) => {
        next = resizedWidths(shares, index, ((widths[index] + (e.clientX - startX) * flip) * 100) / total);
        columns.forEach((c, k) => c.style.setProperty("--column-width", String(next![k])));
        schedule();
      };
      const end = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        dom.classList.remove("resizing");
        for (const c of columns) {
          c.style.removeProperty("--column-width");
          if (!c.getAttribute("style")) c.removeAttribute("style");
        }
        if (next) commit(next);
        schedule();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      commit(null);
    });
    el.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
      if (!step) return;
      event.preventDefault();
      const shares = columnShares(node);
      commit(resizedWidths(shares, index, shares[index] + step * (rtl() ? -1 : 1)));
    });
    return el;
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(row);
  schedule();
  return {
    dom,
    contentDOM: row,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      apply();
      schedule();
      return true;
    },
    // Pointer and keys on the handles are theirs, not the editor's.
    stopEvent: (event) => event.target instanceof globalThis.Node && handles.contains(event.target),
    // Only what happens inside the columns is content.
    ignoreMutation: (mutation) =>
      mutation.type === "selection" ? !row.contains(mutation.target) : mutation.target === dom || (mutation.type === "attributes" && mutation.target === row) || !row.contains(mutation.target),
    destroy() {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
