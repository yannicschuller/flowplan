import {
  richCommentSchema,
  mapCommentMentions,
  commentText,
} from "./comment-content";
import { z } from "zod";
import { all, run, id } from "./db";
import { withCommentDocument } from "./inline-comments";
import { commentAnchor, commentQuote, commentRange } from "./comment-positions";
import type { CommentAnchor } from "./inline-comment-types";
export const archivedThreadsSchema = z
  .array(
    z.object({
      row_id: z.uuid().nullable(),
      quote: z.string().min(1).max(4000),
      range: z
        .object({
          from: z.number().int().nonnegative(),
          to: z.number().int().nonnegative(),
          text: z.string().max(4000),
        })
        .nullable(),
      resolved: z.number().int().min(0).max(1),
      created_at: z.string().max(100),
      messages: z
        .array(
          z
            .object({
              name: z.string().max(500),
              body: z.string().max(5000),
              content: richCommentSchema.nullable().optional(),
              deleted: z.number().int().min(0).max(1),
              created_at: z.string().max(100),
              edited_at: z.string().max(100).nullable(),
              reactions: z
                .array(
                  z.object({
                    emoji: z.string().max(64),
                    names: z.array(z.string().max(500)).max(10000),
                  }),
                )
                .max(50),
            })
            .superRefine((message, ctx) => {
              if (
                !message.deleted &&
                message.content &&
                message.body !== commentText(message.content).trim()
              )
                ctx.addIssue({
                  code: "custom",
                  message:
                    "Kommentartext und Formatierung stimmen nicht überein.",
                });
            }),
        )
        .max(500),
    }),
  )
  .max(10000);
export type ArchivedThreads = z.infer<typeof archivedThreadsSchema>;
// Call only after the containing page's export permission has been checked.
export function exportInlineComments(pageId: string): ArchivedThreads {
  const threads = all<{
    id: string;
    row_id: string | null;
    anchor: string;
    resolved: number;
    created_at: string;
  }>(
    "SELECT * FROM inline_threads WHERE page_id=? ORDER BY created_at,id",
    pageId,
  );
  const ranges = new Map<string, ArchivedThreads[number]["range"]>();
  // Decode each document once, even when hundreds of threads share it.
  for (const rowId of new Set(threads.map((t) => t.row_id))) {
    try {
      withCommentDocument(pageId, rowId, (binding, generation) => {
        for (const t of threads.filter((t) => t.row_id === rowId)) {
          const r = commentRange(binding, JSON.parse(t.anchor), generation),
            text = r ? commentQuote(binding.content, r.from, r.to) : "";
          ranges.set(t.id, r && text.length <= 4000 ? { ...r, text } : null);
        }
      });
    } catch {
      /* Missing documents retain their quoted discussions as detached. */
    }
  }
  return threads.map((t) => {
    const anchor = JSON.parse(t.anchor) as CommentAnchor;
    return {
      row_id: t.row_id,
      quote: anchor.quote,
      range: ranges.get(t.id) || null,
      resolved: t.resolved,
      created_at: t.created_at,
      messages: all<{
        id: string;
        name: string;
        body: string;
        rich_body: string | null;
        deleted: number;
        created_at: string;
        edited_at: string | null;
        imported_reactions: string;
      }>(
        "SELECT m.*,COALESCE(u.name,m.author_name) name FROM inline_messages m LEFT JOIN users u ON u.id=m.author_id WHERE thread_id=? ORDER BY m.created_at,m.rowid",
        t.id,
      ).map((m) => {
        const live = all<{ emoji: string; name: string }>(
          "SELECT r.emoji,u.name FROM inline_reactions r JOIN users u ON u.id=r.user_id WHERE message_id=? ORDER BY r.emoji,u.name",
          m.id,
        );
        const historical: { emoji: string; names: string[] }[] = JSON.parse(
          m.imported_reactions,
        );
        const reactions = Array.from(
          new Set([
            ...live.map((r) => r.emoji),
            ...historical.map((r) => r.emoji),
          ]),
        ).map((emoji) => ({
          emoji,
          names: [
            ...live.filter((r) => r.emoji === emoji).map((r) => r.name),
            ...historical
              .filter((r) => r.emoji === emoji)
              .flatMap((r) => r.names),
          ],
        }));
        return {
          name: m.name,
          body: m.deleted ? "" : m.body,
          content:
            m.deleted || !m.rich_body
              ? null
              : richCommentSchema.parse(JSON.parse(m.rich_body)),
          deleted: m.deleted,
          created_at: m.created_at,
          edited_at: m.edited_at,
          reactions: m.deleted ? [] : reactions,
        };
      }),
    };
  });
}
export function importInlineComments(
  pageId: string,
  threads: ArchivedThreads,
  rowMap: Map<string, string>,
  ownerId: string,
) {
  for (const t of threads) {
    const rowId = t.row_id ? rowMap.get(t.row_id)! : null;
    let anchor: CommentAnchor = {
      generation: "detached-import",
      quote: t.quote,
      positions: { anchor: { tname: "default" }, head: { tname: "default" } },
    };
    if (t.range)
      try {
        anchor = withCommentDocument(pageId, rowId, (binding, generation) => {
          const r = t.range!;
          if (
            r.from >= r.to ||
            r.to > binding.content.content.size ||
            commentQuote(binding.content, r.from, r.to) !== r.text
          )
            return anchor;
          return {
            ...commentAnchor(binding, r.from, r.to, generation),
            quote: t.quote,
          };
        });
      } catch {
        /* Never guess an anchor in changed import content. */
      }
    const tid = id();
    run(
      "INSERT INTO inline_threads(id,page_id,row_id,author_id,anchor,resolved,created_at) VALUES(?,?,?,?,?,?,?)",
      tid,
      pageId,
      rowId,
      ownerId,
      JSON.stringify(anchor),
      t.resolved,
      t.created_at,
    );
    for (const m of t.messages)
      run(
        "INSERT INTO inline_messages(id,thread_id,author_id,author_name,body,deleted,created_at,edited_at,imported_reactions,rich_body) VALUES(?,?,NULL,?,?,?,?,?,?,?)",
        id(),
        tid,
        m.name,
        m.deleted ? "" : m.body,
        m.deleted,
        m.created_at,
        m.edited_at,
        JSON.stringify(m.deleted ? [] : m.reactions),
        m.deleted || !m.content
          ? null
          : JSON.stringify(
              mapCommentMentions(m.content, (_id, label) => ({
                userId: null,
                label,
              })),
            ),
      );
  }
}
