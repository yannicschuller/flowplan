import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { assertRowAccess } from "./row-access";
import { relatedData } from "./related-data";
import { queryRows } from "./database";
import {
  databaseGroups,
  groupCellValue,
  groupingField,
  subgroupingField,
  databaseSubgroups,
} from "./database-groups";
import { validateCellPatch } from "./database-operations";
import {
  MAX_ORDERED_ROWS,
  mapGroupRowOrder,
  orderedGroupRows,
  orderedRowIds,
} from "./row-order";
import type { Identity, Row, View, Field } from "./types";
function records(pageId: string) {
  return all<Omit<Row, "cells"> & { cells: string }>(
    "SELECT * FROM rows WHERE page_id=? ORDER BY position",
    pageId,
  ).map((r) => ({ ...r, cells: JSON.parse(r.cells) }) as Row);
}
function schema(pageId: string) {
  const d = one<{ fields: string; views: string; version: number }>(
    "SELECT fields,views,version FROM databases WHERE page_id=?",
    pageId,
  );
  if (!d) throw new HttpError(400, "Datenbank fehlt.");
  return {
    fields: JSON.parse(d.fields) as Field[],
    views: JSON.parse(d.views) as View[],
    version: d.version,
  };
}
function save(pageId: string, views: View[]) {
  if (views.some((v) => (v.rowOrder?.length || 0) > MAX_ORDERED_ROWS))
    throw new HttpError(413, "Zu viele Einträge für die manuelle Reihenfolge.");
  run(
    "UPDATE databases SET views=?,version=version+1 WHERE page_id=?",
    JSON.stringify(views),
    pageId,
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
}
export function validateViewRowOrders(pageId: string, views: View[]) {
  const ids = new Set(
    all<{ id: string }>("SELECT id FROM rows WHERE page_id=?", pageId).map(
      (r) => r.id,
    ),
  );
  for (const v of views)
    if (v.rowOrder?.some((r) => !ids.has(r)))
      throw new HttpError(
        400,
        "Reihenfolge enthält einen fremden oder gelöschten Eintrag.",
      );
}
// Called after deletes/duplicates, inside the same command transaction.
export function maintainRowOrders(
  pageId: string,
  copies?: Map<string, string>,
) {
  const d = schema(pageId),
    rows = records(pageId),
    ids = new Set(rows.map((r) => r.id)),
    copied = new Set(copies?.values());
  const views = d.views.map((v) => {
    if (v.groupRowOrder)
      v = {
        ...v,
        groupRowOrder: mapGroupRowOrder(v.groupRowOrder, (order) =>
          copies
            ? order.flatMap((r) => (copies.has(r) ? [r, copies.get(r)!] : [r]))
            : order.filter((r) => ids.has(r)),
        ),
      };
    if (!v.rowOrder) return v;
    return {
      ...v,
      rowOrder: copies
        ? orderedRowIds(
            rows.filter((r) => !copied.has(r.id)),
            v,
          ).flatMap((r) => (copies.has(r) ? [r, copies.get(r)!] : [r]))
        : v.rowOrder.filter((r) => ids.has(r)),
    };
  });
  if (JSON.stringify(views) !== JSON.stringify(d.views)) save(pageId, views);
}
export function moveRow(
  user: Identity,
  pageId: string,
  input: unknown,
  context?: {
    fields: Field[];
    views: View[];
    version: number;
    save: (views: View[]) => void;
  },
) {
  const b = z
    .object({
      viewId: z.string().min(1),
      version: z.number().int().positive(),
      rowId: z.string().uuid(),
      rowVersion: z.number().int().positive(),
      targetId: z.string().uuid().optional(),
      placement: z.enum(["before", "after", "start", "end"]),
      clearSorts: z.boolean().optional(),
      group: z
        .object({ from: z.string().max(2000), to: z.string().max(2000) })
        .optional(),
      subgroup: z
        .object({ from: z.string().max(2000), to: z.string().max(2000) })
        .optional(),
    })
    .parse(input);
  const page = requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const d = context || schema(pageId),
    view = d.views.find((v) => v.id === b.viewId);
  if (d.version !== b.version)
    throw new HttpError(409, "Die Ansicht wurde geändert. Bitte neu laden.");
  if (!view) throw new HttpError(404, "Ansicht fehlt.");
  if (view.type === "form")
    throw new HttpError(
      400,
      "Formularansichten haben keine Eintragsreihenfolge.",
    );
  if (view.sorts.length && !b.clearSorts)
    throw new HttpError(409, "Zuerst die aktive Sortierung aufheben.");
  const rows = records(pageId),
    row = rows.find((r) => r.id === b.rowId);
  if (!row) throw new HttpError(404, "Eintrag fehlt.");
  // Reordering is a view setting; changing groups changes the record.
  assertRowAccess(user, page, row, !!b.group);
  if (row.version !== b.rowVersion)
    throw new HttpError(409, "Der Eintrag wurde geändert. Bitte neu laden.");
  if ((b.placement === "before" || b.placement === "after") && !b.targetId)
    throw new HttpError(400, "Zieleintrag fehlt.");
  if (
    b.targetId === row.id ||
    (b.targetId && !rows.some((r) => r.id === b.targetId))
  )
    throw new HttpError(400, "Ungültiger Zieleintrag.");
  const related = relatedData(user, page);
  let order = view.sorts.length
    ? queryRows(
        rows,
        d.fields,
        { ...view, filters: [], filterGroup: undefined },
        "",
        related.related,
        related.relatedSchemas,
      ).map((r) => r.id)
    : orderedRowIds(rows, view);
  let columns: { key: string; ids: string[] }[] | undefined,
    source: string | undefined,
    column: string | undefined;
  if (b.subgroup && !b.group)
    throw new HttpError(400, "Untergruppe benötigt eine Gruppe.");
  if (b.group) {
    if (!["board", "table", "list"].includes(view.type))
      throw new HttpError(
        400,
        "Gruppenwechsel benötigt eine gruppierte Ansicht.",
      );
    const field = groupingField(d.fields, view),
      subfield = b.subgroup
        ? subgroupingField(d.fields, view, field)
        : undefined;
    const locked = (f?: Field) =>
      !f ||
      [
        "formula",
        "rollup",
        "created_at",
        "updated_at",
        "created_by",
        "updated_by",
      ].includes(f.type);
    if (locked(field) || (b.subgroup && locked(subfield)))
      throw new HttpError(400, "Gruppe kann nicht bearbeitet werden.");
    const groups = databaseGroups(
        queryRows(
          rows,
          d.fields,
          { ...view, filters: [], filterGroup: undefined },
          "",
          related.related,
          related.relatedSchemas,
        ),
        field,
        related.related,
      ),
      from = groups.find((g) => g.key === b.group!.from),
      to = groups.find((g) => g.key === b.group!.to);
    const subFrom =
        from && subfield && b.subgroup
          ? databaseSubgroups(from, subfield, related.related).find(
              (g) => g.key === b.subgroup!.from,
            )
          : undefined,
      subTargets =
        to && subfield && b.subgroup
          ? databaseGroups(to.rows, subfield, related.related)
          : [],
      subTo = subTargets.find((g) => g.key === b.subgroup?.to);
    if (
      !from?.rows.some((r) => r.id === row.id) ||
      !to ||
      (b.targetId && !to.rows.some((r) => r.id === b.targetId)) ||
      (b.subgroup &&
        (!subFrom?.rows.some((r) => r.id === row.id) ||
          !subTo ||
          (b.targetId && !subTo.rows.some((r) => r.id === b.targetId))))
    )
      throw new HttpError(
        409,
        "Die Gruppenzuordnung wurde geändert. Bitte neu laden.",
      );
    if (view.type === "board" && !b.clearSorts) {
      columns = groups.map((g) => ({
        key: g.key,
        ids: orderedGroupRows(g.rows, view.groupRowOrder?.[g.key]).map(
          (r) => r.id,
        ),
      }));
      source = from.key;
      column = to.key;
    }
    const patch: Record<string, unknown> = {};
    if (from.key !== to.key)
      patch[field!.id] = groupCellValue(
        field!,
        to.value,
        row.cells[field!.id],
        from.key,
      );
    if (subfield && subFrom && subTo && subFrom.key !== subTo.key)
      patch[subfield.id] = groupCellValue(
        subfield,
        subTo.value,
        row.cells[subfield.id],
        subFrom.key,
      );
    if (Object.keys(patch).length) {
      const cells = {
        ...row.cells,
        ...validateCellPatch(user, page, d.fields, patch),
      };
      if (JSON.stringify(cells).length > 200000)
        throw new HttpError(413, "Datensatz zu groß.");
      run(
        "UPDATE rows SET cells=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
        JSON.stringify(cells),
        user.id,
        row.id,
      );
    }
  }
  order = order.filter((r) => r !== row.id);
  const index =
    b.placement === "start"
      ? 0
      : b.placement === "end"
        ? order.length
        : order.indexOf(b.targetId!) + (b.placement === "after" ? 1 : 0);
  order.splice(index, 0, row.id);
  // A board column keeps its own card order, so a card listed in several
  // columns (multi-select) can sit at a different place in each.
  let groupRowOrder = view.groupRowOrder;
  if (columns && column !== undefined) {
    const known = new Set(columns.map((c) => c.key));
    groupRowOrder = Object.fromEntries(
      Object.entries(view.groupRowOrder || {}).filter(([key]) =>
        known.has(key),
      ),
    );
    // The view order changes below; other columns keep what they showed.
    for (const c of columns)
      if (!groupRowOrder[c.key] && c.ids.length) groupRowOrder[c.key] = c.ids;
    let ids = columns
      .find((c) => c.key === column)!
      .ids.filter((r) => r !== row.id);
    const at =
      b.placement === "start"
        ? 0
        : b.placement === "end"
          ? ids.length
          : ids.indexOf(b.targetId!) + (b.placement === "after" ? 1 : 0);
    ids.splice(at, 0, row.id);
    groupRowOrder[column] = ids;
    if (source !== column && groupRowOrder[source!]) {
      ids = groupRowOrder[source!].filter((r) => r !== row.id);
      if (ids.length) groupRowOrder[source!] = ids;
      else delete groupRowOrder[source!];
    }
  } else if (b.clearSorts) groupRowOrder = undefined;
  const views = d.views.map((v) =>
    v.id === view.id
      ? {
          ...v,
          rowOrder: order,
          sorts: b.clearSorts ? [] : v.sorts,
          groupRowOrder,
        }
      : v,
  );
  if (JSON.stringify(views) !== JSON.stringify(d.views)) {
    if (context) context.save(views);
    else save(pageId, views);
  }
  return { ok: true };
}
