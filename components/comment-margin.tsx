"use client";
// The margin beside the text with its open text comments (#387), like the
// comments of a word processor: every thread a compact card at the height of
// its passage (the first message, its author, the number of replies); the
// active one expanded in place – replies, reactions, the reply field,
// "resolve" (components/inline-comment-thread.tsx) – and aligned with its
// passage, the others pushed out of its way (lib/comment-margin-layout.ts).
// A new comment's form stands at its passage as well. Loaded only when a
// document has open text comments and the margin is shown; the state stays
// in components/inline-comments.tsx.
//
// Places: the passages' highlights (data-comment-thread, from
// lib/inline-comment-plugin.ts) are measured against the top of the editor,
// the cards placed with --card-top (CSSOM, as the table of contents does;
// no style attributes). The margin sits after the document in the editor's
// wrapper, in the room its padding keeps free on the right (app/comment-
// margin.css); measured again when the text, its images, the cards or the
// window change size.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import { CaretUp } from "@phosphor-icons/react";
import type { InlineThread } from "@/lib/inline-comment-types";
import { layoutMarginCards, marginExtent, type MarginItem } from "@/lib/comment-margin-layout";
import { prefersReducedMotion } from "@/lib/motion";
import { useT } from "./i18n";
import { Avatar } from "./ui";

const GAP = 8;

export default function CommentMargin({
  editor,
  threads,
  active,
  draft,
  reveal,
  onActivate,
  renderThread,
  renderDraft,
}: {
  editor: Editor;
  // The open threads whose passage is in the document, in the order of
  // their passages.
  threads: InlineThread[];
  active: string | null;
  // The new comment: its highlight's id (the thread it will become) and
  // how many of `threads` come before it.
  draft: { id: string; index: number } | null;
  // Scroll to this card's passage (a link to the thread, the panel's list).
  reveal: { id: string; n: number } | null;
  onActivate: (id: string | null) => void;
  renderThread: (thread: InlineThread) => ReactNode;
  renderDraft: () => ReactNode;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const live = useRef({ active, draft, onActivate });
  live.current = { active, draft, onActivate };
  const ids = [...threads.map((thread) => thread.id), ...(draft ? [draft.id] : [])];
  const key = ids.join(",");

  // Measures the passages and cards and places the cards.
  const place = useRef(() => {});
  place.current = () => {
    const margin = root.current;
    if (!margin || editor.isDestroyed) return;
    const dom = editor.view.dom,
      base = dom.getBoundingClientRect().top,
      offset = base - margin.getBoundingClientRect().top;
    const items: MarginItem[] = [];
    const cards = new Map<string, HTMLElement>();
    for (const card of margin.querySelectorAll<HTMLElement>(":scope > [data-margin-card]")) {
      const id = card.dataset.marginCard!;
      let top = Infinity;
      for (const mark of dom.querySelectorAll<HTMLElement>(`[data-comment-thread="${CSS.escape(id)}"]`))
        for (const rect of mark.getClientRects()) if (rect.height || rect.width) top = Math.min(top, rect.top);
      // A passage in a folded section, or not drawn yet: no card.
      card.toggleAttribute("data-hidden", top === Infinity);
      if (top === Infinity) continue;
      cards.set(id, card);
      items.push({ id, anchor: top - base, height: card.offsetHeight });
    }
    const focus = live.current.draft?.id || live.current.active;
    const placements = layoutMarginCards(items, { gap: GAP, active: focus, top: 0 });
    for (const p of placements) {
      const card = cards.get(p.id)!;
      card.style.setProperty("--card-top", `${Math.round(p.top + offset)}px`);
      if (!card.hasAttribute("data-placed")) {
        // Its first place without sliding there: the style is settled
        // before the card shows (and from then on moves smoothly).
        card.getBoundingClientRect();
        card.toggleAttribute("data-placed", true);
      }
    }
    // The cards below the document's end keep the room they need.
    margin.style.setProperty("--margin-extent", `${Math.max(0, Math.ceil(marginExtent(items, placements) + offset))}px`);
  };
  const schedule = useRef(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => place.current());
  });

  useLayoutEffect(() => {
    place.current();
  }, [key, active]);
  useEffect(() => {
    const again = schedule.current;
    const dom = editor.view.dom;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    observer?.observe(dom);
    if (root.current) for (const card of root.current.querySelectorAll(":scope > [data-margin-card]")) observer?.observe(card);
    if (root.current?.parentElement) observer?.observe(root.current.parentElement);
    editor.on("transaction", again);
    // Images and embeds that finish loading move the text below them;
    // a scrolled block inside the text moves its passages.
    dom.addEventListener("load", again, true);
    dom.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    void document.fonts?.ready.then(again);
    return () => {
      cancelAnimationFrame(frame.current);
      observer?.disconnect();
      editor.off("transaction", again);
      dom.removeEventListener("load", again, true);
      dom.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, [editor, key]);

  // Clicking elsewhere in the page, or Escape in a card, closes the active
  // card again (a highlight opens its own; dialogs such as the emoji picker
  // belong to the card).
  useEffect(() => {
    if (!active) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest || !root.current) return;
      if (root.current.contains(target) || target.closest("[data-comment-thread], .modal, [role=dialog], [role=listbox], .inline-comment-panel, .inline-comment-tools"))
        return;
      live.current.onActivate(null);
    };
    // Escape with the focus in the card or nowhere (a sent reply's button
    // is disabled and gives the focus up).
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.current?.contains(focus)) return;
      event.preventDefault();
      live.current.onActivate(null);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [active]);

  useEffect(() => {
    if (!reveal) return;
    const go = requestAnimationFrame(() => {
      const mark = editor.view.dom.querySelector<HTMLElement>(`[data-comment-thread="${CSS.escape(reveal.id)}"]`);
      mark?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(go);
  }, [reveal, editor]);

  const draftCard = draft && (
    <section key={draft.id} data-margin-card={draft.id} className="comment-margin-card active" aria-label={t("Neuer Textkommentar", "New text comment")}>
      {renderDraft()}
    </section>
  );
  return (
    <div ref={root} className="comment-margin" role="region" aria-label={t("Textkommentare am Rand", "Text comments in the margin")}>
      {draft && draft.index <= 0 && draftCard}
      {threads.map((thread, index) => {
        const open = thread.id === active && !draft;
        const first = thread.messages[0];
        const before = draft && draft.index === index && index > 0 ? draftCard : null;
        const replies = Math.max(0, thread.messageCount - 1);
        return [
          before,
          <section
            key={thread.id}
            data-margin-card={thread.id}
            className={`comment-margin-card${open ? " active" : ""}`}
            aria-label={t(`Textkommentar von ${first?.name || "?"}`, `Text comment by ${first?.name || "?"}`)}
            // Before the comment fields see it (their editor takes Escape);
            // an open list of people to mention closes first.
            onKeyDownCapture={
              open
                ? (e) => {
                    if (e.key !== "Escape" || e.defaultPrevented || (e.target as Element).closest?.('[aria-expanded="true"]')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onActivate(null);
                  }
                : undefined
            }
          >
            {open ? (
              <>
                <button type="button" className="icon-button comment-margin-collapse" aria-label={t("Kommentar zuklappen", "Collapse comment")} title={t("Kommentar zuklappen", "Collapse comment")} onClick={() => onActivate(null)}>
                  <CaretUp size={14} />
                </button>
                {renderThread(thread)}
              </>
            ) : (
              <button type="button" className="comment-margin-summary" aria-expanded={false} onClick={() => onActivate(thread.id)}>
                <span className="comment-margin-author">
                  <Avatar name={first?.name || "?"} small />
                  <strong>{first?.name}</strong>
                </span>
                <span className="comment-margin-text">{first && !first.deleted ? first.body : t("Kommentar gelöscht", "Comment deleted")}</span>
                {replies > 0 && (
                  <small className="comment-margin-replies">{replies === 1 ? t("1 Antwort", "1 reply") : t(`${replies} Antworten`, `${replies} replies`)}</small>
                )}
              </button>
            )}
          </section>,
        ];
      })}
      {draft && draft.index >= threads.length && threads.length > 0 && draftCard}
    </div>
  );
}
