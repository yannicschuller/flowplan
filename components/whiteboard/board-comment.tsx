"use client";
// Comment pins on the whiteboard (#455, lib/whiteboard-comments.ts): the
// thread of a pin with the comment content of page comments (formatting,
// "@" for people and pages, links with previews, attachments – the
// composer of components/comment-composer.tsx, loaded when a pin opens),
// the pin's colour, the hover preview of a pin's badge, and the clean-up of
// attachments whose comments are gone.
//
// Guests of edit links (no account) write plain text, as before.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Trash, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Avatar } from "../ui";
import { CommentBody } from "../comment-body";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { COMMENT_COLORS, type CommentColor } from "@/lib/comment-colors";
import { commentMentions, commentReady, type CommentNode } from "@/lib/comment-content";
import { placeCommentPopover, placeFixed, shortComment, type Box } from "@/lib/comment-popover-layout";
import {
  boardCommentColor,
  boardMentionKeys,
  boardMessageContent,
  boardMessageFiles,
  boardMessageText,
  storedBoardCommentColor,
  storedBoardMessage,
  withMentionTitles,
} from "@/lib/whiteboard-comments";
import type { WhiteboardItem, WhiteboardMessage } from "@/lib/whiteboard-model";

const CommentComposer = lazy(() => import("../comment-composer").then((m) => ({ default: m.CommentComposer })));

// ---- titles of mentioned pages, for this reader ----

const titles = new Map<string, string | null>();
const asked = new Set<string>();
const titleListeners = new Set<() => void>();
function useMentionTitles(pageId: string, keys: string[], enabled: boolean) {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    titleListeners.add(listener);
    return () => {
      titleListeners.delete(listener);
    };
  }, []);
  const missing = keys.filter((k) => !asked.has(`${pageId}|${k}`));
  const wanted = missing.join(",");
  useEffect(() => {
    if (!enabled || !wanted) return;
    const list = wanted.split(",");
    list.forEach((k) => asked.add(`${pageId}|${k}`));
    void fetch(`/api/whiteboards/${pageId}/comments?mentions=${encodeURIComponent(wanted)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { titles: {} }))
      .then((data: { titles?: Record<string, string | null> }) => {
        for (const k of list) titles.set(`${pageId}|${k}`, data.titles?.[k] ?? null);
        titleListeners.forEach((l) => l());
      })
      .catch(() => list.forEach((k) => asked.delete(`${pageId}|${k}`)));
  }, [pageId, wanted, enabled]);
  return Object.fromEntries(keys.map((k) => [k, titles.get(`${pageId}|${k}`)]));
}

const shownContent = (m: WhiteboardMessage, known: Record<string, string | null | undefined>) => {
  const content = boardMessageContent(m);
  return content ? withMentionTitles(content, known) : null;
};

// ---- the colour of a pin ----

function PinColor({ value, onChange }: { value: CommentColor; onChange: (color: CommentColor) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const labels: Record<CommentColor, string> = {
    gray: t("Grau", "Grey"),
    brown: t("Braun", "Brown"),
    orange: t("Orange", "Orange"),
    yellow: t("Gelb", "Yellow"),
    green: t("Grün", "Green"),
    blue: t("Blau", "Blue"),
    purple: t("Lila", "Purple"),
    pink: t("Pink", "Pink"),
    red: t("Rot", "Red"),
  };
  return (
    <span className="comment-color-picker wb-comment-color">
      <button
        type="button"
        className="icon-button comment-color-toggle"
        aria-expanded={open}
        aria-label={t(`Farbe des Kommentars: ${labels[value]}`, `Comment colour: ${labels[value]}`)}
        title={t("Farbe des Kommentars", "Comment colour")}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="comment-color-swatch" data-comment-color={value} aria-hidden />
      </button>
      {open && (
        <span
          role="radiogroup"
          aria-label={t("Farbe des Kommentars", "Comment colour")}
          className="comment-color-choices"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {COMMENT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={color === value}
              aria-label={labels[color]}
              title={labels[color]}
              className="comment-color-choice"
              onClick={() => {
                setOpen(false);
                if (color !== value) onChange(color);
              }}
            >
              <span className="comment-color-swatch" data-comment-color={color} aria-hidden />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ---- the thread ----

export type BoardCommentActions = {
  // Adds a message; its id (null when nothing was added).
  send: (text: string, content: CommentNode | null) => string | null;
  resolve: () => void;
  remove: () => void;
  setColor: (color: CommentColor | undefined) => void;
  close: () => void;
  // Until the board's changes are on the server.
  flush: () => Promise<void>;
};

export function BoardCommentPopover({
  item,
  pageId,
  editable,
  guest,
  anchor,
  bounds,
  actions,
}: {
  item: WhiteboardItem;
  pageId: string;
  editable: boolean;
  guest: boolean;
  // Where the pin is, in the board's box (pixels).
  anchor: { x: number; y: number };
  bounds: { width: number; height: number };
  actions: BoardCommentActions;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState("");
  const [content, setContent] = useState<CommentNode | null>(null);
  const [plain, setPlain] = useState("");
  const [error, setError] = useState("");
  const messages = useMemo(() => item.messages || [], [item.messages]);
  const keys = useMemo(() => boardMentionKeys(messages.map(boardMessageContent)), [messages]);
  const known = useMentionTitles(pageId, keys, !guest);
  // Beside the pin, inside the board: moved up when it grows (replies,
  // attachments) past the board's bottom.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const place = () => {
      const width = el.offsetWidth || 340,
        height = el.offsetHeight || 0;
      el.style.setProperty("--wb-comment-left", `${Math.round(Math.max(8, Math.min(anchor.x + 8, bounds.width - width - 8)))}px`);
      el.style.setProperty("--wb-comment-top", `${Math.round(Math.max(8, Math.min(anchor.y, bounds.height - height - 8)))}px`);
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor.x, anchor.y, bounds.width, bounds.height]);
  const rich = editable && !guest;
  const label = messages.length ? t("Antworten", "Reply") : t("Kommentar schreiben", "Write a comment");
  async function submit() {
    setError("");
    if (!rich) {
      if (!plain.trim()) return;
      actions.send(plain, null);
      setPlain("");
      return;
    }
    if (!commentReady(body, content)) return;
    let stored: { content: CommentNode; text: string } | null = null;
    try {
      stored = content ? storedBoardMessage(content) : null;
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const files = stored?.content.attrs?.attachments || [];
    const text = stored?.text || body.trim() || files.map((f) => `📎 ${f.name}`).join(" ");
    const id = actions.send(text, stored?.content ?? null);
    setBody("");
    setContent(null);
    // "@Name": that person hears of it once the board has it.
    if (id && stored && commentMentions(stored.content).length) {
      await actions.flush();
      void fetch(`/api/whiteboards/${pageId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify: { item: item.id, message: id } }),
      }).catch(() => {});
    }
  }
  return (
    <div
      ref={root}
      className="wb-comment-popover"
      role="dialog"
      aria-label={t("Kommentar", "Comment||noun")}
      data-comment-color={boardCommentColor(item.commentColor)}
      onPointerDown={(e) => e.stopPropagation()}
      // Files dropped or pasted belong to the comment, not the board.
      onDrop={(e) => e.stopPropagation()}
      onDragOver={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !e.defaultPrevented) actions.close();
      }}
    >
      <div className="wb-comment-head">
        <strong>{item.resolved ? t("Erledigter Kommentar", "Resolved comment") : t("Kommentar", "Comment||noun")}</strong>
        {editable && !!messages.length && (
          <button type="button" onClick={actions.resolve}>
            {item.resolved ? t("Wieder öffnen", "Reopen") : t("Erledigt", "Resolve")}
          </button>
        )}
        {editable && (
          <button type="button" aria-label={t("Kommentar löschen", "Delete comment")} onClick={actions.remove}>
            <Trash size={14} />
          </button>
        )}
        <button type="button" aria-label={t("Kommentar schließen", "Close comment")} onClick={actions.close}>
          <X size={14} />
        </button>
      </div>
      <div className="wb-comment-thread">
        {messages.map((m) => (
          <div key={m.id} className="wb-comment-message">
            <span>
              <strong>{m.name}</strong>
              <small>
                {new Date(m.at).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </small>
            </span>
            <CommentBody content={shownContent(m, known)} body={m.text || ""} />
          </div>
        ))}
      </div>
      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {rich ? (
            <Suspense fallback={<div className="comment-input wb-comment-loading" aria-busy="true" />}>
              <CommentComposer
                label={label}
                pageId={pageId}
                body={body}
                content={content}
                autoFocus
                onChange={(text, next) => {
                  setBody(text);
                  setContent(next ?? null);
                }}
              />
            </Suspense>
          ) : (
            <textarea
              name="message"
              aria-label={label}
              placeholder={messages.length ? t("Antworten …", "Reply …") : t("Kommentar schreiben …", "Write a comment …")}
              value={plain}
              autoFocus
              onChange={(e) => setPlain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="wb-comment-actions">
            <PinColor value={boardCommentColor(item.commentColor)} onChange={(c) => actions.setColor(storedBoardCommentColor(c))} />
            <button className="button primary compact" disabled={rich ? !commentReady(body, content) : !plain.trim()}>
              {t("Senden", "Send")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---- the hover preview of a pin's badge ----

function Preview({
  item,
  pageId,
  guest,
  anchor,
  onOpen,
  onEnter,
  onLeave,
}: {
  item: WhiteboardItem;
  pageId: string;
  guest: boolean;
  anchor: Box;
  onOpen: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const root = useRef<HTMLButtonElement>(null);
  const messages = item.messages || [];
  const first = messages[0];
  const keys = useMemo(() => (first ? boardMentionKeys([boardMessageContent(first)]) : []), [first]);
  const known = useMentionTitles(pageId, keys, !guest);
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
  }, [anchor, item.id]);
  const replies = Math.max(0, messages.length - 1);
  return (
    <button
      ref={root}
      type="button"
      className="comment-preview wb-comment-preview"
      data-comment-color={boardCommentColor(item.commentColor)}
      tabIndex={-1}
      aria-label={t(`Kommentar von ${first?.name || "?"} öffnen`, `Open comment by ${first?.name || "?"}`)}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
    >
      <span className="comment-preview-author">
        <Avatar name={first?.name || "?"} small />
        <strong>{first?.name || t("Unbekannt", "Unknown")}</strong>
        {!!item.resolved && (
          <span className="comment-preview-resolved">
            <Check size={12} /> {t("Erledigt", "Resolved")}
          </span>
        )}
      </span>
      <span className="comment-preview-text">{first ? shortComment(boardMessageText(first, known)) : ""}</span>
      <small className="comment-preview-replies">
        {replies === 0 ? t("Keine Antworten", "No replies") : replies === 1 ? t("1 Antwort", "1 reply") : t(`${replies} Antworten`, `${replies} replies`)}
      </small>
    </button>
  );
}

// The preview shows after a moment over a pin with a mouse (not while its
// thread is open); leaving the pin and the card, a press or the wheel hide
// it. A click on the card opens the thread.
export function BoardCommentHover({
  svg,
  byId,
  pageId,
  guest,
  openId,
  onOpen,
}: {
  svg: RefObject<SVGSVGElement | null>;
  byId: Map<string, WhiteboardItem>;
  pageId: string;
  guest: boolean;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState<{ id: string; anchor: Box } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      const g = (e.target as Element | null)?.closest?.("[data-item]");
      const id = g?.getAttribute("data-item") || "";
      if (!g || byIdRef.current.get(id)?.type !== "comment") return;
      clear();
      timer.current = setTimeout(() => {
        const r = g.getBoundingClientRect();
        setHover({ id, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
      }, 350);
    };
    const out = (e: PointerEvent) => {
      const g = (e.target as Element | null)?.closest?.("[data-item]");
      if (!g || (e.relatedTarget instanceof Node && g.contains(e.relatedTarget))) return;
      clear();
      timer.current = setTimeout(() => setHover(null), 200);
    };
    const hide = () => {
      clear();
      setHover(null);
    };
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerout", out);
    el.addEventListener("pointerdown", hide);
    el.addEventListener("wheel", hide, { passive: true });
    return () => {
      clear();
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerout", out);
      el.removeEventListener("pointerdown", hide);
      el.removeEventListener("wheel", hide);
    };
  }, [svg]);
  const item = hover ? byId.get(hover.id) : undefined;
  if (!hover || !item || item.type !== "comment" || !item.messages?.length || openId === item.id) return null;
  return (
    <Preview
      item={item}
      pageId={pageId}
      guest={guest}
      anchor={hover.anchor}
      onEnter={clear}
      onLeave={() => {
        clear();
        timer.current = setTimeout(() => setHover(null), 200);
      }}
      onOpen={() => {
        setHover(null);
        onOpen(item.id);
      }}
    />
  );
}

// Attachments of comments that are gone from the board (a pin or message
// deleted – here or by someone else): once the board is saved, the server
// moves those this person uploaded to the file trash when nothing else uses
// them (lib/whiteboard-comments-server.ts). Only files of own messages.
export function useCommentFileCleanup({
  items,
  pageId,
  userId,
  enabled,
  flush,
}: {
  items: WhiteboardItem[];
  pageId: string;
  userId: string;
  enabled: boolean;
  flush: () => Promise<void>;
}) {
  const own = useMemo(() => {
    const files = new Set<string>();
    for (const item of items)
      if (item.type === "comment")
        for (const id of boardMessageFiles((item.messages || []).filter((m) => m.author === userId))) files.add(id);
    return files;
  }, [items, userId]);
  const previous = useRef<Set<string> | null>(null);
  const pending = useRef(new Set<string>());
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const before = previous.current;
    previous.current = own;
    if (!enabled || !before) return;
    for (const id of before) if (!own.has(id)) pending.current.add(id);
    // Back again (undo): nothing to do.
    for (const id of own) pending.current.delete(id);
    if (!pending.current.size) return;
    const timer = setTimeout(async () => {
      const files = [...pending.current];
      pending.current.clear();
      if (!files.length) return;
      await flushRef.current();
      void fetch(`/api/whiteboards/${pageId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trash: files.slice(0, 100) }),
      }).catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [own, enabled, pageId]);
}
