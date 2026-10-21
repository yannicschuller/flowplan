import { rowRole, rowRoleResolver } from "./row-access";
import { hiddenFieldsFor } from "./field-access";
import { all, one } from "./db";
import { pageRole, requirePage } from "./permissions";
import { cellText } from "./cell-text";
import { textBacklinks } from "./text-backlinks";
import type { Field, Identity, Page } from "./types";

export type Backlink = {
  pageId: string;
  pageTitle: string;
  // Missing for a page whose text links to the record.
  rowId?: string;
  title: string;
  // The relation property; empty for a link in a text.
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
  const target = one<{ id: string; access: string; created_by: string }>(
    "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
    rowId,
    page.id,
  );
  if (!target || !rowRole(user, page, target)) return [];
  const sources = all<Page & { fields: string }>(
    `SELECT p.*,d.fields FROM databases d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.fields LIKE ?`,
    page.workspace_id,
    `%${page.id}%`,
  );
  const links: Backlink[] = [];
  for (const source of sources) {
    if (!pageRole(user, source)) continue;
    const hidden = hiddenFieldsFor(user, source, JSON.parse(source.fields));
    const fields = (JSON.parse(source.fields) as Field[]).filter(
      (f) =>
        f.type === "relation" &&
        f.relationPage === page.id &&
        !hidden.has(f.id),
    );
    if (!fields.length) continue;
    const visible = rowRoleResolver(user, source);
    for (const row of all<{
      id: string;
      cells: string;
      access: string;
      created_by: string;
    }>(
      "SELECT id,cells,access,created_by FROM rows WHERE page_id=? AND cells LIKE ? ORDER BY position",
      source.id,
      `%${rowId}%`,
    )) {
      if (!visible(row)) continue;
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

// Everything that leads to a record: relations first, then links in the
// texts of pages and records.
export function recordBacklinks(user: Identity, pageId: string, rowId: string): Backlink[] {
  const relations = relationBacklinks(user, pageId, rowId);
  const page = requirePage(user, pageId);
  const target = one<{ id: string; access: string; created_by: string }>(
    "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
    rowId,
    page.id,
  );
  if (!target || !rowRole(user, page, target)) return [];
  return [
    ...relations,
    ...textBacklinks(user, page, rowId).map((link) => ({
      pageId: link.id,
      pageTitle: link.pageTitle || "",
      ...(link.rowId ? { rowId: link.rowId } : {}),
      title: link.title || "Ohne Titel",
      field: "",
    })),
  ];
}
