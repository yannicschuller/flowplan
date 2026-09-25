import { z } from "zod";
import { all, one, run, audit } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { rowAccessModes, type RowAccessMode } from "./row-access-modes";
import type { Identity, Page, Role } from "./types";

// Record permissions on top of the database page role. "readonly" records
// are changed only by their managers and editor grants, "private" records
// are seen only by managers and grants. Managers are the page owners and
// whoever created the record. Grants never exceed the database page role.
export type RowGrant = {
  user_id: string;
  group_id: string;
  role: "viewer" | "editor";
};
type AccessRow = { id: string; access?: string; created_by?: string | null };
const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const lower = (a: Role, b: Role) => (rank[a] < rank[b] ? a : b);

export function rowRoleResolver(
  user: Identity,
  page: Page,
  role = pageRole(user, page),
) {
  const restricted = new Map<string, RowGrant[]>();
  for (const g of all<RowGrant & { row_id: string }>(
    `SELECT g.row_id,g.user_id,g.group_id,g.role FROM row_grants g JOIN rows r ON r.id=g.row_id
     WHERE r.page_id=? AND r.access!='inherit' AND (g.user_id=? OR g.group_id IN (SELECT group_id FROM group_members WHERE user_id=?))`,
    page.id,
    user.id,
    user.id,
  ))
    restricted.set(g.row_id, [...(restricted.get(g.row_id) || []), g]);
  return (row: AccessRow): Role | null =>
    combine(user, role, row, restricted.get(row.id) || []);
}
// `grants` are the ones matching this person.
function combine(
  user: Identity,
  role: Role | null,
  row: AccessRow,
  grants: RowGrant[],
): Role | null {
  if (!role) return null;
  const access = (row.access || "inherit") as RowAccessMode;
  if (access === "inherit" || role === "owner" || row.created_by === user.id)
    return role;
  const granted = grants.some((g) => g.role === "editor")
    ? "editor"
    : grants.length
      ? "viewer"
      : null;
  if (access === "readonly")
    return granted === "editor" ? lower("editor", role) : "viewer";
  return granted ? lower(granted, role) : null;
}
// Role for a record outside the rows table (e.g. in the trash) with its
// stored grants.
export function roleWithGrants(
  user: Identity,
  page: Page,
  row: AccessRow,
  grants: RowGrant[],
) {
  const groups = new Set(
    all<{ group_id: string }>(
      "SELECT group_id FROM group_members WHERE user_id=?",
      user.id,
    ).map((g) => g.group_id),
  );
  return combine(
    user,
    pageRole(user, page),
    row,
    grants.filter(
      (g) => g.user_id === user.id || (!!g.group_id && groups.has(g.group_id)),
    ),
  );
}
export function rowRole(user: Identity, page: Page, row: AccessRow) {
  return rowRoleResolver(user, page)(row);
}
// Rows a person may see, each with the role they have on it.
export function visibleRows<T extends AccessRow>(
  user: Identity,
  page: Page,
  rows: T[],
) {
  const resolve = rowRoleResolver(user, page);
  return rows.flatMap((r) => {
    const role = resolve(r);
    return role ? [{ ...r, role }] : [];
  });
}
// Ids of records hidden from a person in a database (for filters in queries).
export function hiddenRowIds(user: Identity, page: Page) {
  const resolve = rowRoleResolver(user, page);
  return new Set(
    all<AccessRow>(
      "SELECT id,access,created_by FROM rows WHERE page_id=? AND access='private'",
      page.id,
    )
      .filter((r) => !resolve(r))
      .map((r) => r.id),
  );
}
export function assertRowAccess(
  user: Identity,
  page: Page,
  row: AccessRow,
  write: boolean,
) {
  const role = rowRole(user, page, row);
  if (!role) throw new HttpError(404, "Datensatz nicht gefunden.");
  if (write && rank[role] < 2)
    throw new HttpError(403, "Dieser Eintrag ist für dich schreibgeschützt.");
  return role;
}
export function assertRowsWritable(
  user: Identity,
  page: Page,
  rowIds: Iterable<string>,
) {
  const resolve = rowRoleResolver(user, page);
  for (const rowId of rowIds) {
    const row = one<AccessRow>(
      "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
      rowId,
      page.id,
    );
    if (!row) continue;
    const role = resolve(row);
    if (!role) throw new HttpError(404, "Datensatz nicht gefunden.");
    if (rank[role] < 2)
      throw new HttpError(403, "Dieser Eintrag ist für dich schreibgeschützt.");
  }
}
export function rowGrants(rowId: string) {
  return all<RowGrant>(
    "SELECT user_id,group_id,role FROM row_grants WHERE row_id=? ORDER BY user_id,group_id",
    rowId,
  );
}
export function canManageRow(user: Identity, page: Page, row: AccessRow) {
  const role = pageRole(user, page);
  return role === "owner" || (role === "editor" && row.created_by === user.id);
}
const accessInput = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  access: z.enum(rowAccessModes),
  grants: z
    .array(
      z.object({
        userId: z.string().uuid().optional(),
        groupId: z.string().uuid().optional(),
        role: z.enum(["viewer", "editor"]),
      }),
    )
    .max(200),
});
export function setRowAccess(user: Identity, raw: unknown) {
  const b = accessInput.parse(raw);
  const page = requirePage(user, b.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const row = one<AccessRow>(
    "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
    b.rowId,
    page.id,
  );
  if (!row) throw new HttpError(404, "Datensatz nicht gefunden.");
  if (!canManageRow(user, page, row))
    throw new HttpError(
      403,
      "Nur Besitzer der Datenbank und wer den Eintrag angelegt hat, ändern seine Rechte.",
    );
  const seen = new Set<string>();
  for (const g of b.grants) {
    if (!!g.userId === !!g.groupId)
      throw new HttpError(400, "Mitglied oder Gruppe erforderlich.");
    const key = g.userId ? `u:${g.userId}` : `g:${g.groupId}`;
    if (seen.has(key)) throw new HttpError(400, "Doppelte Freigabe.");
    seen.add(key);
    if (
      g.userId &&
      !one(
        "SELECT 1 FROM members WHERE workspace_id=? AND user_id=?",
        page.workspace_id,
        g.userId,
      )
    )
      throw new HttpError(400, "Mitglied fehlt.");
    if (
      g.groupId &&
      !one(
        "SELECT 1 FROM groups WHERE id=? AND workspace_id=?",
        g.groupId,
        page.workspace_id,
      )
    )
      throw new HttpError(400, "Gruppe fehlt.");
  }
  run("UPDATE rows SET access=? WHERE id=?", b.access, row.id);
  run("DELETE FROM row_grants WHERE row_id=?", row.id);
  for (const g of b.grants)
    run(
      "INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,?,?)",
      row.id,
      g.userId || "",
      g.groupId || "",
      g.role,
    );
  audit(user.id, "row.access", page.id, `${row.id}:${b.access}`);
  return { access: b.access, grants: rowGrants(row.id) };
}
