// The person's "Textkommentare: am Rand / unter dem Dokument" (#387,
// lib/comment-margin-pref.ts), kept in users.comment_margin (NULL: never
// chosen, the default – the margin – applies).
import { one, run } from "./db";
import { commentMarginOf, commentMarginSchema } from "./comment-margin-pref";
import type { Identity } from "./types";

export async function userCommentMargin(userId: string) {
  return commentMarginOf((await one<{ comment_margin: number | null }>("SELECT comment_margin FROM users WHERE id=?", userId))?.comment_margin);
}
export async function setUserCommentMargin(user: Identity, input: unknown) {
  const commentMargin = commentMarginSchema.parse(input);
  await run("UPDATE users SET comment_margin=? WHERE id=?", commentMargin ? 1 : 0, user.id);
  return { commentMargin };
}
