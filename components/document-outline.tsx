"use client";
// The table of contents beside a document: built from its headings while
// writing, follows the reading position and jumps to a heading on click.
// Open or closed is remembered in this browser for all documents. Shared and
// published pages have it too (PublicOutline), from the rendered headings.
// When the text column is too narrow for text and list side by side (a
// narrow window, "KI fragen" docked beside the page, comments open, phones)
// the list gives way: its button opens it as a popover that closes again
// on a heading, Escape or a click elsewhere (useOutline).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ArrowsInLineVertical, ArrowsOutLineVertical, Link as LinkIcon, ListBullets, X } from "@phosphor-icons/react";
import { setAllFolded } from "@/lib/heading-folds-plugin";
import { useT } from "./i18n";
import { reveal } from "@/lib/motion";

export type OutlineHeading = { text: string; pos: number; level: number };
const KEY = "flowplan.outline";

export function useOutlineOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(KEY) === "1");
    } catch {}
  }, []);
  return [
    open,
    (next: boolean) => {
      setOpen(next);
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
      } catch {}
    },
  ];
}

// Text and list fit side by side from this width of the page's text column
// (.page-content in the main area: up to 820 px, less beside comments or a
// docked panel); the list takes 236 px of it. Without such a column (a
// record dialog, a shared page) the window decides, from 901 px.
export const OUTLINE_SIDE_MIN = 768;
export const OUTLINE_WINDOW_MIN = 901;
export const outlineFits = (column: number) => column >= OUTLINE_SIDE_MIN;

// Whether the list must give way (a popover instead of a list beside the
// text), for the page of the element `anchor` is in. False until measured.
export function useOutlineNarrow(anchor: HTMLElement | null) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!anchor) return;
    const column = anchor.closest(".main") ? anchor.closest<HTMLElement>(".page-content") : null;
    if (column && typeof ResizeObserver !== "undefined") {
      const measure = () => setNarrow(!outlineFits(column.getBoundingClientRect().width));
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(column);
      return () => observer.disconnect();
    }
    const media = matchMedia(`(max-width: ${OUTLINE_WINDOW_MIN - 1}px)`);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [anchor]);
  return narrow;
}

// Open beside the text (remembered) or, where it gives way, as a popover
// (not remembered: it closes after a jump). The anchor is any element in
// the page – the editor's wrapper –, the button the toggle the popover
// hangs on.
export function useOutline() {
  const [open, setOpen] = useOutlineOpen();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const narrow = useOutlineNarrow(anchor);
  const [popover, setPopover] = useState(false);
  useEffect(() => {
    if (!narrow) setPopover(false);
  }, [narrow]);
  return {
    anchorRef: setAnchor,
    buttonRef: setButton,
    button,
    narrow,
    // The list beside the text (the page makes room for it).
    docked: open && !narrow,
    shown: narrow ? popover : open,
    toggle: () => (narrow ? setPopover((p) => !p) : setOpen(!open)),
    close: () => (narrow ? setPopover(false) : setOpen(false)),
  };
}

// The popover's place: below its button, right-aligned with it (window
// coordinates for the fixed list; CSS keeps phones at the bottom edge).
function usePopoverPlace(nav: HTMLElement | null, button: HTMLElement | null | undefined) {
  useLayoutEffect(() => {
    if (!nav || !button) return;
    let frame = 0;
    const set = () => {
      const box = button.getBoundingClientRect();
      nav.style.setProperty("--outline-top", `${Math.round(box.bottom + 6)}px`);
      nav.style.setProperty("--outline-right", `${Math.max(8, Math.round(document.documentElement.clientWidth - box.right))}px`);
    };
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(set);
    };
    set();
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [nav, button]);
}

const headingElement = (editor: Editor, pos: number) => {
  try {
    const node = editor.view.nodeDOM(pos);
    return node instanceof HTMLElement ? node : null;
  } catch {
    return null;
  }
};

// In a dialog (a record) the list stays beside the dialog's text, not the
// window's edge: the dialog's box goes to --dialog-top, --dialog-right and
// --dialog-bottom (app/globals.css, ".modal .document-outline"). Layout
// offsets, not the drawn box: the opening animation scales the dialog.
function followDialog(nav: HTMLElement | null) {
  const dialog = nav?.parentElement?.closest<HTMLElement>(".modal");
  if (!nav || !dialog) return;
  const place = () => {
    const root = document.documentElement,
      top = dialog.offsetTop + dialog.clientTop,
      left = dialog.offsetLeft + dialog.clientLeft;
    nav.style.setProperty("--dialog-top", `${top}px`);
    nav.style.setProperty("--dialog-right", `${Math.max(0, root.clientWidth - left - dialog.clientWidth)}px`);
    nav.style.setProperty("--dialog-bottom", `${Math.max(0, root.clientHeight - top - dialog.clientHeight)}px`);
  };
  place();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
  observer?.observe(dialog);
  window.addEventListener("resize", place);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", place);
  };
}

export function DocumentOutline({
  editor,
  headings,
  onClose,
  locate,
  onCopyLink,
  popover,
}: {
  editor: Editor | null;
  headings: OutlineHeading[];
  onClose: () => void;
  // A popover hanging on this button (the list gives way to the text):
  // focus moves into it, Escape and a click elsewhere close it.
  popover?: { button: HTMLButtonElement | null };
  // Copies the link to a heading (#88); only in the app's editor.
  onCopyLink?: (pos: number) => void;
  // Without an editor: the element of a heading (a read-only document).
  locate?: (pos: number) => HTMLElement | null;
}) {
  const t = useT();
  const [active, setActive] = useState<number | null>(null);
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const navRef = useCallback((node: HTMLElement | null) => {
    setNav(node);
    return followDialog(node);
  }, []);
  const button = popover?.button;
  usePopoverPlace(popover ? nav : null, button);
  // The popover: focus on the current heading (else the first entry),
  // Escape closes and goes back to the button, a click elsewhere closes.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const isPopover = !!popover;
  useEffect(() => {
    if (!isPopover || !nav) return;
    // Two frames: the current heading is marked in the first one.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        (nav.querySelector<HTMLElement>('li button[aria-current="location"]') || nav.querySelector<HTMLElement>("li > button") || nav.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true }),
      );
    });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      button?.focus({ preventScroll: true });
    };
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      // Its own buttons (the toggle, the toolbar's) toggle it themselves.
      if (nav.contains(target) || button?.contains(target) || (target instanceof Element && target.closest("[data-outline-toggle]"))) return;
      closeRef.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [isPopover, nav, button]);
  const top = Math.min(...headings.map((h) => h.level), 3);
  // The heading the reader is in: the last one above the upper fifth of the window.
  const key = headings.map((h) => h.pos).join(",");
  const element = (pos: number) => (editor ? headingElement(editor, pos) : locate?.(pos) || null);
  useEffect(() => {
    if (!editor && !locate) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor?.isDestroyed) return;
        const line = window.innerHeight * 0.2;
        let current: number | null = headings[0]?.pos ?? null;
        for (const h of headings) {
          const el = element(h.pos);
          // Headings in a folded section (no box) do not count.
          if (el && el.getClientRects().length && el.getBoundingClientRect().top <= line) current = h.pos;
        }
        setActive(current);
      });
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, key]);
  return (
    <nav
      ref={navRef}
      id={popover ? OUTLINE_POPOVER_ID : undefined}
      className={`document-outline${popover ? " outline-popover" : ""}`}
      aria-label={t("Inhaltsverzeichnis", "Table of contents")}
      // Beside the text: Escape in the list closes it as well (#259) and
      // goes back to its toggle (the popover has its own handler above).
      onKeyDown={
        popover
          ? undefined
          : (e) => {
              if (e.key !== "Escape" || e.defaultPrevented) return;
              e.preventDefault();
              e.stopPropagation();
              const toggle = nav?.parentElement?.querySelector<HTMLElement>(":scope > .outline-toggle");
              onClose();
              // The toggle is hidden while the list is open beside the text:
              // focusable again once the list has gone.
              requestAnimationFrame(() => requestAnimationFrame(() => toggle?.focus({ preventScroll: true })));
            }
      }
    >
      <div className="document-outline-head">
        <strong>
          <ListBullets aria-hidden /> {t("Inhalt", "Contents")}
        </strong>
        {editor && headings.length > 0 && (
          <span className="document-outline-folds">
            <button
              type="button"
              className="icon-button"
              aria-label={t("Alle Abschnitte einklappen", "Collapse all sections")}
              title={t("Alle Abschnitte einklappen", "Collapse all sections")}
              onClick={() => !editor.isDestroyed && setAllFolded(editor.view, true)}
            >
              <ArrowsInLineVertical size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Alle Abschnitte ausklappen", "Expand all sections")}
              title={t("Alle Abschnitte ausklappen", "Expand all sections")}
              onClick={() => !editor.isDestroyed && setAllFolded(editor.view, false)}
            >
              <ArrowsOutLineVertical size={14} />
            </button>
          </span>
        )}
        <button type="button" className="icon-button" aria-label={t("Inhaltsverzeichnis schließen", "Close table of contents")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {headings.length ? (
        <ol>
          {headings.map((h) => (
            <li key={h.pos} className={`level-${Math.min(h.level - top + 1, 4)}`}>
              <button
                type="button"
                aria-current={active === h.pos ? "location" : undefined}
                onClick={() => {
                  // Scrolls to the heading, which then flashes briefly.
                  reveal(element(h.pos), "start", true);
                  setActive(h.pos);
                  // The caret goes to the heading, so typing continues there.
                  editor?.commands.setTextSelection(h.pos + 1 + h.text.length);
                  // The popover (the list gave way to the text) closes.
                  if (popover) onClose();
                }}
              >
                {h.text || t("Überschrift", "Heading")}
              </button>
              {onCopyLink && (
                <button
                  type="button"
                  className="icon-button document-outline-link"
                  aria-label={t(`Link zu „${h.text || "Überschrift"}“ kopieren`, `Copy link to “${h.text || "heading"}”`)}
                  title={t("Link zur Überschrift kopieren", "Copy link to heading")}
                  onClick={() => onCopyLink(h.pos)}
                >
                  <LinkIcon size={13} />
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">{t("Überschriften erscheinen hier, sobald du welche schreibst.", "Headings appear here as soon as you write some.")}</p>
      )}
    </nav>
  );
}

const OUTLINE_POPOVER_ID = "document-outline-popover";

// The button that opens the table of contents (also without a toolbar);
// for the popover it says whether that is open (aria-expanded).
export function OutlineToggle({
  open,
  count,
  onToggle,
  popover = false,
  buttonRef,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
  popover?: boolean;
  buttonRef?: (node: HTMLButtonElement | null) => void;
}) {
  const t = useT();
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`outline-toggle${open ? " active" : ""}`}
      {...(popover ? { "aria-expanded": open, "aria-controls": open ? OUTLINE_POPOVER_ID : undefined } : { "aria-pressed": open })}
      title={t("Inhaltsverzeichnis", "Table of contents")}
      // The visible count is part of the name (WCAG 2.5.3).
      aria-label={
        count === 0
          ? t("Inhaltsverzeichnis", "Table of contents")
          : count === 1
            ? t("Inhaltsverzeichnis: 1 Überschrift", "Table of contents: 1 heading")
            : t(`Inhaltsverzeichnis: ${count} Überschriften`, `Table of contents: ${count} headings`)
      }
      onClick={onToggle}
    >
      <ListBullets size={16} aria-hidden />
      {count > 0 && <span>{count}</span>}
    </button>
  );
}

// Shared and published pages: the outline of the read-only document in the
// page (its rendered headings), with the same toggle and list as in the
// editor. Headings in embedded pages and comments do not count.
export function PublicOutline() {
  const outline = useOutline();
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [elements, setElements] = useState<HTMLElement[]>([]);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".public-page .document-editor");
    if (!root) return;
    const found = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4")).filter(
      (el) => el.closest(".document-editor") === root && (el.textContent || "").trim(),
    );
    setElements(found);
    setHeadings(found.map((el, i) => ({ text: (el.textContent || "").trim(), pos: i, level: Number(el.tagName[1]) })));
  }, []);
  const { anchorRef } = outline;
  useEffect(() => {
    anchorRef(document.querySelector<HTMLElement>(".public-page"));
  }, [anchorRef]);
  useEffect(() => {
    document.querySelector(".public-page")?.classList.toggle("with-outline", outline.docked && headings.length > 0);
  }, [outline.docked, headings.length]);
  if (!headings.length) return null;
  return (
    <>
      <OutlineToggle open={outline.shown} count={headings.length} onToggle={outline.toggle} popover={outline.narrow} buttonRef={outline.buttonRef} />
      {outline.shown && (
        <DocumentOutline
          editor={null}
          headings={headings}
          locate={(pos) => elements[pos] || null}
          onClose={outline.close}
          popover={outline.narrow ? { button: outline.button } : undefined}
        />
      )}
    </>
  );
}
