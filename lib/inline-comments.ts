import {
  richCommentSchema,
  commentText,
  commentMentions,
  mapCommentMentions,
  commentContentIdentity,
  type CommentNode,
} from "./comment-content";
import { z } from "zod";
import * as Y from "yjs";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import { all, one, run, id } from "./db";
import { requirePage, pageRole } from "./permissions";
import { HttpError } from "./auth";
import { requireRow, ensureRowDocument } from "./row-documents";
import { documentSchema } from "./document-schema";
import {
  commentAnchorSchema,
  type InlineThread,
  type InlineMessage,
  type CommentAnchor,
} from "./inline-comment-types";
import {
  commentRange,
  commentQuote,
  type CommentBinding,
} from "./comment-positions";
import { emojiEntries } from "./emoji-data";
import type { Identity, Page } from "./types";
const emojis = new Set(emojiEntries.map((e) => e.emoji));
const bodySchema = z.string().trim().min(1).max(5000);
const versionSchema = z.number().int().positive();
type StoredThread = Omit<InlineThread, "anchor" | "messages" | "canResolve"> & {
  anchor: string;
};
type StoredMessage = Omit<InlineMessage, "reactions" | "name"> & {
  thread_id: string;
  rich_body: string | null;
  author_name: string;
};
function scope(user: Identity, pageId: string, rowId?: string) {
  const page = requirePage(user, pageId);
  if (rowId) requireRow(user, pageId, rowId);
  else if (page.kind !== "document")
    throw new HttpError(400, "Bitte einen Datensatz auswählen.");
  return page;
}
export function withCommentDocument<T>(
  pageId: string,
  rowId: string | null,
  fn: (binding: CommentBinding, generation: string) => T,
): T {
  const stored = one<{ state: Uint8Array; generation: string }>(
    rowId
      ? "SELECT state,generation FROM row_documents WHERE row_id=?"
      : "SELECT state,generation FROM documents WHERE page_id=?",
    rowId || pageId,
  );
  if (!stored?.state)
    throw new HttpError(409, "Das Dokument ist noch nicht gespeichert.");
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored.state);
    const type = doc.getXmlFragment("default"),
      result = initProseMirrorDoc(type, documentSchema());
    return fn(
      { doc, type, mapping: result.mapping, content: result.doc },
      stored.generation,
    );
  } finally {
    doc.destroy();
  }
}
export function inlineThreads(
  user: Identity,
  pageId: string,
  rowId?: string,
  summaries = false,
  detailId?: string,
): InlineThread[] {
  const page = scope(user, pageId, rowId),
    canEdit = pageRole(user, page) !== "viewer";
  return all<StoredThread>(
    "SELECT * FROM inline_threads WHERE page_id=? AND row_id IS ? ORDER BY created_at,id",
    pageId,
    rowId || null,
  ).map((t) => ({
    ...t,
    anchor: {
      ...JSON.parse(t.anchor),
      quote: JSON.parse(t.anchor).quote.slice(
        0,
        summaries && t.id !== detailId ? 240 : 4000,
      ),
    },
    messageCount: Number(
      one<{ n: number }>(
        "SELECT count(*) n FROM inline_messages WHERE thread_id=?",
        t.id,
      )?.n || 0,
    ),
    complete: !summaries || t.id === detailId,
    canResolve: canEdit || t.author_id === user.id,
    messages: all<StoredMessage & { name: string; imported_reactions: string }>(
      `SELECT m.*,COALESCE(u.name,m.author_name) name FROM inline_messages m LEFT JOIN users u ON u.id=m.author_id WHERE thread_id=? ORDER BY m.created_at,m.rowid ${summaries && t.id !== detailId ? "LIMIT 1" : ""}`,
      t.id,
    ).map((m) => {
      const reactions =
        summaries && t.id !== detailId
          ? []
          : all<{ emoji: string; user_id: string; name: string }>(
              "SELECT r.emoji,r.user_id,u.name FROM inline_reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=? ORDER BY r.emoji,u.name",
              m.id,
            );
      const imported: { emoji: string; names: string[] }[] =
        summaries && t.id !== detailId ? [] : JSON.parse(m.imported_reactions);
      return {
        id: m.id,
        content:
          m.deleted || (summaries && t.id !== detailId) || !m.rich_body
            ? null
            : richCommentSchema.parse(JSON.parse(m.rich_body)),
        author_id: m.author_id,
        name: m.name,
        body: m.deleted
          ? ""
          : m.body.slice(0, summaries && t.id !== detailId ? 160 : 5000),
        version: m.version,
        deleted: m.deleted,
        created_at: m.created_at,
        edited_at: m.edited_at,
        reactions: Array.from(
          new Set([
            ...reactions.map((r) => r.emoji),
            ...imported.map((r) => r.emoji),
          ]),
        ).map((emoji) => {
          const members = reactions.filter((r) => r.emoji === emoji);
          const historic = imported
            .filter((r) => r.emoji === emoji)
            .flatMap((r) => r.names);
          return {
            emoji,
            count: members.length + historic.length,
            mine: members.some((r) => r.user_id === user.id),
            names: [
              ...members.map((r) => r.name),
              ...historic.map((n) => `Import · ${n}`),
            ].slice(0, 30),
          };
        }),
      };
    }),
  }));
}
export function inlineMentionCandidates(
  user: Identity,
  pageId: string,
  rowId?: string,
  query = "",
) {
  const page = scope(user, pageId, rowId),
    search = z.string().max(100).parse(query).trim().toLocaleLowerCase();
  const matches: { id: string; name: string; email: string }[] = [];
  for (const member of all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,COALESCE(u.email,'') email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND u.disabled=0 ORDER BY u.name,u.id",
    page.workspace_id,
  )) {
    if (
      (member.name.toLocaleLowerCase().includes(search) ||
        member.email.toLocaleLowerCase().includes(search)) &&
      pageRole({ ...user, id: member.id }, page)
    )
      matches.push({ ...member, name: member.name.slice(0, 200) });
    if (matches.length === 100) break;
  }
  return matches;
}
function messageInput(input: Record<string, unknown>, page: Page) {
  let content: CommentNode | null =
    input.content == null ? null : richCommentSchema.parse(input.content);
  if (content)
    content = mapCommentMentions(content, (userId, label) => {
      if (!userId) return { userId: null, label };
      const member = one<{ id: string; name: string }>(
        "SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE u.id=? AND m.workspace_id=? AND u.disabled=0",
        userId,
        page.workspace_id,
      );
      if (!member || !pageRole({ id: userId } as Identity, page))
        throw new HttpError(
          400,
          "Eine erwähnte Person hat keinen Zugriff mehr. Bitte entferne die Erwähnung oder wähle eine berechtigte Person.",
        );
      return { userId, label: member.name.slice(0, 200) };
    });
  if (content) content = richCommentSchema.parse(content);
  const body = bodySchema.parse(content ? commentText(content) : input.body);
  return {
    body,
    content,
    serialized: content ? JSON.stringify(content) : null,
  };
}
function sameMessage(
  old: StoredMessage,
  next: ReturnType<typeof messageInput>,
) {
  return old.rich_body && next.content
    ? commentContentIdentity(JSON.parse(old.rich_body)) ===
        commentContentIdentity(next.content)
    : !old.rich_body && !next.content && old.body === next.body;
}
function notify(
  user: Identity,
  page: Page,
  threadId: string,
  first: boolean,
  mentions: string[] = [],
  onlyMentions = false,
) {
  const target = one<{ row_id: string | null }>(
    "SELECT row_id FROM inline_threads WHERE id=?",
    threadId,
  );
  const recipients = onlyMentions
    ? []
    : first
      ? all<{ user_id: string }>(
          "SELECT user_id FROM members WHERE workspace_id=?",
          page.workspace_id,
        ).map((m) => m.user_id)
      : all<{ author_id: string }>(
          "SELECT DISTINCT author_id FROM inline_messages WHERE thread_id=? AND author_id IS NOT NULL",
          threadId,
        ).map((m) => m.author_id);
  for (const uid of new Set([...recipients, ...mentions]))
    if (
      uid !== user.id &&
      one("SELECT id FROM users WHERE id=? AND disabled=0", uid) &&
      pageRole({ ...user, id: uid }, page)
    )
      run(
        "INSERT INTO notifications(id,user_id,body,page_id,row_id,thread_id,kind) VALUES(?,?,?,?,?,?,?)",
        id(),
        uid,
        mentions.includes(uid)
          ? `${user.name} hat dich in einem Kommentar in „${page.title}“ erwähnt`
          : `${user.name} ${first ? "kommentiert eine Textstelle in" : "antwortet auf einen Kommentar in"} „${page.title}“`,
        page.id,
        target?.row_id || null,
        threadId,
        mentions.includes(uid) ? "mention" : "comment",
      );
}
export function inlineCommentCommand(
  user: Identity,
  input: Record<string, unknown>,
) {
  const pageId = z.uuid().parse(input.pageId),
    rowId = input.rowId ? z.uuid().parse(input.rowId) : undefined;
  const page = scope(user, pageId, rowId),
    action = input.action;
  if (action === "thread.create") {
    const threadId = z.uuid().parse(input.threadId),
      messageId = z.uuid().parse(input.messageId),
      messageInputValue = messageInput(input, page),
      { body } = messageInputValue,
      anchor = commentAnchorSchema.parse(input.anchor);
    const existing = one<StoredThread>(
      "SELECT * FROM inline_threads WHERE id=?",
      threadId,
    );
    if (existing) {
      const message = one<StoredMessage>(
        "SELECT * FROM inline_messages WHERE id=? AND thread_id=?",
        messageId,
        threadId,
      );
      if (
        existing.page_id === pageId &&
        existing.row_id === (rowId || null) &&
        existing.author_id === user.id &&
        message &&
        sameMessage(message, messageInputValue) &&
        existing.anchor === JSON.stringify(anchor)
      )
        return { id: threadId };
      throw new HttpError(
        409,
        "Dieser Kommentar wurde bereits anders gespeichert.",
      );
    }
    if (
      Number(
        one<{ n: number }>(
          "SELECT count(*) n FROM inline_threads WHERE page_id=? AND row_id IS ?",
          pageId,
          rowId || null,
        )?.n,
      ) >= 500
    )
      throw new HttpError(409, "Maximal 500 Textkommentare pro Dokument.");
    if (rowId) ensureRowDocument(requireRow(user, pageId, rowId).row);
    withCommentDocument(pageId, rowId || null, (binding, generation) => {
      const range = commentRange(binding, anchor, generation);
      if (
        !range ||
        commentQuote(binding.content, range.from, range.to) !== anchor.quote
      )
        throw new HttpError(
          409,
          "Die ausgewählte Textstelle hat sich geändert. Bitte erneut auswählen; dein Entwurf bleibt erhalten.",
        );
    });
    run(
      "INSERT INTO inline_threads(id,page_id,row_id,author_id,anchor) VALUES(?,?,?,?,?)",
      threadId,
      pageId,
      rowId || null,
      user.id,
      JSON.stringify(anchor),
    );
    run(
      "INSERT INTO inline_messages(id,thread_id,author_id,author_name,body,rich_body) VALUES(?,?,?,?,?,?)",
      messageId,
      threadId,
      user.id,
      user.name,
      body,
      messageInputValue.serialized,
    );
    notify(
      user,
      page,
      threadId,
      true,
      commentMentions(messageInputValue.content),
    );
    return { id: threadId };
  }
  const threadId = z.uuid().parse(input.threadId),
    thread = one<StoredThread>(
      "SELECT * FROM inline_threads WHERE id=? AND page_id=? AND row_id IS ?",
      threadId,
      pageId,
      rowId || null,
    );
  if (!thread) throw new HttpError(404, "Kommentar nicht gefunden.");
  if (action === "thread.resolve") {
    if (thread.author_id !== user.id && pageRole(user, page) === "viewer")
      throw new HttpError(
        403,
        "Nur Verfasser oder Bearbeiter können diesen Thread abschließen.",
      );
    if (thread.version !== versionSchema.parse(input.version))
      throw new HttpError(
        409,
        "Der Thread wurde geändert. Bitte prüfe die neueste Antwort.",
      );
    run(
      "UPDATE inline_threads SET resolved=?,version=version+1 WHERE id=?",
      z.boolean().parse(input.resolved) ? 1 : 0,
      thread.id,
    );
  } else if (action === "thread.reply") {
    const messageId = z.uuid().parse(input.messageId),
      messageInputValue = messageInput(input, page),
      { body } = messageInputValue;
    const old = one<StoredMessage>(
      "SELECT * FROM inline_messages WHERE id=?",
      messageId,
    );
    if (old) {
      if (
        old.thread_id === thread.id &&
        old.author_id === user.id &&
        sameMessage(old, messageInputValue)
      )
        return { id: messageId };
      throw new HttpError(
        409,
        "Diese Antwort wurde bereits anders gespeichert.",
      );
    }
    if (thread.resolved)
      throw new HttpError(409, "Bitte den Thread zuerst wieder öffnen.");
    if (
      Number(
        one<{ n: number }>(
          "SELECT count(*) n FROM inline_messages WHERE thread_id=?",
          thread.id,
        )?.n,
      ) >= 500
    )
      throw new HttpError(409, "Maximal 500 Antworten pro Thread.");
    run(
      "INSERT INTO inline_messages(id,thread_id,author_id,author_name,body,rich_body) VALUES(?,?,?,?,?,?)",
      messageId,
      thread.id,
      user.id,
      user.name,
      body,
      messageInputValue.serialized,
    );
    run("UPDATE inline_threads SET version=version+1 WHERE id=?", thread.id);
    notify(
      user,
      page,
      thread.id,
      false,
      commentMentions(messageInputValue.content),
    );
  } else {
    const messageId = z.uuid().parse(input.messageId),
      message = one<StoredMessage>(
        "SELECT * FROM inline_messages WHERE id=? AND thread_id=?",
        messageId,
        thread.id,
      );
    if (!message || message.deleted)
      throw new HttpError(404, "Antwort nicht gefunden.");
    if (action === "thread.react") {
      const emoji = z
        .string()
        .max(64)
        .refine((e) => emojis.has(e), "Bitte ein Emoji auswählen.")
        .parse(input.emoji);
      if (z.boolean().parse(input.active)) {
        if (
          Number(
            one<{ n: number }>(
              "SELECT count(DISTINCT emoji) n FROM inline_reactions WHERE message_id=?",
              messageId,
            )?.n,
          ) >= 50 &&
          !one(
            "SELECT 1 FROM inline_reactions WHERE message_id=? AND emoji=?",
            messageId,
            emoji,
          )
        )
          throw new HttpError(409, "Maximal 50 unterschiedliche Reaktionen.");
        run(
          "INSERT OR IGNORE INTO inline_reactions VALUES(?,?,?)",
          messageId,
          user.id,
          emoji,
        );
      } else
        run(
          "DELETE FROM inline_reactions WHERE message_id=? AND user_id=? AND emoji=?",
          messageId,
          user.id,
          emoji,
        );
    } else if (action === "thread.edit" || action === "thread.deleteMessage") {
      if (message.author_id !== user.id)
        throw new HttpError(
          403,
          "Nur eigene Kommentare können geändert werden.",
        );
      if (message.version !== versionSchema.parse(input.version))
        throw new HttpError(
          409,
          "Dieser Kommentar wurde inzwischen geändert. Dein Entwurf bleibt erhalten.",
        );
      const edited =
        action === "thread.edit"
          ? messageInput(input, page)
          : { body: "", content: null, serialized: null };
      run(
        "UPDATE inline_messages SET body=?,rich_body=?,deleted=?,version=version+1,edited_at=CURRENT_TIMESTAMP WHERE id=?",
        edited.body,
        edited.serialized,
        action === "thread.edit" ? 0 : 1,
        messageId,
      );
      if (action === "thread.edit") {
        const before = commentMentions(
          message.rich_body ? JSON.parse(message.rich_body) : null,
        );
        notify(
          user,
          page,
          thread.id,
          false,
          commentMentions(edited.content).filter(
            (uid) => !before.includes(uid),
          ),
          true,
        );
      }
      if (action === "thread.deleteMessage")
        run("DELETE FROM inline_reactions WHERE message_id=?", messageId);
      run("UPDATE inline_threads SET version=version+1 WHERE id=?", thread.id);
    } else throw new HttpError(400, "Unbekannte Kommentaraktion.");
  }
  return { ok: true };
}
