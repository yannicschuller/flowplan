import { all, one } from "./db";
import { requirePage } from "./permissions";
import { HttpError } from "./auth";
import { allowedAggregates } from "./rollups";
import type { Field, Identity, Page, Row } from "./types";

// Load only databases this user can read. No server-computed value may bypass that graph.
export function relatedData(user: Identity, root: Page) {
  const related: Record<string, Row[]> = {},
    relatedSchemas: Record<string, Field[]> = {};
  const pending = [root.id],
    visited = new Set<string>();
  while (pending.length) {
    const pageId = pending.shift()!;
    if (visited.has(pageId)) continue;
    visited.add(pageId);
    let page: Page;
    try {
      page = requirePage(user, pageId);
    } catch {
      continue;
    }
    if (page.workspace_id !== root.workspace_id || page.kind !== "database")
      continue;
    const raw = one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    );
    if (!raw) continue;
    const fields: Field[] = JSON.parse(raw.fields);
    relatedSchemas[pageId] = fields;
    related[pageId] = all<Row & { cells: string }>(
      "SELECT * FROM rows WHERE page_id=? ORDER BY position",
      pageId,
    ).map((r) => ({ ...r, cells: JSON.parse(r.cells) }));
    for (const field of fields)
      if (field.type === "relation" && field.relationPage)
        pending.push(field.relationPage);
  }
  return { related, relatedSchemas };
}
export function validateDatabaseRelations(
  user: Identity,
  page: Page,
  fields: Field[],
  previous: Field[],
) {
  for (const f of fields) {
    if (!["relation", "rollup"].includes(f.type)) continue;
    // Retain unreadable old references without granting access or blocking unrelated schema changes.
    const old = previous.find((p) => p.id === f.id);
    const same =
      old?.type === f.type &&
      old.relationPage === f.relationPage &&
      old.relationField === f.relationField &&
      old.rollupField === f.rollupField &&
      old.aggregate === f.aggregate;
    if (f.type === "relation") {
      if (!f.relationPage) throw new HttpError(400, "Relationsziel fehlt.");
      try {
        const target = requirePage(user, f.relationPage);
        if (
          target.kind !== "database" ||
          target.workspace_id !== page.workspace_id
        )
          throw new HttpError(
            400,
            "Relation muss auf eine Datenbank im Arbeitsbereich zeigen.",
          );
      } catch (e) {
        if (
          !same ||
          !(e instanceof HttpError) ||
          ![403, 404].includes(e.status)
        )
          throw e;
      }
    } else {
      const relation = fields.find(
        (p) => p.id === f.relationField && p.type === "relation",
      );
      if (!relation?.relationPage)
        throw new HttpError(400, "Für den Rollup zuerst eine Relation wählen.");
      let target: Page;
      try {
        target = requirePage(user, relation.relationPage);
      } catch (e) {
        const previousRelation = previous.find((p) => p.id === relation.id);
        if (same && previousRelation?.relationPage === relation.relationPage)
          continue;
        throw e;
      }
      if (
        target.kind !== "database" ||
        target.workspace_id !== page.workspace_id
      )
        throw new HttpError(400, "Ungültige Rollup-Datenbank.");
      const targetFields: Field[] =
        target.id === page.id
          ? fields
          : JSON.parse(
              String(
                one("SELECT fields FROM databases WHERE page_id=?", target.id)
                  ?.fields || "[]",
              ),
            );
      const property = targetFields.find((p) => p.id === f.rollupField);
      if ((f.aggregate || "count") !== "count" && !property)
        throw new HttpError(400, "Rollup-Eigenschaft fehlt.");
      if (!allowedAggregates(property).includes(f.aggregate || "count"))
        throw new HttpError(
          400,
          "Diese Berechnung passt nicht zur Eigenschaft.",
        );
      if (
        f.rollupDisplay &&
        f.rollupDisplay !== "number" &&
        [
          "show_original",
          "show_unique",
          "earliest_date",
          "latest_date",
        ].includes(f.aggregate || "count")
      )
        throw new HttpError(
          400,
          "Fortschrittsanzeigen benötigen ein numerisches Ergebnis.",
        );
    }
  }
}
