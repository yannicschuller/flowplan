// The server's part of comment pins on whiteboards (#455,
// lib/whiteboard-comments.ts): titles of mentioned pages for one reader,
// notifying mentioned people, and moving the files of deleted comments to
// the file trash. Browser sessions only
// (app/api/whiteboards/[id]/comments/handler.ts).
import * as Y from "yjs";
import { HttpError } from "./auth";
import { id, one, run } from "./db";
import { requirePage, isGuest } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { commentMentions, type CommentNode } from "./comment-content";
import { attachmentNote, mentionReader, trashDroppedAttachments } from "./comment-extras";
import { mayHear } from "./comment-recipients";
import { mentionWebhook } from "./webhooks";
import { parseTargetKey } from "./link-targets";
import { boardMessageContent } from "./whiteboard-comments";
import type { WhiteboardMessage } from "./whiteboard-model";
import type { Identity, Page } from "./types";

export const MENTION_KEYS_LIMIT = 100;
// A message notifies only while it is new (a later call is a replay).
export const NOTIFY_WINDOW_MS = 15 * 60 * 1000;

async function board(user: Identity, pageId: string): Promise<Page> {
  const page = await requirePage(user, pageId);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  await requireUnlocked(user, page);
  return page;
}

// Titles of the mentioned pages and records this person may read; null for
// the others (shown as "Kein Zugriff", never with a title).
export async function boardMentionTitles(user: Identity, pageId: string, keys: string[]): Promise<Record<string, string | null>> {
  const page = await board(user, pageId);
  const read = mentionReader(user, page.workspace_id);
  const out: Record<string, string | null> = {};
  for (const key of [...new Set(keys)].slice(0, MENTION_KEYS_LIMIT)) {
    const target = parseTargetKey(key);
    if (!target) continue;
    out[key] = (await read(target.pageId, target.rowId))?.title ?? null;
  }
  return out;
}

// The message as the board stores it now (the shared board; a private
// writer's messages are not there yet).
async function storedMessage(page: Page, itemId: string, messageId: string): Promise<WhiteboardMessage | null> {
  const row = await one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", page.id);
  if (!row) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, row.state);
    const item = doc.getMap<Y.Map<unknown>>("items").get(itemId);
    if (!(item instanceof Y.Map) || item.get("type") !== "comment") return null;
    const messages = item.get("messages");
    const list = (messages instanceof Y.Array ? messages.toArray() : Array.isArray(messages) ? messages : []) as WhiteboardMessage[];
    return list.find((m) => m && typeof m === "object" && m.id === messageId) || null;
  } finally {
    doc.destroy();
  }
}

// Notified messages (per process; with the time window a repeated call
// notifies nobody twice).
const notified = new Map<string, number>();
// The people a new message mentions hear of it once – only who may read the
// board, never the author; guests of the workspace mention nobody (as page
// comments). Returns how many were notified.
export async function notifyBoardMentions(user: Identity, pageId: string, itemId: string, messageId: string): Promise<number> {
  const page = await board(user, pageId);
  const key = `${page.id}:${itemId}:${messageId}`;
  const now = Date.now();
  for (const [k, at] of notified) if (now - at > NOTIFY_WINDOW_MS) notified.delete(k);
  if (notified.has(key)) return 0;
  const message = await storedMessage(page, itemId, messageId);
  if (!message || message.author !== user.id || !(now - Number(message.at) < NOTIFY_WINDOW_MS)) return 0;
  notified.set(key, now);
  if (await isGuest(user, page.workspace_id)) return 0;
  const content = boardMessageContent(message);
  let count = 0;
  for (const recipient of commentMentions(content)) {
    if (recipient === user.id || !(await mayHear(recipient, page, null))) continue;
    await run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,?)",
      id(),
      recipient,
      `${user.name} hat dich in einem Kommentar in „${page.title}“ erwähnt` + attachmentNote(content),
      page.id,
      null,
      "mention",
    );
    await mentionWebhook(page.workspace_id, page.id, null, recipient, user.name, user.id);
    count++;
  }
  return count;
}

// Files of deleted comments or messages: those this person uploaded to the
// board that nothing in the workspace uses any more go to the file trash
// (restorable until the trash period ends).
export async function trashBoardCommentFiles(user: Identity, pageId: string, fileIds: string[]): Promise<string[]> {
  const page = await board(user, pageId);
  const before: CommentNode = {
    type: "doc",
    content: [],
    attrs: { attachments: [...new Set(fileIds)].slice(0, 100).map((fileId) => ({ src: `/api/files/${fileId}`, name: "", mime: "", size: 0 })) },
  };
  return await trashDroppedAttachments(user, page, before, null);
}
