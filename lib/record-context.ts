// What the record view shows around a record, in one request
// (GET /api/pages/:id/rows/:rowId/context): its backlinks, unlinked
// mentions, related pages, linked issue and customer conversation. Each
// part is what its own endpoint answers; a part that fails is left out
// (`failed`) and the view asks its own endpoint for it, as before.
import type { Identity } from "./types";
import { recordBacklinks } from "./relation-backlinks";
import { unlinkedMentions } from "./page-graph";
import { relatedPages } from "./related-pages";
import { issueLinkOf } from "./issue-sync";
import { teamThread } from "./service-desk";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { requireRow } from "./row-documents";

export const RECORD_CONTEXT_PARTS = ["backlinks", "unlinked", "related", "issue", "ticketThread"] as const;
export type RecordContextPart = (typeof RECORD_CONTEXT_PARTS)[number];
export type RecordContext = Partial<Record<RecordContextPart, unknown>> & { failed: RecordContextPart[] };

export async function recordContext(user: Identity, pageId: string, rowId: string): Promise<RecordContext> {
  const parts: Record<RecordContextPart, () => Promise<unknown>> = {
    backlinks: async () => await recordBacklinks(user, pageId, rowId),
    unlinked: async () => {
      const page = await requirePage(user, pageId);
      await requireUnlocked(user, page);
      await requireRow(user, page.id, rowId);
      return { mentions: await unlinkedMentions(user, page, rowId) };
    },
    related: async () => await relatedPages(user, pageId, rowId),
    issue: async () => await issueLinkOf(user, pageId, rowId),
    ticketThread: async () => await teamThread(user, pageId, rowId),
  };
  const out: RecordContext = { failed: [] };
  // One after the other: on SQLite they would not run side by side anyway.
  for (const name of RECORD_CONTEXT_PARTS)
    try {
      out[name] = await parts[name]();
    } catch {
      out.failed.push(name);
    }
  return out;
}
