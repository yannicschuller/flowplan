// Comment pins on whiteboards (#455): the same comment content as page and
// text comments (#450, lib/comment-content.ts) – formatting, people and
// pages mentioned, links with previews, attachments – and a colour per pin.
//
// The pins stay in the board's Yjs document (live for everyone, undo,
// guests of edit links, private mode), so everything here is checked when
// it is read, never trusted as stored:
//
// - A message keeps its plain `text` (search, summaries, guests, older
//   clients) and, when formatted, `content`: normalizeCommentContent()
//   rebuilds it on every read; anything it refuses shows as the plain text.
// - Page mentions are stored without their title (the raw board is readable
//   by everyone on it): each reader gets the titles of what they may read
//   from GET /api/whiteboards/<id>/comments?mentions=… (mentionReader, as
//   page comments), "Kein Zugriff" for the rest.
// - Attachments are uploads of the board (purpose=comment, served to
//   whoever may read it). Deleting a pin or a message asks the server to
//   move its files to the file trash when nothing else uses them
//   (lib/comment-extras.ts trashDroppedAttachments).
// - "@Name" notifies that person once, if they may read the board
//   (POST …/comments {notify}), as page comments do.
//
// Authors edit and delete their own messages (#455, as page comments since
// #450): an edit replaces the message (same id, `edited` set) and tells
// people it newly mentions; deleting the first message of a pin with
// replies leaves a "Kommentar gelöscht" placeholder, deleting the last
// message left removes the pin. Guests of edit links write under one
// identity per link, not per person, so they cannot edit or delete.
//
// The colour is a name of lib/comment-colors.ts' palette (who may edit the
// board may change it, as editors may for text comment threads); a pin
// without one keeps the orange pins always had. Client-safe.
import {
  attachmentFileId,
  commentAttachments,
  commentText,
  normalizeCommentContent,
  type CommentNode,
} from "./comment-content";
import { COMMENT_COLORS, type CommentColor } from "./comment-colors";
import type { WhiteboardItem, WhiteboardMessage } from "./whiteboard-model";

// The pin's colour: orange – the colour pins always had – unless another
// one is stored.
export const DEFAULT_BOARD_COMMENT_COLOR: CommentColor = "orange";
export function boardCommentColor(value: unknown): CommentColor {
  return typeof value === "string" && (COMMENT_COLORS as readonly string[]).includes(value) ? (value as CommentColor) : DEFAULT_BOARD_COMMENT_COLOR;
}
// What is stored for a choice (nothing for the default).
export const storedBoardCommentColor = (color: CommentColor) => (color === DEFAULT_BOARD_COMMENT_COLOR ? undefined : color);
// Badge fill and number colour per palette name (strong enough for a small
// white number; yellow takes a dark one).
export const BOARD_COMMENT_BADGE: Record<CommentColor, { fill: string; text: string }> = {
  gray: { fill: "#868e96", text: "#ffffff" },
  brown: { fill: "#99582a", text: "#ffffff" },
  orange: { fill: "#f08c00", text: "#ffffff" },
  yellow: { fill: "#fcc419", text: "#3d2e00" },
  green: { fill: "#2f9e44", text: "#ffffff" },
  blue: { fill: "#1c7ed6", text: "#ffffff" },
  purple: { fill: "#7048e8", text: "#ffffff" },
  pink: { fill: "#d6336c", text: "#ffffff" },
  red: { fill: "#e03131", text: "#ffffff" },
};
export const boardCommentBadge = (item: Pick<WhiteboardItem, "commentColor">) => BOARD_COMMENT_BADGE[boardCommentColor(item.commentColor)];

// The formatted content of a message, rebuilt; null when it has none or it
// is not valid (the plain text shows then).
export function boardMessageContent(message: Pick<WhiteboardMessage, "content">): CommentNode | null {
  if (message.content == null) return null;
  try {
    return normalizeCommentContent(message.content);
  } catch {
    return null;
  }
}

// What goes into the board for a new message: page mentions without their
// title, attachments without the reader's `missing`, and the plain text
// that goes with it.
export function storedBoardMessage(content: CommentNode): { content: CommentNode; text: string } {
  const strip = (node: CommentNode): CommentNode => {
    if (node.type === "pageMention" && node.attrs?.pageId)
      return { type: "pageMention", attrs: { pageId: node.attrs.pageId, ...(node.attrs.rowId ? { rowId: node.attrs.rowId } : {}), label: "" } };
    const next: CommentNode = { ...node };
    if (node.content) next.content = node.content.map(strip);
    if (node.type === "doc" && node.attrs?.attachments)
      next.attrs = { ...node.attrs, attachments: node.attrs.attachments.map(({ missing: _m, ...a }) => (void _m, a)) };
    return next;
  };
  const stored = normalizeCommentContent(strip(content));
  return { content: stored, text: commentText(stored).trim().slice(0, 5000) };
}

// "<page>" or "<page>:<record>" of the pages a message mentions.
export function boardMentionKeys(contents: (CommentNode | null)[]): string[] {
  const keys = new Set<string>();
  const visit = (n: CommentNode) => {
    if (n.type === "pageMention" && n.attrs?.pageId) keys.add(n.attrs.rowId ? `${n.attrs.pageId}:${n.attrs.rowId}` : n.attrs.pageId);
    n.content?.forEach(visit);
  };
  contents.forEach((c) => c && visit(c));
  return [...keys];
}
// The content as this reader sees it: titles of what they may read
// (`titles[key]` a string), "no access" for the rest (null); not yet known
// (undefined): "…".
export function withMentionTitles(content: CommentNode, titles: Record<string, string | null | undefined>): CommentNode {
  const visit = (n: CommentNode): CommentNode => {
    if (n.type === "pageMention" && n.attrs?.pageId) {
      const key = n.attrs.rowId ? `${n.attrs.pageId}:${n.attrs.rowId}` : n.attrs.pageId;
      const title = titles[key];
      return {
        ...n,
        attrs: { ...n.attrs, label: title === undefined ? "…" : title || "", ...(title === null ? { noAccess: true } : {}) },
      };
    }
    return n.content ? { ...n, content: n.content.map(visit) } : n;
  };
  return visit(content);
}
// The plain text of a message as this reader sees it (previews).
export function boardMessageText(message: Pick<WhiteboardMessage, "text" | "content">, titles: Record<string, string | null | undefined> = {}) {
  const content = boardMessageContent(message);
  return content ? commentText(withMentionTitles(content, titles)).trim() || message.text || "" : message.text || "";
}

// The ids of the files the messages carry.
export function boardMessageFiles(messages: Pick<WhiteboardMessage, "content">[]): string[] {
  const ids = new Set<string>();
  for (const m of messages)
    for (const a of commentAttachments(boardMessageContent(m))) {
      const id = attachmentFileId(a.src);
      if (id) ids.add(id);
    }
  return [...ids];
}

// ---- editing and deleting own messages ----

// Whether this person may edit and delete the message: its author, signed
// in (guests of edit links share one identity per link), not a placeholder.
export const mayChangeBoardMessage = (message: Pick<WhiteboardMessage, "author" | "deleted">, userId: string | undefined) =>
  !!userId && !userId.startsWith("guest:") && message.author === userId && !message.deleted;

// The message after its author edited it.
export function editedBoardMessage(message: WhiteboardMessage, text: string, content: CommentNode | null, now = Date.now()): WhiteboardMessage {
  const { content: _old, ...rest } = message;
  return { ...rest, text: text.trim().slice(0, 5000), ...(content ? { content } : {}), edited: now };
}

// What deleting a message leaves: the list without it – the first message
// of a thread with replies stays as a placeholder – or null when nothing
// is left and the pin goes.
export function withoutBoardMessage(messages: WhiteboardMessage[], messageId: string): WhiteboardMessage[] | null {
  const index = messages.findIndex((m) => m.id === messageId);
  if (index < 0) return messages;
  const next = messages.slice();
  const m = messages[index];
  if (index === 0 && messages.length > 1) next[0] = { id: m.id, author: m.author, name: m.name, text: "", at: m.at, deleted: true };
  else next.splice(index, 1);
  return next.some((x) => !x.deleted) ? next : null;
}
