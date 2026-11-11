// Where the text menu opens for a selection (components/text-menu.tsx,
// #210): above the selection – unless there it would cover the editor's
// fixed formatting toolbar, another bar that stays at the top (the record
// dialog's heading, the page's top bar) or leave the visible area; then
// below it. Window coordinates throughout.

export type MenuRect = { left: number; top: number; right: number; bottom: number };

// The marks the text menu offers. Bold, italic and code stay at the text as
// quick access; underline, strikethrough and highlight live in the
// formatting toolbar (and keep their shortcuts) – the menu offers them only
// where that toolbar is not shown (focus mode, a page whose toolbar is
// hidden), so they stay reachable without a keyboard.
export type TextMenuMark = "bold" | "italic" | "underline" | "strike" | "highlight" | "code";
export function textMenuMarks(toolbarShown: boolean): TextMenuMark[] {
  return toolbarShown ? ["bold", "italic", "code"] : ["bold", "italic", "underline", "strike", "highlight", "code"];
}

function overlaps(a: MenuRect, b: MenuRect) {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}

export function textMenuSide({
  selection,
  menu,
  gap,
  minTop,
  toolbar,
  bars = [],
}: {
  // The selected text: its top and bottom.
  selection: { top: number; bottom: number };
  // Where the menu would be across (left, width) and how tall it is.
  menu: { left: number; width: number; height: number };
  // The space between the selection and the menu.
  gap: number;
  // The top of the visible area (window, keyboard-shifted view, the
  // scrolled dialog or page).
  minTop: number;
  // The editor's formatting toolbar, when shown. Above the selection it
  // keeps the menu below its bottom over the whole width: the menu covers
  // neither the toolbar nor what is shown above it.
  toolbar?: MenuRect | null;
  // Other bars that stay put over the text; the menu does not cover them.
  bars?: MenuRect[];
}): "above" | "below" {
  const box = { left: menu.left, right: menu.left + menu.width, top: selection.top - gap - menu.height, bottom: selection.top - gap };
  let limit = minTop;
  if (toolbar && toolbar.bottom <= selection.top + 1) limit = Math.max(limit, toolbar.bottom);
  if (box.top < limit) return "below";
  if (toolbar && overlaps(box, toolbar)) return "below";
  return bars.some((bar) => overlaps(box, bar)) ? "below" : "above";
}
