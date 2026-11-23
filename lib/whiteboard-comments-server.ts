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
// A message notifies only while it is new – written or edited this long ago
// at most (a later call is a replay).
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

// Who was told of which message lives in whiteboard_mention_notices (schema
// 127): one row per board, message and person, kept BOARD_MENTION_KEEP_DAYS.
export const BOARD_MENTION_KEEP_DAYS = 400;
const DAY = 86_400_000;
let lastPrune = 0;
async function pruneMentionNotices(now: number) {
  if (now - lastPrune < DAY) return;
  lastPrune = now;
  await run("DELETE FROM whiteboard_mention_notices WHERE notified_at<?", now - BOARD_MENTION_KEEP_DAYS * DAY);
}
// The people a message mentions hear of it once – only who may read the
// board, never the author; guests of the workspace mention nobody (as page
// comments). Called after a message was written or edited: an edit tells
// only those it newly mentions. A message notifies only while it is new
// (written or edited within NOTIFY_WINDOW_MS). Returns how many were
// notified.
export async function notifyBoardMentions(user: Identity, pageId: string, itemId: string, messageId: string): Promise<number> {
  const page = await board(user, pageId);
  const now = Date.now();
  await pruneMentionNotices(now);
  const message = await storedMessage(page, itemId, messageId);
  if (!message || message.author !== user.id || message.deleted) return 0;
  const changed = Math.max(Number(message.at) || 0, Number(message.edited) || 0);
  if (!(now - changed < NOTIFY_WINDOW_MS)) return 0;
  if (await isGuest(user, page.workspace_id)) return 0;
  const content = boardMessageContent(message);
  let count = 0;
  for (const recipient of commentMentions(content)) {
    if (recipient === user.id || !(await mayHear(recipient, page, null))) continue;
    // Told before (this message, before an edit, or a replayed call).
    const fresh = await run(
      "INSERT INTO whiteboard_mention_notices(page_id,message_id,user_id,notified_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      page.id,
      messageId,
      recipient,
      now,
    );
    if (!Number(fresh.changes)) continue;
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
