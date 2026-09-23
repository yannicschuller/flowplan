import type { CommentNode } from "./comment-content";
import { z } from "zod";
import { cursorSchema } from "./cursor-protocol";
export const commentAnchorSchema = z
  .object({
    generation: z.string().min(1).max(128),
    positions: cursorSchema,
    quote: z.string().min(1).max(4000),
  })
  .strict();
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type InlineMessage = {
  content?: CommentNode | null;
  id: string;
  author_id: string | null;
  name: string;
  body: string;
  version: number;
  created_at: string;
  edited_at: string | null;
  deleted: number;
  reactions: { emoji: string; count: number; mine: boolean; names: string[] }[];
};
export type InlineThread = {
  id: string;
  page_id: string;
  row_id: string | null;
  author_id: string | null;
  anchor: CommentAnchor;
  resolved: number;
  version: number;
  created_at: string;
  messages: InlineMessage[];
  messageCount: number;
  complete: boolean;
  canResolve: boolean;
};
