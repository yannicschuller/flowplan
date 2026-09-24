import { all, one } from "./db";
import { pageRole, requirePage } from "./permissions";
import { cellText } from "./cell-text";
import type { Field, Identity, Page } from "./types";

export type Backlink = {
  pageId: string;
  pageTitle: string;
  rowId: string;
  title: string;
  field: string;
};
// Records in readable databases whose relation properties point at this record.
export function relationBacklinks(
  user: Identity,
  pageId: string,
  rowId: string,
  limit = 100,
): Backlink[] {
  const page = requirePage(user, pageId);
  if (!one("SELECT 1 FROM rows WHERE id=? AND page_id=?", rowId, page.id))
    return [];
  const sources = all<Page & { fields: string }>(
    `SELECT p.*,d.fields FROM databases d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.fields LIKE ?`,
    page.workspace_id,
    `%${page.id}%`,
  );
  const links: Backlink[] = [];
  for (const source of sources) {
    if (!pageRole(user, source)) continue;
    const fields = (JSON.parse(source.fields) as Field[]).filter(
      (f) => f.type === "relation" && f.relationPage === page.id,
    );
    if (!fields.length) continue;
    for (const row of all<{ id: string; cells: string }>(
      "SELECT id,cells FROM rows WHERE page_id=? AND cells LIKE ? ORDER BY position",
      source.id,
      `%${rowId}%`,
    )) {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      for (const field of fields) {
        const value = cells[field.id];
        if (
          Array.isArray(value) &&
          value.includes(rowId) &&
          !(source.id === page.id && row.id === rowId)
        )
          links.push({
            pageId: source.id,
            pageTitle: source.title,
            rowId: row.id,
            title:
              cellText(cells[(JSON.parse(source.fields) as Field[])[0]?.id]) ||
              "Ohne Titel",
            field: field.name,
          });
        if (links.length >= limit) return links;
      }
    }
  }
  return links;
}
