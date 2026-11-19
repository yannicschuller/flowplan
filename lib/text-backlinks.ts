import { all } from "./db";
import { pageRole } from "./permissions";
import { rowRoleResolver } from "./row-access";
import { journalLocked } from "./journal-extras";
import { cellText } from "./cell-text";
import { drainTextLinks, LINK_ID } from "./text-links";
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

// The sources come from the links table (lib/text-links.ts, #383): one
// indexed lookup instead of a LIKE over every document and record of the
// workspace. `scan` (and an id the table cannot hold) reads the HTML as
// before – the reference the table is tested against.
export async function textBacklinks(
  user: Identity,
  target: Pick<Page, "id" | "workspace_id">,
  rowId?: string,
  limit = 100,
  options: { scan?: boolean } = {},
): Promise<TextBacklink[]> {
  const indexed = !options.scan && LINK_ID.test(target.id) && (!rowId || LINK_ID.test(rowId));
  if (indexed) await drainTextLinks();
  // In stored HTML the "&" before row= is written as "&amp;".
  const needle = rowId ? `row=${rowId}` : `#page=${target.id}`;
  // A record link counts when the text also names the record's database.
  const linksHere = (html: string) =>
    indexed || (html.includes(needle) && (!rowId || html.includes(`#page=${target.id}`)));
  // The sources (alias l) that link here: the record link, with the database.
  const linked = rowId
    ? "l.target=? AND EXISTS(SELECT 1 FROM text_links m WHERE m.target=? AND m.page_id=l.page_id AND m.row_id=l.row_id)"
    : "l.target=?";
  const linkedArgs = rowId ? [`r:${rowId}`, `p:${target.id}`] : [`p:${target.id}`];
  const documentQuery: [string, ...string[]] = indexed
    ? [
        `SELECT p.*,'' html FROM text_links l JOIN pages p ON p.id=l.page_id
         WHERE ${linked} AND l.row_id='' AND p.workspace_id=? AND p.deleted_at IS NULL ORDER BY p.title,p.seq`,
        ...linkedArgs,
        target.workspace_id,
      ]
    : [
        `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
         WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.html LIKE ? ESCAPE '\\' ORDER BY p.title`,
        target.workspace_id,
        like(needle),
      ];
  const record = "p.*,r.id row_id,r.icon row_icon,r.cells row_cells,r.access row_access,r.created_by row_by,db.fields db_fields";
  const recordQuery: [string, ...string[]] = indexed
    ? [
        `SELECT ${record},'' row_html
         FROM text_links l JOIN rows r ON r.id=l.row_id JOIN pages p ON p.id=r.page_id JOIN databases db ON db.page_id=p.id
         WHERE ${linked} AND l.page_id='' AND p.workspace_id=? AND p.deleted_at IS NULL
         ORDER BY p.title,r.position`,
        ...linkedArgs,
        target.workspace_id,
      ]
    : [
        `SELECT ${record},COALESCE(rd.html,r.content,'') row_html
         FROM rows r JOIN pages p ON p.id=r.page_id JOIN databases db ON db.page_id=p.id
         LEFT JOIN row_documents rd ON rd.row_id=r.id
         WHERE p.workspace_id=? AND p.deleted_at IS NULL AND COALESCE(rd.html,r.content,'') LIKE ? ESCAPE '\\'
         ORDER BY p.title,r.position`,
        target.workspace_id,
        like(needle),
      ];
  const roles = new Map<string, boolean>();
  const readable = async (page: Page) => {
    if (!roles.has(page.id))
      roles.set(page.id, !!(await pageRole(user, page)) && !(await journalLocked(user, page)));
    return roles.get(page.id)!;
  };
  const links: TextBacklink[] = [];
  for (const page of await all<Page & { html: string }>(...documentQuery)) {
    if (links.length >= limit) return links;
    if ((!rowId && page.id === target.id) || !linksHere(page.html) || !(await readable(page))) continue;
    links.push({ id: page.id, title: page.title, icon: page.icon, kind: page.kind });
  }
  const databases = new Map<string, { page: Page; fields: Field[]; visible: Awaited<ReturnType<typeof rowRoleResolver>> } | null>();
  for (const row of await all<Page & { row_id: string; row_cells: string; row_access: string; row_by: string | null; row_icon: string | null; db_fields: string; row_html: string }>(
    ...recordQuery,
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
