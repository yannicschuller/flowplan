import { z } from "zod";

// "Textkommentare" (#387, Settings → Appearance & language): where open text
// comments (#314) show on wide screens – as cards in a margin beside their
// passage (the default) or in the panel below the document. Narrow screens
// and phones always use the panel. Stored per person on the server
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
// about 610 px beside the 296 px margin – with the sidebar open from a
// window of about 1280 px. Below it the panel takes over.
export const COMMENT_MARGIN_MIN_ROOM = 1024;
