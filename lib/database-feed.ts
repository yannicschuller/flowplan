import { z } from "zod";
export const feedSchema = z.object({
  content: z.enum(["full", "compact", "hidden"]),
  showAuthor: z.boolean(),
  showDate: z.boolean(),
  showComments: z.boolean(),
});
export type FeedConfig = z.infer<typeof feedSchema>;
export const defaultFeed: FeedConfig = {
  content: "full",
  showAuthor: true,
  showDate: true,
  showComments: true,
};
