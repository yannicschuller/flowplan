"use client";
import { richCommentSchema, type CommentNode } from "./comment-content";
import { z } from "zod";
const schema = z.object({
  time: z.number(),
  body: z.string().max(5000),
  content: richCommentSchema.nullable().optional(),
  replies: z.record(
    z.uuid(),
    z.object({
      id: z.uuid(),
      body: z.string().max(5000),
      content: richCommentSchema.nullable().optional(),
    }),
  ),
});
export function readCommentDrafts(key: string): z.infer<typeof schema> {
  const empty = { time: Date.now(), body: "", replies: {} };
  try {
    if (typeof sessionStorage === "undefined") return empty;
    const data = schema.parse(
      JSON.parse(sessionStorage.getItem(key) || "null"),
    );
    return Date.now() - data.time < 86400000 ? data : empty;
  } catch {
    return empty;
  }
}
export function saveCommentDrafts(
  key: string,
  body: string,
  replies: z.infer<typeof schema>["replies"],
  content?: CommentNode | null,
) {
  try {
    const nonempty = Object.fromEntries(
      Object.entries(replies).filter(([, v]) => v.body.trim()),
    );
    if (!body.trim() && !Object.keys(nonempty).length)
      sessionStorage.removeItem(key);
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({ time: Date.now(), body, content, replies: nonempty }),
      );
    return true;
  } catch {
    /* A storage quota must never discard the live in-memory draft. */
    return false;
  }
}
