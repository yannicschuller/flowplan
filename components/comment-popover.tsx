"use client";
// A text comment's thread beside its passage where the margin has no room
// (#450): a narrow window, a record opened as a dialog, the page comments
// open beside the page. Clicking a highlight, a new comment (⌘⌥M, the text
// menu) or a link to the thread opens it here – with the replies, the reply
// field, reactions and "resolve" of components/inline-comment-thread.tsx –
// instead of in the panel below the document. On phones (up to 600 px) a
// bottom sheet: the passage scrolls into view above it, and the sheet sits
// on the on-screen keyboard while the reply is typed.
// Loaded with the first popover; the state stays in
// components/inline-comments.tsx.
//
// Placement: lib/comment-popover-layout.ts, from the passage's highlight
// (data-comment-thread, lib/inline-comment-plugin.ts). The popover is
// position: fixed and placed with --popover-left/--popover-top (CSSOM, no
// style attributes), again on scrolling, resizing and every change of the
// text. It stays inside the editor's own tree – a record dialog keeps its
// focus and pointer events – and corrects for a containing block that is
// not the window (a transformed dialog).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { X } from "@phosphor-icons/react";
import { COMMENT_SHEET_MAX_WIDTH, placeCommentPopover, placeFixed, unionBox } from "@/lib/comment-popover-layout";
import { addBackCloser } from "@/lib/app-back";
import { prefersReducedMotion } from "@/lib/motion";
import { SHEET_HANDLE, useSheetDrag } from "./sheet-drag";
import { useT } from "./i18n";

const SHEET_MEDIA = `(max-width: ${COMMENT_SHEET_MAX_WIDTH}px)`;

function viewportBox() {
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0,
    left = vv?.offsetLeft ?? 0;
  return { left, top, right: left + (vv?.width ?? window.innerWidth), bottom: top + (vv?.height ?? window.innerHeight) };
}

// The boxes of a thread's highlight in the editor.
export function passageBox(editor: Editor, id: string) {
  const rects: DOMRect[] = [];
  for (const mark of editor.view.dom.querySelectorAll<HTMLElement>(`[data-comment-thread="${CSS.escape(id)}"]`))
    rects.push(...mark.getClientRects());
  return unionBox(rects);
}

export default function CommentPopover({
  editor,
  id,
  color,
  label,
  onClose,
  dismissOnOutside = true,
  children,
}: {
  editor: Editor;
  // The thread (or the new comment's thread id) whose passage it belongs to.
  id: string;
  color: string;
  label: string;
  onClose: () => void;
  // Whether a click elsewhere closes it (the new comment's form stays).
  dismissOnOutside?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState(() => typeof window !== "undefined" && window.matchMedia(SHEET_MEDIA).matches);
  const close = useRef(onClose);
  close.current = onClose;
  const frame = useRef(0);

  useEffect(() => {
    const media = window.matchMedia(SHEET_MEDIA);
    const change = () => setSheet(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  const place = useRef(() => {});
  place.current = () => {
    const el = root.current;
    if (!el || editor.isDestroyed) return;
    const view = viewportBox();
    if (sheet) {
      // On the keyboard: the sheet's bottom where the visible area ends.
      el.style.setProperty("--sheet-bottom", `${Math.max(0, Math.round(window.innerHeight - view.bottom))}px`);
      el.style.setProperty("--sheet-height", `${Math.round(view.bottom - view.top)}px`);
      return;
    }
    const passage = passageBox(editor, id);
    el.toggleAttribute("data-detached", !passage);
    if (!passage) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const p = placeCommentPopover({ passage, text: editor.view.dom.getBoundingClientRect(), size, viewport: view });
    el.dataset.side = p.side;
    el.style.setProperty("--popover-max-height", `${Math.round(p.maxHeight)}px`);
    placeFixed(el, p.left, p.top);
  };
  const schedule = useRef(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => place.current());
  });

  useLayoutEffect(() => {
    place.current();
  }, [id, sheet]);
  useEffect(() => {
    const again = schedule.current;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    if (root.current) observer?.observe(root.current);
    observer?.observe(editor.view.dom);
    editor.on("transaction", again);
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    window.visualViewport?.addEventListener("resize", again);
    window.visualViewport?.addEventListener("scroll", again);
    return () => {
      cancelAnimationFrame(frame.current);
      observer?.disconnect();
      editor.off("transaction", again);
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("resize", again);
      window.visualViewport?.removeEventListener("scroll", again);
    };
  }, [editor]);

  // The open thread's passage more strongly (app/comment-margin.css); a
  // data attribute, as React owns the wrapper's classes.
  useEffect(() => {
    const wrapper = editor.view.dom.closest<HTMLElement>(".editor-wrapper");
    if (!wrapper) return;
    wrapper.dataset.commentPopover = "";
    return () => {
      delete wrapper.dataset.commentPopover;
    };
  }, [editor]);
  // Phones: the passage stays in sight above the sheet (its height as the
  // highlight's scroll margin, app/comment-margin.css).
  useEffect(() => {
    const el = root.current;
    if (!sheet || !el) return;
    const html = document.documentElement;
    let frame = 0,
      height = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Again when the sheet grows (the thread loads, a reply is added).
        if (Math.abs(el.offsetHeight - height) < 8) return;
        height = el.offsetHeight;
        html.style.setProperty("--comment-sheet-room", `${Math.round(height + 16)}px`);
        const mark = editor.view.dom.querySelector<HTMLElement>(`.inline-comment-active[data-comment-thread="${CSS.escape(id)}"], [data-comment-thread="${CSS.escape(id)}"]`);
        const box = mark?.getBoundingClientRect();
        const top = el.getBoundingClientRect().top;
        if (mark && box && (box.bottom > Math.min(top, window.innerHeight - height) - 8 || box.top < 0))
          mark.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      });
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      html.style.removeProperty("--comment-sheet-room");
    };
  }, [sheet, id, editor]);
  useSheetDrag(element, sheet, { onDismiss: () => close.current(), media: SHEET_MEDIA });
  useEffect(() => (sheet ? addBackCloser(() => close.current()) : undefined), [sheet]);

  // A click elsewhere closes it (a highlight opens its own thread; dialogs
  // such as the emoji picker and lists of people belong to it); Escape
  // with the focus in it, in the text or nowhere.
  const outside = useRef(dismissOnOutside);
  outside.current = dismissOnOutside;
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!outside.current || !target?.closest || !root.current) return;
      if (root.current.contains(target) || target.closest("[data-comment-thread], .modal, [role=dialog], [role=listbox], [role=menu], .inline-comment-panel, .inline-comment-tools, .comment-preview"))
        return;
      close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.current?.contains(focus) && !editor.view.dom.contains(focus)) return;
      if ((focus as Element | null)?.closest?.('[aria-expanded="true"]')) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [editor]);

  return (
    <section
      ref={(node) => {
        root.current = node;
        setElement(node);
      }}
      className={`comment-popover${sheet ? " comment-popover-sheet" : ""}`}
      data-comment-color={color}
      role="dialog"
      aria-modal={false}
      aria-label={label}
      // Before the comment fields see it (their editor takes Escape); an
      // open list of people to mention closes first.
      onKeyDownCapture={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as Element).closest?.('[aria-expanded="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      {sheet && <div className={SHEET_HANDLE} aria-hidden />}
      <button type="button" className="icon-button comment-popover-close" aria-label={t("Kommentar schließen", "Close comment")} title={t("Kommentar schließen", "Close comment")} onClick={onClose}>
        <X size={14} />
      </button>
      <div className="comment-popover-body">{children}</div>
    </section>
  );
}
