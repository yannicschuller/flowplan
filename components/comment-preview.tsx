"use client";
// The hover preview of a highlighted passage (#450): after a moment over a
// text comment's highlight (a mouse; components/inline-comments.tsx waits
// and decides), a small card below it with who wrote the first comment, its
// beginning, the number of replies and whether the thread is resolved. A
// click on the card opens the thread (the margin card or the popover);
// Escape, leaving the highlight and the card, or scrolling close it.
// Placed like the popover (lib/comment-popover-layout.ts, --popover-left /
// --popover-top). Loaded with the first preview.
import { useLayoutEffect, useRef } from "react";
import { Check } from "@phosphor-icons/react";
import type { InlineThread } from "@/lib/inline-comment-types";
import { commentColorOf } from "@/lib/comment-colors";
import { placeCommentPopover, placeFixed, shortComment, type Box } from "@/lib/comment-popover-layout";
import { useT } from "./i18n";
import { Avatar } from "./ui";

export default function CommentPreview({
  thread,
  anchor,
  onOpen,
  onEnter,
  onLeave,
}: {
  thread: InlineThread;
  // The hovered highlight's box on screen.
  anchor: Box;
  onOpen: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const root = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const vv = window.visualViewport;
    const top = vv?.offsetTop ?? 0;
    const p = placeCommentPopover({
      passage: anchor,
      size: { width: el.offsetWidth, height: el.offsetHeight },
      viewport: { left: 0, top, right: vv?.width ?? window.innerWidth, bottom: top + (vv?.height ?? window.innerHeight) },
      gap: 6,
      beside: false,
    });
    el.dataset.side = p.side;
    placeFixed(el, p.left, p.top);
    el.toggleAttribute("data-placed", true);
  }, [anchor, thread.id]);
  const first = thread.messages[0];
  const replies = Math.max(0, thread.messageCount - 1);
  const text = first && !first.deleted ? shortComment(first.body) : t("Kommentar gelöscht", "Comment deleted");
  return (
    <button
      ref={root}
      type="button"
      className="comment-preview"
      data-comment-color={commentColorOf(thread.color)}
      // Shown on hover; the thread itself is reached by clicking the
      // highlight or from the list of text comments.
      tabIndex={-1}
      aria-label={t(`Kommentar von ${first?.name || "?"} öffnen`, `Open comment by ${first?.name || "?"}`)}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
    >
      <span className="comment-preview-author">
        <Avatar name={first?.name || "?"} small />
        <strong>{first?.name || t("Unbekannt", "Unknown")}</strong>
        {!!thread.resolved && (
          <span className="comment-preview-resolved">
            <Check size={12} /> {t("Erledigt", "Resolved")}
          </span>
        )}
      </span>
      <span className="comment-preview-text">{text}</span>
      <small className="comment-preview-replies">
        {replies === 0 ? t("Keine Antworten", "No replies") : replies === 1 ? t("1 Antwort", "1 reply") : t(`${replies} Antworten`, `${replies} replies`)}
      </small>
    </button>
  );
}
