// Pages and records for "@" in a comment (#450): what the workspace search
// finds for the typed text (titles first, as the quick search ranks them),
// or with nothing typed the person's recently visited pages – only what the
// author may read (both leave out everything else, lib/search-index.ts).
import { z } from "zod";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { requireRow } from "./row-documents";
import { recentlyVisited, searchWorkspace } from "./search-index";
import type { Identity } from "./types";

export type CommentPageChoice = {
  pageId: string;
  rowId?: string;
  title: string;
  icon: string;
  kind: string;
  pageTitle?: string;
};
export const COMMENT_PAGE_CHOICES = 8;

export async function commentPageCandidates(user: Identity, pageId: string, rowId: string | undefined, query: string): Promise<CommentPageChoice[]> {
  const page = await requirePage(user, pageId);
  await requireUnlocked(user, page);
  if (rowId) await requireRow(user, pageId, rowId);
  const q = z.string().max(100).parse(query).trim();
  const hits = q
    ? await searchWorkspace(user, page.workspace_id, q, { kind: "all" })
    : await recentlyVisited(user, page.workspace_id, { limit: COMMENT_PAGE_CHOICES * 2 });
  const seen = new Set<string>();
  const choices: CommentPageChoice[] = [];
  for (const hit of hits) {
    if (hit.kind === "comment" || hit.kind === "file") continue;
    const key = hit.rowId ? `${hit.id}:${hit.rowId}` : hit.id;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({
      pageId: hit.id,
      ...(hit.rowId ? { rowId: hit.rowId } : {}),
      title: (hit.title || "").slice(0, 200),
      icon: hit.icon || "",
      kind: hit.kind,
      ...(hit.pageTitle ? { pageTitle: hit.pageTitle.slice(0, 200) } : {}),
    });
    if (choices.length === COMMENT_PAGE_CHOICES) break;
  }
  return choices;
}
