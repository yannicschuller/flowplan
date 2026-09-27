// Synced blocks: where a synced page is shown, and which ones exist to be
// inserted elsewhere.
import { all, one } from "./db";
import { pageRole } from "./permissions";
import { htmlParagraphs } from "./version-history";
import type { Identity, Page } from "./types";

export function syncedUsage(user: Identity, page: Page) {
  const hosts = all<Page>(
    `SELECT p.* FROM documents d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.html LIKE ?
     UNION SELECT p.* FROM row_documents rd JOIN rows r ON r.id=rd.row_id JOIN pages p ON p.id=r.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND rd.html LIKE ?`,
    page.workspace_id,
    `%data-synced-block="${page.id}"%`,
    page.workspace_id,
    `%data-synced-block="${page.id}"%`,
  );
  const origin = page.parent_id ? one<Page>("SELECT * FROM pages WHERE id=?", page.parent_id) : undefined;
  return {
    count: hosts.length,
    hosts: hosts
      .filter((host) => pageRole(user, host))
      .slice(0, 20)
      .map((host) => ({ id: host.id, title: host.title, icon: host.icon })),
    origin: origin && !origin.deleted_at && pageRole(user, origin) ? { id: origin.id, title: origin.title } : null,
  };
}
export function listSyncedBlocks(user: Identity, workspaceId: string) {
  return all<Page & { html: string }>(
    `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.synced=1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 200`,
    workspaceId,
  )
    .filter((page) => pageRole(user, page))
    .map((page) => {
      const origin = page.parent_id ? one<Page>("SELECT title FROM pages WHERE id=?", page.parent_id) : undefined;
      return {
        id: page.id,
        preview: htmlParagraphs(page.html).join(" · ").slice(0, 160) || "Leer",
        origin: origin?.title || "",
        updated_at: page.updated_at,
      };
    });
}
