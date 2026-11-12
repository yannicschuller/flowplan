// Moving a page with its sub-pages to the trash (page.delete, and the
// sub-pages of a record that goes to the trash, lib/record-pages.ts).
// Inside the command transaction.
import { all, nowText, run } from "./db";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { revokeRecordSharesOfPage } from "./record-share";
import { dropLiveProjectionsOfRoot } from "./shared-live";
import { forEachAsync } from "./each-async";
import type { Identity } from "./types";

// The pages moved to the trash, all with the same date (`deletedAt`), so
// restoring brings them back together. Sub-pages already in the trash stay
// there with their own date (lib/trash.ts).
export async function trashPageTree(user: Identity, pageId: string, deletedAt = nowText()) {
  const tree = await all<{ id: string; deleted_at: string | null }>(
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE id=? UNION ALL SELECT p.id FROM pages p JOIN tree t ON p.parent_id=t.id) SELECT p.id,p.deleted_at FROM pages p JOIN tree t ON t.id=p.id",
    pageId,
  );
  const subtree = tree.filter((p) => !p.deleted_at).map((p) => p.id);
  // Every page that goes along: editable, and behind no journal PIN the
  // person has not entered (a journal further down).
  await forEachAsync(subtree, async (child) => await requireUnlocked(user, await requirePage(user, child, true, true)));
  for (const child of subtree) {
    await run("DELETE FROM publication_pages WHERE page_id=? OR root_id=?", child, child);
    await run("DELETE FROM publications WHERE page_id=?", child);
    await dropLiveProjectionsOfRoot(child);
    await run("DELETE FROM share_links WHERE root_id=?", child);
    await run("DELETE FROM share_link_pages WHERE page_id=?", child);
    await revokeRecordSharesOfPage(child);
    await run("UPDATE pages SET deleted_at=?,public_token=NULL WHERE id=?", deletedAt, child);
  }
  // Workflow pages in the trash behave as paused (#168).
  const { trashWorkflows } = await import("./workflows/store");
  await trashWorkflows(subtree, user.id);
  return subtree;
}
