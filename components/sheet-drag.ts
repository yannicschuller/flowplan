"use client";
// Sheets on phones follow the finger down and close when let go far or fast
// enough (lib/sheet-drag.ts has the arithmetic): bottom sheets of dialogs
// (Modal with `sheet`, components/ui.tsx) and the sheets of tools such as
// the whiteboard's. The gesture starts on the grab handle (always) or
// anywhere in the sheet while its content is scrolled to the top and the
// finger moves down; otherwise the content scrolls as before. The sheet
// springs back when let go early, can be caught again while it moves, and
// closes through the same path as Escape and the app's back
// (lib/app-back.ts): `onDismiss` is the dialog's own close.
// The gesture itself (components/sheet-gesture.ts) loads when a sheet first
// opens, not with every page that has dialogs.
import { useEffect, useRef } from "react";

export type SheetDragOptions = {
  onDismiss: () => void;
  // Only while this media query matches (the sheet is presented as one).
  media?: string;
  // The backdrop that fades with the way down.
  backdrop?: () => HTMLElement | null;
};

// The class of the grab handle (app/mobile-ux.css).
export const SHEET_HANDLE = "sheet-handle";

// Attaches the gesture while `element` is there and `enabled`.
export function useSheetDrag(element: HTMLElement | null, enabled: boolean, options: SheetDragOptions) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!element || !enabled) return;
    let detach: (() => void) | null = null,
      gone = false;
    void import("./sheet-gesture").then(
      ({ attachSheetDrag }) => {
        if (!gone) detach = attachSheetDrag(element, () => latest.current);
      },
      () => {},
    );
    return () => {
      gone = true;
      detach?.();
    };
  }, [element, enabled]);
}
