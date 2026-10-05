// A single number from a database for dashboards: how many records, or the
// sum, average, minimum or maximum of a number property – over all records
// or those a view shows (its filters). Only for people who can read the
// database; private records count only when they can see them.
import { z } from "zod";
import { all, one } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { queryRows } from "./database";
import { relatedData } from "./related-data";
import { formatNumber } from "./field-format";
import { contentLocale } from "./content-locale";
import type { Field, Identity, Row, View } from "./types";

export const metricSchema = z.object({
  source: z.string().uuid(),
  view: z.string().max(80).optional().default(""),
  aggregate: z.enum(["count", "sum", "average", "min", "max"]).default("count"),
  field: z.string().max(80).optional().default(""),
});
export type MetricQuery = z.infer<typeof metricSchema>;

export function computeMetric(user: Identity, query: MetricQuery) {
  const page = requirePage(user, query.source);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  const raw = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", page.id);
  if (!raw) throw new HttpError(404, "Datenbank nicht gefunden.");
  const fields: Field[] = JSON.parse(raw.fields);
  const views: View[] = JSON.parse(raw.views);
  const view = views.find((v) => v.id === query.view);
  const rows = all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=?", page.id).map(
    (r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) }) as Row,
  );
  const { related, relatedSchemas } = relatedData(user, page);
  const shown = queryRows(
    visibleRows(user, page, rows),
    fields,
    view || ({ id: "all", name: "", type: "table", filters: [], sorts: [] } as View),
    "",
    related,
    relatedSchemas,
  );
  const field = fields.find((f) => f.id === query.field);
  let value: number | null = shown.length;
  if (query.aggregate !== "count") {
    if (!field) throw new HttpError(400, "Eigenschaft fehlt.");
    const numbers = shown
      .map((r) => r.cells[field.id])
      .map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN))
      .filter((n) => Number.isFinite(n));
    value = !numbers.length
      ? null
      : query.aggregate === "sum"
        ? numbers.reduce((a, b) => a + b, 0)
        : query.aggregate === "average"
          ? numbers.reduce((a, b) => a + b, 0) / numbers.length
          : query.aggregate === "min"
            ? Math.min(...numbers)
            : Math.max(...numbers);
  }
  // Numbers in the property's own format (currency, percent …).
  const formatted =
    value === null
      ? "–"
      : query.aggregate !== "count" && field?.type === "number"
        ? formatNumber(value, field.format, field.decimals)
        : value.toLocaleString(contentLocale() === "de" ? "de-DE" : "en-GB", { maximumFractionDigits: 2 });
  return {
    value,
    formatted,
    source: page.title || "",
    view: view?.name || "",
    field: field?.name || "",
    records: shown.length,
  };
}

// Databases and their views and number properties, for choosing a source.
export function metricSources(user: Identity, workspaceId: string) {
  return all<{ id: string; title: string; fields: string; views: string }>(
    "SELECT p.id,p.title,d.fields,d.views FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.kind='database' ORDER BY p.title",
    workspaceId,
  )
    .filter((p) => {
      try {
        requirePage(user, p.id);
        return true;
      } catch {
        return false;
      }
    })
    .map((p) => ({
      id: p.id,
      title: p.title,
      views: (JSON.parse(p.views) as View[]).filter((v) => v.type !== "form").map((v) => ({ id: v.id, name: v.name })),
      numbers: (JSON.parse(p.fields) as Field[])
        .filter((f) => ["number", "formula", "rollup"].includes(f.type))
        .map((f) => ({ id: f.id, name: f.name })),
    }));
}
