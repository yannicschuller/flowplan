"use client";
// "Tastatur ausblenden" for every text field on a touch phone (#120): titles
// of pages, databases and records, tags and properties, the new-page dialog,
// search fields, comments … A document's (or a record's) docked formatting
// toolbar has the same button at its end; while that one is on screen this
// one stays away, so there are never two. Rendered once, into <body>, above
// the dialogs; placed from the top like the docked toolbar (app/globals.css,
// .hide-keyboard-fab – iOS 26 places bottom: against the height from before
// the keyboard).
import { CaretDown, Keyboard } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "./i18n";
import { typing, useSoftKeyboard } from "./mobile-tab-bar";

const TOUCH_PHONE = "(pointer: coarse) and (max-width: 767px)";

// Whether a docked toolbar's own "Hide keyboard" is on screen and not under
// a dialog (what lies on top at its centre, this button aside, is it).
function toolbarButtonShown(fab: Element | null) {
  for (const button of document.querySelectorAll<HTMLElement>(".editor-hide-keyboard")) {
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
    const top = document.elementsFromPoint(x, y).find((el) => !fab?.contains(el));
    if (top && button.contains(top)) return true;
  }
  return false;
}

function wanted(fab: Element | null) {
  if (!window.matchMedia(TOUCH_PHONE).matches || !typing()) return false;
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (el && "readOnly" in el && el.readOnly) return false;
  return !toolbarButtonShown(fab);
}

export function HideKeyboardButton() {
  const t = useT();
  const keyboardOpen = useSoftKeyboard();
  const [shown, setShown] = useState(false);
  const [fab, setFab] = useState<HTMLButtonElement | null>(null);
  // The tap must not move the focus first (that would keep the keyboard up
  // or open it for another field), and an open dialog must not take it for
  // a tap outside and close (Radix listens on the document).
  useEffect(() => {
    if (!fab) return;
    const hold = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    fab.addEventListener("pointerdown", hold);
    fab.addEventListener("mousedown", hold);
    return () => {
      fab.removeEventListener("pointerdown", hold);
      fab.removeEventListener("mousedown", hold);
    };
  }, [fab]);
  useEffect(() => {
    if (!keyboardOpen) {
      setShown(false);
      return;
    }
    // Checked again after focus and viewport changes, once React has drawn
    // (or removed) a toolbar's button.
    let frame = 0;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const check = () => setShown(wanted(fab));
    const later = () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
      frame = requestAnimationFrame(check);
      timers = [120, 400].map((ms) => setTimeout(check, ms));
    };
    const vv = window.visualViewport;
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    vv?.addEventListener("resize", later);
    vv?.addEventListener("scroll", later);
    later();
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      vv?.removeEventListener("resize", later);
      vv?.removeEventListener("scroll", later);
    };
  }, [keyboardOpen, fab]);
  if (!keyboardOpen || !shown || typeof document === "undefined") return null;
  const label = t("Tastatur ausblenden", "Hide keyboard");
  return createPortal(
    <button
      type="button"
      ref={setFab}
      className="hide-keyboard-fab"
      title={label}
      aria-label={label}
      onClick={() => {
        // Ending the input closes the keyboard; the text stays.
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable) window.getSelection()?.removeAllRanges();
        active?.blur();
        setShown(false);
      }}
    >
      <span className="editor-hide-keyboard-icon" aria-hidden="true">
        <Keyboard />
        <CaretDown weight="bold" />
      </span>
    </button>,
    document.body,
  );
}
