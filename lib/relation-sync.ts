import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import type { Field, Identity } from "./types";
export type RelationPair = {
  id: string;
  left_page: string;
  left_field: string;
  right_page: string;
  right_field: string;
};
export const relationPairSchema = z.object({
  id: z.string().uuid(),
  left_page: z.string().uuid(),
  left_field: z.string().min(1).max(500),
  right_page: z.string().uuid(),
  right_field: z.string().min(1).max(500),
});
export function relationPairs(pageId?: string) {
  return pageId
    ? all<RelationPair>(
        "SELECT * FROM two_way_relations WHERE left_page=? OR right_page=?",
        pageId,
        pageId,
      )
    : all<RelationPair>("SELECT * FROM two_way_relations");
}
export function relationFields(pageId: string): Field[] {
  return JSON.parse(
    String(
      one("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields ||
        "[]",
    ),
  );
}
export function insertRelationPair(pair: RelationPair) {
  if (
    pair.left_page === pair.right_page &&
    pair.left_field === pair.right_field
  )
    throw new HttpError(
      400,
      "Eine Rückrelation benötigt eine eigene Eigenschaft.",
    );
  for (const [page, field] of [
    [pair.left_page, pair.left_field],
    [pair.right_page, pair.right_field],
  ])
    if (
      one(
        "SELECT pair_id FROM relation_endpoints WHERE page_id=? AND field_id=?",
        page,
        field,
      )
    )
      throw new HttpError(
        409,
        "Eigenschaft ist bereits bidirektional verknüpft.",
      );
  run(
    "INSERT INTO two_way_relations VALUES(?,?,?,?,?)",
    pair.id,
    pair.left_page,
    pair.left_field,
    pair.right_page,
    pair.right_field,
  );
  run(
    "INSERT INTO relation_endpoints VALUES(?,?,?)",
    pair.left_page,
    pair.left_field,
    pair.id,
  );
  run(
    "INSERT INTO relation_endpoints VALUES(?,?,?)",
    pair.right_page,
    pair.right_field,
    pair.id,
  );
}
// Initialize from the authoritative forward side. Existing independent relations are untouched.
export function initializeRelationPair(pair: RelationPair) {
  const stored = one<RelationPair>(
    "SELECT * FROM two_way_relations WHERE id=?",
    pair.id,
  )!;
  run(
    "INSERT INTO relation_initializations VALUES(?,?) ON CONFLICT(pair_id) DO UPDATE SET reversed=excluded.reversed",
    pair.id,
    stored.left_page === pair.left_page && stored.left_field === pair.left_field
      ? 0
      : 1,
  );
}

export function restoreRelationPairs(
  actor: Identity,
  pageId: string,
  input: unknown,
) {
  if (input === undefined) return;
  const saved = z.array(relationPairSchema).max(80).parse(input);
  flushRelationChanges(actor);
  for (const pair of saved) {
    if (pair.left_page !== pageId && pair.right_page !== pageId)
      throw new HttpError(400, "Ungültige Relationsversion.");
    for (const [page, field, target] of [
      [pair.left_page, pair.left_field, pair.right_page],
      [pair.right_page, pair.right_field, pair.left_page],
    ]) {
      const p = requirePage(actor, page, true);
      if (p.locked)
        throw new HttpError(409, "Verknüpfte Datenbank ist gesperrt.");
      const f = relationFields(page).find((f) => f.id === field);
      if (f?.type !== "relation" || f.relationPage !== target)
        throw new HttpError(
          409,
          "Die Gegeneigenschaft wurde geändert. Relationsversion kann nicht wiederhergestellt werden.",
        );
    }
  }
  for (const pair of relationPairs(pageId))
    if (!saved.some((p) => p.id === pair.id))
      run("DELETE FROM two_way_relations WHERE id=?", pair.id);
  for (const pair of saved) {
    const existing = one<RelationPair>(
      "SELECT * FROM two_way_relations WHERE id=?",
      pair.id,
    );
    if (
      existing &&
      Object.keys(pair).some(
        (key) =>
          existing[key as keyof RelationPair] !==
          pair[key as keyof RelationPair],
      )
    )
      throw new HttpError(
        409,
        "Relationsversion kollidiert mit einer anderen Verknüpfung.",
      );
    if (!existing) insertRelationPair(pair);
    initializeRelationPair(
      pair.left_page === pageId
        ? pair
        : {
            ...pair,
            left_page: pair.right_page,
            left_field: pair.right_field,
            right_page: pair.left_page,
            right_field: pair.left_field,
          },
    );
  }
}
const ids = z.array(z.string().uuid()).max(500);
export function flushRelationChanges(actor?: Identity) {
  // Removing/changing a relation property disconnects it, preserving the other property and values.
  const pairs = relationPairs();
  const invalid = new Set(
    pairs
      .filter((pair) => {
        const left = relationFields(pair.left_page).find(
            (f) => f.id === pair.left_field,
          ),
          right = relationFields(pair.right_page).find(
            (f) => f.id === pair.right_field,
          );
        return !(
          left?.type === "relation" &&
          left.relationPage === pair.right_page &&
          right?.type === "relation" &&
          right.relationPage === pair.left_page
        );
      })
      .map((p) => p.id),
  );
  const initializations = new Map(
    all<{ pair_id: string; reversed: number }>(
      "SELECT * FROM relation_initializations",
    ).map((p) => [p.pair_id, p.reversed]),
  );
  const changes = all<{
    row_id: string;
    page_id: string;
    old_cells: string | null;
    new_cells: string | null;
    old_version: number | null;
  }>("SELECT * FROM relation_changes");
  const patches = new Map<
    string,
    { id: string; page_id: string; cells: Record<string, unknown> }
  >();
  const writable = new Set<string>();
  function requireWrite(pageId: string) {
    if (writable.has(pageId)) return;
    if (!actor)
      throw new HttpError(403, "Relationsänderung erfordert eine Anmeldung.");
    const page = requirePage(actor, pageId, true);
    if (page.locked)
      throw new HttpError(409, "Eine verknüpfte Datenbank ist gesperrt.");
    writable.add(pageId);
  }
  function patchRow(rowId: string, pageId: string) {
    const key = pageId + ":" + rowId;
    if (!patches.has(key)) {
      const row = one<{ id: string; page_id: string; cells: string }>(
        "SELECT id,page_id,cells FROM rows WHERE id=? AND page_id=?",
        rowId,
        pageId,
      );
      if (!row) return undefined;
      patches.set(key, { ...row, cells: JSON.parse(row.cells) });
    }
    return patches.get(key)!;
  }
  for (const pair of pairs) {
    const intents = new Map<
      string,
      { left: string; right: string; value: boolean }
    >();
    if (initializations.has(pair.id) && !invalid.has(pair.id)) {
      requireWrite(pair.left_page);
      requireWrite(pair.right_page);
      const reversed = !!initializations.get(pair.id);
      const authoritativePage = reversed ? pair.right_page : pair.left_page,
        authoritativeField = reversed ? pair.right_field : pair.left_field;
      const inversePage = reversed ? pair.left_page : pair.right_page,
        inverseField = reversed ? pair.left_field : pair.right_field;
      // Clear stale edges first, then replace them from the restored/forward side.
      for (const row of all<{ id: string; cells: string }>(
        "SELECT id,cells FROM rows WHERE page_id=?",
        inversePage,
      ))
        for (const target of ids.parse(
          JSON.parse(row.cells)[inverseField] || [],
        )) {
          const left = reversed ? row.id : target,
            right = reversed ? target : row.id;
          intents.set(left + ":" + right, { left, right, value: false });
        }
      for (const row of all<{ id: string; cells: string }>(
        "SELECT id,cells FROM rows WHERE page_id=?",
        authoritativePage,
      ))
        for (const target of ids.parse(
          JSON.parse(row.cells)[authoritativeField] || [],
        )) {
          const left = reversed ? target : row.id,
            right = reversed ? row.id : target;
          intents.set(left + ":" + right, { left, right, value: true });
        }
    } else
      for (const change of changes)
        for (const reverse of [false, true]) {
          if (invalid.has(pair.id) && change.new_cells !== null) continue;
          const page = reverse ? pair.right_page : pair.left_page,
            field = reverse ? pair.right_field : pair.left_field;
          if (change.page_id !== page) continue;
          const old = change.old_cells
              ? JSON.parse(change.old_cells)[field]
              : [],
            next = change.new_cells ? JSON.parse(change.new_cells)[field] : [];
          if (JSON.stringify(old || []) === JSON.stringify(next || []))
            continue;
          const before = new Set(ids.parse(old || [])),
            after = new Set(ids.parse(next || []));
          for (const target of new Set([...before, ...after])) {
            if (before.has(target) === after.has(target)) continue;
            if (change.new_cells !== null) {
              requireWrite(pair.left_page);
              requireWrite(pair.right_page);
            }
            const left = reverse ? target : change.row_id,
              right = reverse ? change.row_id : target,
              key = left + ":" + right,
              value = after.has(target);
            const previous = intents.get(key);
            if (previous && previous.value !== value)
              throw new HttpError(409, "Widersprüchliche Relationsänderungen.");
            intents.set(key, { left, right, value });
          }
        }
    for (const intent of intents.values())
      for (const reverse of [false, true]) {
        const page = reverse ? pair.right_page : pair.left_page,
          field = reverse ? pair.right_field : pair.left_field;
        const row = patchRow(reverse ? intent.right : intent.left, page),
          target = reverse ? intent.left : intent.right;
        if (!row) {
          if (intent.value)
            throw new HttpError(400, "Verknüpfter Eintrag fehlt.");
          continue;
        }
        const values = ids.parse(row.cells[field] || []);
        row.cells[field] = intent.value
          ? [...new Set([...values, target])]
          : values.filter((v) => v !== target);
        if ((row.cells[field] as string[]).length > 500)
          throw new HttpError(400, "Maximal 500 Verknüpfungen pro Eintrag.");
      }
  }
  run("UPDATE relation_sync_control SET syncing=1 WHERE id=1");
  try {
    for (const row of patches.values()) {
      const cells = JSON.stringify(row.cells);
      if (cells.length > 200000)
        throw new HttpError(413, "Datensatz mit Rückrelationen ist zu groß.");
      run(
        "UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=? AND cells!=?",
        cells,
        actor?.id || null,
        row.id,
        cells,
      );
      run(
        "UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?",
        row.page_id,
      );
    }
    for (const change of changes)
      if (change.old_version !== null)
        run(
          "UPDATE rows SET version=max(version,?) WHERE id=?",
          change.old_version + 1,
          change.row_id,
        );
    for (const pairId of invalid)
      run("DELETE FROM two_way_relations WHERE id=?", pairId);
    run("DELETE FROM relation_changes");
    run("DELETE FROM relation_initializations");
  } finally {
    run("UPDATE relation_sync_control SET syncing=0 WHERE id=1");
  }
}

// Portable archives/templates must contain a complete, symmetric relation graph.
export function validateRelationGraph(
  pairs: RelationPair[],
  databases: Map<
    string,
    { fields: Field[]; rows: { id: string; cells: Record<string, unknown> }[] }
  >,
) {
  const endpoints = new Set<string>(),
    pairIds = new Set<string>();
  for (const pair of pairs) {
    if (pairIds.has(pair.id))
      throw new HttpError(400, "Doppelte Relations-ID.");
    pairIds.add(pair.id);
    for (const reverse of [false, true]) {
      const page = reverse ? pair.right_page : pair.left_page,
        field = reverse ? pair.right_field : pair.left_field;
      const targetPage = reverse ? pair.left_page : pair.right_page,
        targetField = reverse ? pair.left_field : pair.right_field;
      const source = databases.get(page),
        target = databases.get(targetPage),
        property = source?.fields.find((f) => f.id === field);
      const key = page + ":" + field;
      if (
        endpoints.has(key) ||
        !target ||
        property?.type !== "relation" ||
        property.relationPage !== targetPage
      )
        throw new HttpError(
          400,
          "Ungültige Rückrelation im Archiv oder in der Vorlage.",
        );
      endpoints.add(key);
      const targets = new Map(target.rows.map((r) => [r.id, r]));
      for (const row of source!.rows)
        for (const rid of ids.parse(row.cells[field] || [])) {
          const other = targets.get(rid);
          if (
            !other ||
            !ids.parse(other.cells[targetField] || []).includes(row.id)
          )
            throw new HttpError(
              400,
              "Unvollständige Rückrelation im Archiv oder in der Vorlage.",
            );
        }
    }
  }
}
