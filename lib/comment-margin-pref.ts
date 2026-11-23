import { z } from "zod";

// "Textkommentare" (#387, Settings → Appearance & language): where open text
// comments (#314) show – beside their passage (the default: as cards in a
// margin on wide screens, as a popover at the passage where the margin has
// no room, #450) or in the panel below the document. Stored per person on the server
// (users.comment_margin: NULL = the default – the margin –, 0 = below the
// document, 1 = the margin), delivered with the bootstrap.
export const DEFAULT_COMMENT_MARGIN = true;
export const commentMarginSchema = z.boolean();

// What a stored value means: only an explicit "below" turns the margin off.
export function commentMarginOf(value: unknown): boolean {
  return !(value === false || value === 0 || value === "0");
}

// The margin needs this much room for the page (the page layout's width
// without side panels such as the page comments): the text column keeps
// about 500 px beside the 296 px margin – with the sidebar open from a
// window of about 1180 px (#450; before: 1024, about 1280 px). Below it a
// clicked highlight or a new comment opens as a popover beside or below
// its passage (components/comment-popover.tsx), the panel below the
// document stays the overview.
export const COMMENT_MARGIN_MIN_ROOM = 920;
