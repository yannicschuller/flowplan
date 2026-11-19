import { visibleRows } from "./row-access";
import { visibleFields } from "./field-access";
import { all, one } from "./db";
import { requirePage } from "./permissions";
import { journalLocked } from "./journal-extras";
import { HttpError } from "./auth";
import { allowedAggregates } from "./rollups";
import { formulaReferences } from "./formula";
import type { Field, Identity, Page, Row } from "./types";

// Load only databases this user can read. No server-computed value may bypass that graph.
// `rootRows: false`: the caller has the root database's own records already
// (they come back as an empty list instead of being read a second time).
export async function relatedData(user: Identity, root: Page, options: { rootRows?: boolean } = {}) {
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
      page = await requirePage(user, pageId);
    } catch {
      continue;
    }
    // Nothing of a database behind a journal PIN the person has not entered.
    if (page.workspace_id !== root.workspace_id || page.kind !== "database" || await journalLocked(user, page))
      continue;
    const raw = await one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    );
    if (!raw) continue;
    const fields: Field[] = JSON.parse(raw.fields);
    relatedSchemas[pageId] = await visibleFields(user, page, fields);
    // Cells parsed before the hidden ones are left out (stripCells would
    // otherwise parse and serialise each record once more).
    related[pageId] =
      pageId === root.id && options.rootRows === false
        ? []
        : (await visibleRows(
            user,
            page,
            (await all<Row & { cells: string }>(
              "SELECT * FROM rows WHERE page_id=? ORDER BY position",
              pageId,
            )).map((r) => ({ ...r, cells: JSON.parse(r.cells) as Row["cells"] })),
          ));
    for (const field of fields)
      if (field.type === "relation" && field.relationPage)
        pending.push(field.relationPage);
  }
  return { related, relatedSchemas };
}
// What the database view needs of the databases its relations point to
// (#383): opening a database sent every record of every database reachable
// through relations, all their cells and their legacy text. The view needs
// of a related database its records (the relation picker offers all of
// them), their titles and icons (chips, filters, groups, charts: the
// property "title" and the first one), and the properties its rollups read
// – followed through formulas and rollups of the related database, as
// lib/database.ts computedCells() does, into further databases only where a
// rollup leads there. The root database's own records come separately
// (pageContent: `rows`), its entry stays empty as with relatedData(…,
// { rootRows: false }). Exports, dashboards and MCP keep relatedData().
const ALL = Symbol("all");
export async function relatedForView(user: Identity, root: Page) {
  const related: Record<string, Row[]> = {},
    relatedSchemas: Record<string, Field[]> = {};
  // Readable databases of the root's workspace by id: the page and its
  // visible properties (null: not readable – the view shows #ACCESS).
  const schemas = new Map<string, { page: Page; fields: Field[] } | null>();
  async function schemaOf(pageId: string) {
    if (!schemas.has(pageId)) {
      let entry: { page: Page; fields: Field[] } | null = null;
      try {
        const page = await requirePage(user, pageId);
        if (page.workspace_id === root.workspace_id && page.kind === "database" && !(await journalLocked(user, page))) {
          const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
          if (raw) entry = { page, fields: await visibleFields(user, page, JSON.parse(raw.fields) as Field[]) };
        }
      } catch {}
      schemas.set(pageId, entry);
    }
    return schemas.get(pageId)!;
  }
  related[root.id] = [];
  const own = await schemaOf(root.id);
  if (!own) return { related, relatedSchemas };
  relatedSchemas[root.id] = own.fields;
  // The cells needed per related database ('' for none: the records only).
  const needs = new Map<string, Set<string> | typeof ALL>();
  const work: [string, string | typeof ALL][] = [];
  // A property of a database and what it reads in turn.
  const expand = (fields: Field[], databaseId: string, field: Field) => {
    if (field.type === "formula") {
      const refs = formulaReferences(field.formula || "");
      if (refs?.dynamic) work.push([databaseId, ALL]);
      else
        for (const name of refs?.names || []) {
          const prop = fields.find((p) => p.name === name || p.id === name);
          if (prop) work.push([databaseId, prop.id]);
        }
    } else if (field.type === "rollup") {
      const relation = fields.find((f) => f.id === field.relationField && f.type === "relation");
      if (relation) work.push([databaseId, relation.id]);
      if (relation?.relationPage) work.push([relation.relationPage, field.rollupField || ""]);
    } else if (field.type === "progress") work.push([databaseId, ALL]);
  };
  for (const field of own.fields) {
    if (field.type === "relation" && field.relationPage) work.push([field.relationPage, "title"]);
    if (field.type === "rollup") expand(own.fields, root.id, field);
  }
  while (work.length) {
    const [databaseId, wanted] = work.shift()!;
    // The root's records are sent whole.
    if (databaseId === root.id) continue;
    const schema = await schemaOf(databaseId);
    if (!schema) continue;
    let have = needs.get(databaseId);
    if (!have) {
      needs.set(databaseId, (have = new Set(["title", ...(schema.fields[0] ? [schema.fields[0].id] : [])])));
    }
    if (have === ALL) continue;
    if (wanted === ALL) {
      needs.set(databaseId, ALL);
      for (const field of schema.fields) expand(schema.fields, databaseId, field);
      continue;
    }
    if (!wanted || have.has(wanted)) continue;
    have.add(wanted);
    const field = schema.fields.find((f) => f.id === wanted);
    if (field) expand(schema.fields, databaseId, field);
  }
  for (const [databaseId, cells] of needs) {
    const { page, fields } = (await schemaOf(databaseId))!;
    relatedSchemas[databaseId] = fields;
    related[databaseId] = (await visibleRows(
      user,
      page,
      (await all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position", databaseId)).map(({ content: _content, cells: raw, ...r }) => {
        const all = JSON.parse(raw) as Row["cells"];
        if (cells === ALL) return { ...r, cells: all };
        const some: Row["cells"] = {};
        for (const key of cells) if (Object.hasOwn(all, key)) some[key] = all[key];
        return { ...r, cells: some };
      }),
    ));
  }
  return { related, relatedSchemas };
}
export async function validateDatabaseRelations(
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
        const target = await requirePage(user, f.relationPage);
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
        target = await requirePage(user, relation.relationPage);
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
                (await one("SELECT fields FROM databases WHERE page_id=?", target.id))
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
