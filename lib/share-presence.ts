// Guests on edit links: their cursor as text address (lib/text-anchors.ts)
// and the cursors of members and other guests on the same page or record.
import { z } from "zod";
import { one } from "./db";
import { HttpError } from "./auth";
import { publicPage } from "./publication";
import { textCursorSchema } from "./cursor-protocol";
import { presencePrefix, setTextPresence, textPeers } from "./text-presence";
import { publishPresenceFor } from "./document-live";

// Only edit links have the live editor; the row must be shared too.
export function shareAccess(token: string, pageId: string, rowId?: string | null) {
  const { page, role } = publicPage(token, pageId);
  if (role !== "editor") throw new HttpError(403, "Dieser Link erlaubt keine Live-Bearbeitung.");
  if (rowId && !one("SELECT 1 FROM rows WHERE id=? AND page_id=? AND access NOT IN ('private','readonly')", rowId, page.id))
    throw new HttpError(404, "Datensatz nicht gefunden.");
  return page;
}

export function sharePresence(token: string, input: unknown) {
  const b = z
    .object({
      action: z.literal("presence"),
      pageId: z.uuid(),
      rowId: z.uuid().optional(),
      clientId: z.uuid(),
      text: textCursorSchema.nullable(),
    })
    .parse(input);
  const page = shareAccess(token, b.pageId, b.rowId);
  const prefix = presencePrefix(page.id, b.rowId);
  const id = `guest:${b.clientId}`;
  const link = one<{ name: string }>("SELECT name FROM share_links WHERE token=?", token);
  const changed = setTextPresence(
    prefix,
    b.text
      ? { id, userId: id, name: link?.name ? `Gast · ${link.name}`.slice(0, 100) : "Gast", text: b.text, source: "guest" }
      : { id, text: null },
  );
  if (changed) publishPresenceFor(page.id, b.rowId, b.clientId);
  return { peers: textPeers(prefix, id) };
}
