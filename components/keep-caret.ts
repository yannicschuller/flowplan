"use client";
// Typing with the on-screen keyboard open (#181): the caret's line stays
// above the keyboard and the toolbar docked on it, from the keyboard's first
// appearance on. ProseMirror's own scrolling cannot do that on a phone: it
// keeps the caret inside the pane – which on iOS reaches behind the keyboard
// – and then inside [0, visualViewport.height] of the window, ignoring how
// far iOS moved the visible area down the page and the docked toolbar. So
// while the keyboard is docked, the editor's pane is scrolled here instead
// (lib/keyboard-caret.ts has the arithmetic).
import type { EditorView } from "@tiptap/pm/view";
import { caretScroll, visibleBand } from "@/lib/keyboard-caret";
import { remeasureKeyboard, scrollPane } from "./mobile-tab-bar";

// Whether it took care of the scrolling (for handleScrollToSelection).
export function keepCaretAboveKeyboard(view: EditorView) {
  const vv = window.visualViewport;
  if (!vv || view.isDestroyed || !view.hasFocus()) return false;
  if (!document.documentElement.classList.contains("keyboard-docked")) return false;
  const pane = scrollPane(view.dom);
  if (!pane) return false;
  // The room under the text (--keyboard-cover) and the toolbar's place
  // follow the keyboard as it is now.
  remeasureKeyboard();
  if (!document.documentElement.classList.contains("keyboard-docked")) return false;
  const head = view.state.selection.head;
  let caret: { top: number; bottom: number; left: number; right: number };
  try {
    caret = view.coordsAtPos(head);
  } catch {
    return false;
  }
  // Sideways, what ProseMirror would do: a wide table or code block inside
  // the pane shows the caret.
  let inner: Element | null = null;
  try {
    const at = view.domAtPos(head).node;
    inner = at.nodeType === 1 ? (at as Element) : at.parentElement;
  } catch {}
  for (let el = inner; el && el !== pane && pane.contains(el); el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1 || !/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowX)) continue;
    const box = el.getBoundingClientRect();
    const shift = caret.left < box.left + 5 ? caret.left - box.left - 5 : caret.right > box.right - 5 ? caret.right - box.right + 5 : 0;
    if (shift) {
      const before = el.scrollLeft;
      el.scrollLeft += shift;
      const moved = el.scrollLeft - before;
      caret = { ...caret, left: caret.left - moved, right: caret.right - moved };
    }
  }
  const toolbar = view.dom.closest(".editor-wrapper")?.querySelector<HTMLElement>(".editor-toolbar");
  const toolbarTop = toolbar && getComputedStyle(toolbar).position === "fixed" ? toolbar.getBoundingClientRect().top : null;
  const box = pane.getBoundingClientRect();
  const delta = caretScroll(caret, visibleBand({ top: box.top, bottom: box.bottom }, vv, toolbarTop));
  if (delta) pane.scrollTop += delta;
  return true;
}

// Also when the keyboard itself moves: it comes up after the tap, iOS
// reports its size late and moves the visible area. Once the keyboard
// watcher has measured (its frame comes first), the caret follows.
export function followKeyboard(view: EditorView) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let frame = 0;
  const follow = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => keepCaretAboveKeyboard(view));
    });
  };
  vv.addEventListener("resize", follow);
  vv.addEventListener("scroll", follow);
  follow();
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener("resize", follow);
    vv.removeEventListener("scroll", follow);
  };
}
