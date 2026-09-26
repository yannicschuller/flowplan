// Moving pages into another workspace. The pages keep their ids (links keep
// working); everything tied to the old workspace is checked or cleaned up.
// Runs inside the command transaction.
import { all, audit, one, run } from "./db";
import { HttpError } from "./auth";
import { enforceQuota } from "./instance-ops";
import type { Field, Identity } from "./types";

export function transferPages(
  user: Identity,
  ids: string[],
  fromWorkspace: string,
  toWorkspace: string,
) {
  const moving = new Set(ids);
  const placeholders = ids.map(() => "?").join(",");
  // Relations would point across workspaces: refuse instead of losing them.
  for (const db of all<{ page_id: string; title: string; fields: string }>(
    "SELECT d.page_id,p.title,d.fields FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=?",
    fromWorkspace,
  )) {
    for (const field of JSON.parse(db.fields) as Field[]) {
      if (field.type !== "relation" || !field.relationPage) continue;
      if (moving.has(db.page_id) !== moving.has(field.relationPage)) {
        const inside = moving.has(db.page_id)
          ? db.title
          : one<{ title: string }>("SELECT title FROM pages WHERE id=?", field.relationPage)?.title;
        throw new HttpError(
          409,
          `„${inside || "Datenbank"}“ ist über die Eigenschaft „${field.name}“ mit einer Datenbank verknüpft, die nicht mitverschoben wird. Löse die Relation, bevor du in einen anderen Arbeitsbereich verschiebst.`,
        );
      }
    }
  }
  // The files come along into the other workspace's quota.
  const bytes = Number(
    one<{ n: number }>(
      `SELECT COALESCE(SUM(size),0) n FROM files WHERE page_id IN (${placeholders})`,
      ...ids,
    )?.n || 0,
  );
  enforceQuota(toWorkspace, bytes);

  const member = `SELECT user_id FROM members WHERE workspace_id=?`;
  // Rights for groups of the old workspace and for people who are not in
  // the new one no longer apply.
  run(
    `DELETE FROM grants WHERE resource_id IN (${placeholders}) AND (
       (group_id IS NOT NULL AND group_id!='' AND group_id NOT IN (SELECT id FROM groups WHERE workspace_id=?))
       OR (user_id IS NOT NULL AND user_id!='' AND user_id NOT IN (${member})))`,
    ...ids,
    toWorkspace,
    toWorkspace,
  );
  run(
    `DELETE FROM row_grants WHERE row_id IN (SELECT id FROM rows WHERE page_id IN (${placeholders})) AND (
       (group_id!='' AND group_id NOT IN (SELECT id FROM groups WHERE workspace_id=?))
       OR (user_id!='' AND user_id NOT IN (${member})))`,
    ...ids,
    toWorkspace,
    toWorkspace,
  );
  run(
    `DELETE FROM favorites WHERE page_id IN (${placeholders}) AND user_id NOT IN (${member})`,
    ...ids,
    toWorkspace,
  );
  run(
    `DELETE FROM row_favorites WHERE page_id IN (${placeholders}) AND user_id NOT IN (${member})`,
    ...ids,
    toWorkspace,
  );
  run(
    `UPDATE pages SET workspace_id=? WHERE id IN (${placeholders})`,
    toWorkspace,
    ...ids,
  );
  audit(user.id, "page.transfer", ids[0], toWorkspace);
}
