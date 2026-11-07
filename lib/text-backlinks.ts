import { all } from "./db";
import { pageRole } from "./permissions";
import { rowRoleResolver } from "./row-access";
import { journalLocked } from "./journal-extras";
import { cellText } from "./cell-text";
import type { Field, Identity, Page } from "./types";

// Pages and records whose text links to a page or a record
// (`/#page=<page>` or `/#page=<database>&row=<record>`). Only what the person
// may read: the page, the database and each record's own permissions.
export type TextBacklink = {
  id: string;
  title: string;
  icon: string;
  // The page's kind, "record" for records (their default icon, #96).
  kind: string;
  // Set when the link is in a record's text.
  rowId?: string;
  pageTitle?: string;
};

const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function textBacklinks(
  user: Identity,
  target: Pick<Page, "id" | "workspace_id">,
  rowId?: string,
  limit = 100,
): Promise<TextBacklink[]> {
  // In stored HTML the "&" before row= is written as "&amp;".
  const needle = rowId ? `row=${rowId}` : `#page=${target.id}`;
  const linksHere = (html: string) =>
    html.includes(needle) && (!rowId || html.includes(`#page=${target.id}`));
  const roles = new Map<string, boolean>();
  const readable = async (page: Page) => {
    if (!roles.has(page.id))
      roles.set(page.id, !!(await pageRole(user, page)) && !(await journalLocked(user, page)));
    return roles.get(page.id)!;
  };
  const links: TextBacklink[] = [];
  for (const page of await all<Page & { html: string }>(
    `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.html LIKE ? ESCAPE '\\' ORDER BY p.title`,
    target.workspace_id,
    like(needle),
  )) {
    if (links.length >= limit) return links;
    if ((!rowId && page.id === target.id) || !linksHere(page.html) || !(await readable(page))) continue;
    links.push({ id: page.id, title: page.title, icon: page.icon, kind: page.kind });
  }
  const databases = new Map<string, { page: Page; fields: Field[]; visible: Awaited<ReturnType<typeof rowRoleResolver>> } | null>();
  for (const row of await all<Page & { row_id: string; row_cells: string; row_access: string; row_by: string | null; row_icon: string | null; db_fields: string; row_html: string }>(
    `SELECT p.*,r.id row_id,r.icon row_icon,r.cells row_cells,r.access row_access,r.created_by row_by,db.fields db_fields,COALESCE(rd.html,r.content,'') row_html
     FROM rows r JOIN pages p ON p.id=r.page_id JOIN databases db ON db.page_id=p.id
     LEFT JOIN row_documents rd ON rd.row_id=r.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND COALESCE(rd.html,r.content,'') LIKE ? ESCAPE '\\'
     ORDER BY p.title,r.position`,
    target.workspace_id,
    like(needle),
  )) {
    if (links.length >= limit) break;
    if (row.row_id === rowId || !linksHere(row.row_html)) continue;
    if (!databases.has(row.id))
      databases.set(
        row.id,
        (await readable(row))
          ? { page: row, fields: JSON.parse(row.db_fields) as Field[], visible: await rowRoleResolver(user, row) }
          : null,
      );
    const database = databases.get(row.id);
    if (!database || !database.visible({ id: row.row_id, access: row.row_access, created_by: row.row_by })) continue;
    const cells = JSON.parse(row.row_cells) as Record<string, unknown>;
    links.push({
      id: row.id,
      rowId: row.row_id,
      pageTitle: row.title,
      title: cellText(cells[database.fields[0]?.id || "title"]) || "Ohne Titel",
      // The record's own icon, not its database's (#96).
      icon: row.row_icon || "",
      kind: "record",
    });
  }
  return links;
}
