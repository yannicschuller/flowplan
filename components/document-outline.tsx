"use client";
// The table of contents beside a document: built from its headings while
// writing, follows the reading position and jumps to a heading on click.
// Open or closed is remembered in this browser for all documents. Shared and
// published pages have it too (PublicOutline), from the rendered headings.
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ArrowsInLineVertical, ArrowsOutLineVertical, ListBullets, X } from "@phosphor-icons/react";
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
}: {
  editor: Editor | null;
  headings: OutlineHeading[];
  onClose: () => void;
  // Without an editor: the element of a heading (a read-only document).
  locate?: (pos: number) => HTMLElement | null;
}) {
  const t = useT();
  const [active, setActive] = useState<number | null>(null);
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
    <nav ref={followDialog} className="document-outline" aria-label={t("Inhaltsverzeichnis", "Table of contents")}>
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
                  // Small screens: the list covers the text, so it closes.
                  if (window.innerWidth < 1100) onClose();
                }}
              >
                {h.text || t("Überschrift", "Heading")}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">{t("Überschriften erscheinen hier, sobald du welche schreibst.", "Headings appear here as soon as you write some.")}</p>
      )}
    </nav>
  );
}

// The button that opens the table of contents (also without a toolbar).
export function OutlineToggle({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`outline-toggle${open ? " active" : ""}`}
      aria-pressed={open}
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
  const [open, setOpen] = useOutlineOpen();
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
  useEffect(() => {
    document.querySelector(".public-page")?.classList.toggle("with-outline", open && headings.length > 0);
  }, [open, headings.length]);
  if (!headings.length) return null;
  return (
    <>
      <OutlineToggle open={open} count={headings.length} onToggle={() => setOpen(!open)} />
      {open && <DocumentOutline editor={null} headings={headings} locate={(pos) => elements[pos] || null} onClose={() => setOpen(false)} />}
    </>
  );
}
