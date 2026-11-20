// Database queries on the server (#383 #12): MCP query_database, dashboard
// tiles and metrics. lib/database.ts queryRows() is the definition of what a
// view shows; this module gives the same answer without loading, computing
// and sorting every record in JavaScript:
//
//   1. The simple conditions of the view's filter go into SQL (JSON1 on
//      SQLite, the json/jsonb operators on PostgreSQL) as a *superset*: SQL
//      may let a record through that the filter rejects (non-ASCII text,
//      formatted text with markup, timestamps in a time zone, numbers beyond
//      2^53, …), never the other way round. Conditions it cannot judge
//      (formulas, rollups, relative dates, …) stay true there.
//   2. Of the records SQL lets through, only the id, the position, the
//      access columns and the cells the filter and the sorts read are
//      fetched; the filter, the row access rules and the order are then
//      applied exactly as queryRows() does (same functions).
//   3. Only the requested page of records is loaded whole and computed
//      (formulas, rollups).
//
// A filter or a sort on a formula, rollup or subtask progress, and a search
// text, need computed cells: then the records SQL let through are loaded
// whole and go through queryRows() itself. Without a filter, sorts and a
// saved order the page comes from SQL with LIMIT/OFFSET.
//
// tests/database-query.test.ts compares this with queryRows() for a broad
// matrix of filters, sorts and pages on SQLite and PostgreSQL.
import { all, sql } from "./db";
import type { Param } from "./db-driver/types";
import { computedCells, needsRelatedRows, queryRows, rowComparator, type QueryLabels } from "./database";
import { effectiveFilterGroup, filterCount, matchesFilterGroup } from "./database-filters";
import { calendarDay } from "./relative-dates";
import { isFormattedText } from "./inline-markdown";
import { ticketId } from "./ticket-ids";
import { relatedData } from "./related-data";
import { rowRoleResolver } from "./row-access";
import { hiddenFieldsFor, stripCells } from "./field-access";
import { pageRole } from "./permissions";
import type { Field, Filter, FilterGroup, Identity, Page, Role, Row, View } from "./types";

type Fragment = { sql: string; params: Param[] };
type Related = { related: Record<string, Row[]>; relatedSchemas: Record<string, Field[]> };

// Properties whose value is computed (from other records or properties):
// never judged in SQL, and a filter or sort on them needs computed cells.
const COMPUTED = new Set<Field["type"]>(["formula", "rollup", "progress"]);
// Properties whose value is a column of the record (computedCells()).
const COLUMN = new Set<Field["type"]>(["created_at", "updated_at", "created_by", "updated_by", "id"]);
// Field ids that can be written into a JSON path literal.
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const ASCII = /^[\x00-\x7f]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The SQL of one database dialect for a cell: its JSON type (named as
// SQLite's json_type() names them, 'missing' for an absent key), its text,
// its number, its list items.
type Cell = {
  type: string;
  text: string;
  num: string;
  // EXISTS over the items of a list cell (only evaluated for arrays).
  anyItem(where: (type: string, text: string) => string): string;
};
type Dialect = {
  cell(id: string): Cell;
  ascii(x: string): string;
  lower(x: string): string;
  has(x: string, param: string): string;
  // A carriage return as an SQL expression.
  cr: string;
  blankText(x: string): string;
  isDate(x: string): string;
  // The JSON text of a cell, for the second step.
  extract(id: string): string;
  // The FROM clause: the table as `r`, with `r.j` the parsed cells on PostgreSQL.
  from: string;
  // An OFFSET without a LIMIT needs this before it.
  noLimit: string;
};
const WHITESPACE_SQLITE = "' '||char(9,10,11,12,13)",
  WHITESPACE_PG = "' '||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)";
const sqliteSql: Dialect = {
  cell(id) {
    const path = `'$."${id}"'`;
    return {
      type: `coalesce(json_type(r.cells,${path}),'missing')`,
      text: `json_extract(r.cells,${path})`,
      num: `json_extract(r.cells,${path})`,
      anyItem: (where) => `EXISTS(SELECT 1 FROM json_each(r.cells,${path}) e WHERE ${where("e.type", "e.value")})`,
    };
  },
  ascii: (x) => `length(CAST(${x} AS BLOB))=length(${x})`,
  lower: (x) => `lower(${x})`,
  has: (x, p) => `instr(${x},${p})>0`,
  cr: "char(13)",
  blankText: (x) => `trim(${x},${WHITESPACE_SQLITE})=''`,
  isDate: (x) => `${x} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
  extract: (id) => `r.cells->'$."${id}"'`,
  from: "rows r WHERE r.page_id=?",
  noLimit: " LIMIT -1",
};
const pgType = (j: string) =>
  `(CASE jsonb_typeof(${j}) WHEN 'string' THEN 'text' WHEN 'number' THEN 'real' WHEN 'boolean' THEN ${j}#>>'{}' ELSE jsonb_typeof(${j}) END)`;
const postgresSql: Dialect = {
  cell(id) {
    const j = `(r.j->'${id}')`;
    return {
      type: `coalesce(${pgType(j)},'missing')`,
      text: `(r.j->>'${id}')`,
      num: `(r.j->>'${id}')::numeric`,
      anyItem: (where) => `EXISTS(SELECT 1 FROM jsonb_array_elements(${j}) e(v) WHERE ${where(pgType("e.v"), "(e.v#>>'{}')")})`,
    };
  },
  ascii: (x) => `octet_length(${x})=length(${x})`,
  // translate(): ASCII letters only, as SQLite's lower() (lower() would
  // follow the database's locale).
  lower: (x) => `translate(${x},'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`,
  has: (x, p) => `strpos(${x},${p})>0`,
  cr: "chr(13)",
  blankText: (x) => `btrim(${x},${WHITESPACE_PG})=''`,
  isDate: (x) => `${x} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
  // json (not jsonb): the cell's own text, keys in their order.
  extract: (id) => `(r.cells::json->'${id}')::text`,
  // OFFSET 0 keeps the subquery, so the cells are parsed once per record.
  from: "(SELECT rows.*,rows.cells::jsonb AS j FROM rows WHERE page_id=? OFFSET 0) r WHERE 1=1",
  noLimit: "",
};
const dialect = () => (sql.name === "postgres" ? postgresSql : sqliteSql);

const FALSE: Fragment = { sql: "1=0", params: [] };
const list = (values: string[]) => `(${values.map(() => "?").join(",")})`;
// Text with none of the characters inline Markdown reads (lib/inline-markdown.ts
// toPlain()): its plain text is itself.
function plainMarkdown(d: Dialect, x: string) {
  return [...["\\", "*", "_", "~", "`", "["].map((c) => `'${c}'`), d.cr].map((c) => `NOT (${d.has(x, c)})`).join(" AND ");
}

// One condition as SQL that is true for every record matches() keeps (see
// the top). null: not judged here.
function condition(d: Dialect, f: Filter, field: Field, fields: Field[]): Fragment | null {
  if (COMPUTED.has(field.type) || COLUMN.has(field.type) || !SAFE_ID.test(field.id)) return null;
  const c = d.cell(field.id);
  const T = c.type,
    V = c.text,
    N = c.num;
  const big = `(${N}>${MAX_SAFE} OR ${N}<-${MAX_SAFE})`;
  const num = `${T} IN ('integer','real')`;
  // Text SQL can compare like JavaScript: ASCII (lower() folds ASCII only)
  // and, for formatted text, without Markdown.
  const unsure = `NOT (${d.ascii(V)})${isFormattedText(field, fields) ? ` OR NOT (${plainMarkdown(d, V)})` : ""}`;
  const v = f.value.toLowerCase();
  const isDateField = field.type === "date";
  switch (f.op) {
    case "contains":
    case "starts_with":
    case "ends_with":
    case "not_contains": {
      if (!v || !ASCII.test(v)) return null;
      const n = v.length;
      const low = d.lower(V);
      const match =
        f.op === "starts_with"
          ? `substr(${low},1,${n})=?`
          : f.op === "ends_with"
            ? `(length(${V})>=${n} AND substr(${low},length(${V})-${n - 1})=?)`
            : d.has(low, "?");
      if (f.op === "not_contains")
        return { sql: `(CASE WHEN ${T}<>'text' THEN 1=1 WHEN ${unsure} THEN 1=1 ELSE NOT (${match}) END)`, params: [v] };
      return {
        sql: `(CASE WHEN ${T} IN ('missing','null') THEN 1=0 WHEN ${T}<>'text' THEN 1=1 WHEN ${unsure} THEN 1=1 ELSE ${match} END)`,
        params: [v],
      };
    }
    case "eq":
    case "neq": {
      if (!v) return null;
      const eq = f.op === "eq";
      if (isDateField) {
        const day = calendarDay(v);
        // matches(): a date property compared with something not a date
        // (lists are compared item by item before that).
        if (!Number.isFinite(day)) return { sql: `${T}='array'`, params: [] };
        const canon = v.slice(0, 10);
        return {
          sql: eq
            ? `(CASE WHEN ${T}='array' THEN 1=1 WHEN ${T}<>'text' THEN 1=0 WHEN length(${V})>10 THEN 1=1 ELSE ${V}=? END)`
            : `(CASE WHEN ${T}<>'text' THEN 1=1 WHEN length(${V})>10 THEN 1=1 ELSE ${V}<>? END)`,
          params: [canon],
        };
      }
      if (field.type === "number") {
        if (!v.trim()) return null;
        const b = Number(v);
        if (!Number.isFinite(b)) return null;
        return {
          sql: eq
            ? `(CASE WHEN ${num} THEN (${N}=? OR ${big}) WHEN ${T} IN ('missing','null') THEN 1=0 ELSE 1=1 END)`
            : `(CASE WHEN ${num} THEN (${N}<>? OR ${big}) ELSE 1=1 END)`,
          params: [b],
        };
      }
      if (!ASCII.test(v)) return null;
      return {
        sql: eq
          ? `(CASE WHEN ${T} IN ('missing','null') THEN 1=0 WHEN ${T}<>'text' THEN 1=1 WHEN ${unsure} THEN 1=1 ELSE ${d.lower(V)}=? END)`
          : `(CASE WHEN ${T}<>'text' THEN 1=1 WHEN ${unsure} THEN 1=1 ELSE ${d.lower(V)}<>? END)`,
        params: [v],
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const b = Number(v);
      if (!v.trim() || !Number.isFinite(b)) return FALSE;
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op];
      return { sql: `(CASE WHEN ${num} THEN (${N}${op}? OR ${big}) WHEN ${T} IN ('missing','null') THEN 1=0 ELSE 1=1 END)`, params: [b] };
    }
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      if (!Number.isFinite(calendarDay(f.value))) return FALSE;
      const op = { before: "<", after: ">", on_or_before: "<=", on_or_after: ">=" }[f.op];
      // A date (YYYY-MM-DD) compares as text; a timestamp's day depends on
      // the condition's time zone: JavaScript decides.
      return {
        sql: `(CASE WHEN ${T}<>'text' THEN 1=0 WHEN length(${V})>10 THEN 1=1 WHEN ${d.isDate(V)} THEN ${V}${op}? ELSE 1=0 END)`,
        params: [f.value.slice(0, 10)],
      };
    }
    case "between": {
      if (isDateField) {
        const a = calendarDay(f.value),
          b = calendarDay(f.to);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return FALSE;
        const [lo, hi] = a <= b ? [f.value, f.to!] : [f.to!, f.value];
        return {
          sql: `(CASE WHEN ${T}<>'text' THEN 1=0 WHEN length(${V})>10 THEN 1=1 WHEN ${d.isDate(V)} THEN ${V} BETWEEN ? AND ? ELSE 1=0 END)`,
          params: [lo.slice(0, 10), hi.slice(0, 10)],
        };
      }
      const a = Number(f.value),
        b = Number(f.to);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return FALSE;
      return {
        sql: `(CASE WHEN ${num} THEN (${N} BETWEEN ? AND ? OR ${big}) WHEN ${T} IN ('missing','null') THEN 1=0 ELSE 1=1 END)`,
        params: [Math.min(a, b), Math.max(a, b)],
      };
    }
    case "checked":
      return { sql: `${T}='true'`, params: [] };
    case "unchecked":
      return { sql: `${T}<>'true'`, params: [] };
    case "empty":
      return {
        sql: `(CASE WHEN ${T} IN ('missing','null','array') THEN 1=1 WHEN ${T}='text' THEN (NOT (${d.ascii(V)}) OR ${d.blankText(V)}) ELSE ${field.type === "checkbox" ? `${T}<>'true'` : "1=0"} END)`,
        params: [],
      };
    case "notempty":
      return {
        sql: `(CASE WHEN ${T} IN ('missing','null') THEN 1=0 WHEN ${T}='array' THEN 1=1 WHEN ${T}='text' THEN (NOT (${d.ascii(V)}) OR NOT (${d.blankText(V)})) ELSE ${field.type === "checkbox" ? `${T}='true'` : "1=1"} END)`,
        params: [],
      };
    case "any_of":
    case "none_of":
    case "all_of": {
      const wanted = (f.values || []).map((x) => x.toLowerCase());
      if (!wanted.length) return f.op === "none_of" ? null : FALSE;
      if (!wanted.every((w) => ASCII.test(w))) return null;
      // Possibly one of `values` (an item SQL cannot compare counts as one).
      const maybe = (values: string[]): Fragment => ({
        sql: `(CASE WHEN ${T}='text' THEN (NOT (${d.ascii(V)}) OR (NOT (${d.blankText(V)}) AND ${d.lower(V)} IN ${list(values)})) WHEN ${T}='array' THEN ${c.anyItem(
          (type, text) => `(${type}<>'text' OR NOT (${d.ascii(text)}) OR ${d.lower(text)} IN ${list(values)})`,
        )} WHEN ${T} IN ('missing','null') THEN 1=0 ELSE 1=1 END)`,
        params: [...values, ...values],
      });
      if (f.op === "any_of") return maybe(wanted);
      if (f.op === "all_of") return and(wanted.map((w) => maybe([w])));
      // none_of: only records that certainly hold one of them are left out.
      return {
        sql: `NOT (CASE WHEN ${T}='text' THEN (${d.ascii(V)} AND NOT (${d.blankText(V)}) AND ${d.lower(V)} IN ${list(wanted)}) WHEN ${T}='array' THEN ${c.anyItem(
          (type, text) => `(${type}='text' AND ${d.ascii(text)} AND ${d.lower(text)} IN ${list(wanted)})`,
        )} ELSE 1=0 END)`,
        params: [...wanted, ...wanted],
      };
    }
    default:
      return null;
  }
}
function and(parts: (Fragment | null)[]): Fragment | null {
  const known = parts.filter((p): p is Fragment => !!p);
  if (!known.length) return null;
  if (known.some((p) => p === FALSE)) return FALSE;
  return { sql: known.map((p) => `(${p.sql})`).join(" AND "), params: known.flatMap((p) => p.params) };
}
function or(parts: (Fragment | null)[]): Fragment | null {
  if (parts.some((p) => !p)) return null;
  const known = (parts as Fragment[]).filter((p) => p !== FALSE);
  if (!known.length) return FALSE;
  return { sql: known.map((p) => `(${p.sql})`).join(" OR "), params: known.flatMap((p) => p.params) };
}
// The filter group as SQL, true for at least every record
// matchesFilterGroup() keeps; null when nothing can be narrowed. `hidden`:
// properties whose cells the reader does not see (they count as empty).
export function filterSql(group: FilterGroup, fields: Field[], hidden: Set<string> = new Set()): Fragment | null {
  const d = dialect();
  const byId = new Map(fields.map((f) => [f.id, f]));
  const node = (g: FilterGroup): Fragment | null => {
    const rules = g.rules.filter((rule) => filterCount(rule) > 0);
    if (!rules.length) return null;
    const parts = rules.map((rule) => {
      if (rule.kind === "group") return node(rule);
      const field = byId.get(rule.field);
      // matchesFilterGroup(): a condition on an unknown property is false.
      if (!field) return FALSE;
      if (hidden.has(field.id)) return null;
      return condition(d, rule, field, fields);
    });
    return g.join === "and" ? and(parts) : or(parts);
  };
  return node(group);
}

// The properties a filter group reads.
function filterFieldIds(group: FilterGroup, out = new Set<string>()) {
  for (const rule of group.rules) {
    if (rule.kind === "group") filterFieldIds(rule, out);
    else out.add(rule.field);
  }
  return out;
}

export type DatabaseQuery = {
  // Search text (as the table's search box).
  query?: string;
  offset?: number;
  // Records of the answer; all when left out.
  limit?: number;
  now?: Date;
  labels?: QueryLabels;
  // Related data already read (relatedData()), e.g. for an answer that
  // sends it along; otherwise read only when a rollup, subtask progress or a
  // sort or search by a relation needs it.
  related?: Related;
  // Only the number of records the view shows.
  countOnly?: boolean;
  // The reader's role on the database page, when known.
  role?: Role | null;
};
type Light = {
  id: string;
  position: number;
  access?: string;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
  updated_by?: string | null;
  number?: number | null;
  [key: `c${number}`]: string | null;
};

// What queryRows(visibleRows(rows), fields, view, query, related, …) gives,
// sliced to [offset, offset + limit): the records with computed cells, and
// how many there are in all. `fields`: the properties as the caller passes
// them to queryRows() (the visible ones, or all with hidden cells empty).
export async function queryDatabaseRows(
  user: Identity,
  page: Page,
  fields: Field[],
  view: Pick<View, "filters" | "filterGroup" | "sorts" | "rowOrder">,
  options: DatabaseQuery = {},
): Promise<{ total: number; rows: (Row & { role: Role })[] }> {
  const d = dialect();
  const now = options.now || new Date();
  const query = options.query || "";
  const offset = Math.max(0, options.offset || 0);
  const role = options.role !== undefined ? options.role : await pageRole(user, page);
  const hidden = await hiddenFieldsFor(user, page, undefined, role);
  const resolve = await rowRoleResolver(user, page, role);
  const group = effectiveFilterGroup(view);
  const where = filterSql(group, fields, hidden);
  if (where === FALSE) return { total: 0, rows: [] };
  const byId = new Map(fields.map((f) => [f.id, f]));
  const sorts = view.sorts || [];
  const reads = filterFieldIds(group);
  for (const s of sorts) reads.add(s.field);
  // Computed cells, a search, or a sort by the titles of related records.
  const computed =
    !!query ||
    [...reads].some((id) => COMPUTED.has(byId.get(id)?.type as Field["type"])) ||
    sorts.some((s) => byId.get(s.field)?.type === "relation");
  let related = options.related;
  const loadRelated = async () => (related ??= needsRelatedRows(fields, view, query) ? await relatedData(user, page) : { related: {}, relatedSchemas: {} });
  const params: Param[] = [page.id, ...(where?.params || [])];
  const condition = where ? ` AND (${where.sql})` : "";
  // Whole records of the database (`filter`: more conditions on `id`), as
  // visibleRows() gives them.
  const full = async (filter: string, filterParams: Param[], tail = "") =>
    (await all<Row & { cells: string }>(`SELECT * FROM rows WHERE page_id=?${filter} ORDER BY position${tail}`, page.id, ...filterParams)).flatMap((r) => {
      const rowRole = resolve(r);
      return rowRole ? [{ ...r, cells: stripCells(JSON.parse(r.cells) as Row["cells"], hidden), role: rowRole }] : [];
    });
  const compute = async (rows: (Row & { role: Role })[]) => {
    const { related: rel, relatedSchemas } = await loadRelated();
    return rows.map((r) => ({ ...r, cells: computedCells(r, fields, rel, relatedSchemas, now) }));
  };
  const slice = <T>(rows: T[]) => (options.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + options.limit));

  if (computed) {
    // Computed cells or a search: the records SQL let through, whole, through
    // queryRows() itself.
    const rows = await full(where ? ` AND id IN (SELECT r.id FROM ${d.from}${condition})` : "", where ? params : []);
    const { related: rel, relatedSchemas } = await loadRelated();
    const shown = queryRows(rows, fields, view as View, query, rel, relatedSchemas, now, options.labels);
    return { total: shown.length, rows: options.countOnly ? [] : slice(shown) };
  }

  if (!filterCount(group) && !sorts.length && !view.rowOrder?.length) {
    // No filter, no order of its own: the page straight from SQL, without
    // the records hidden from this reader.
    const restricted = (await all<{ id: string; access: string; created_by: string | null }>(
      "SELECT id,access,created_by FROM rows WHERE page_id=? AND access<>'inherit'",
      page.id,
    )).filter((r) => !resolve(r));
    const not = restricted.length ? ` AND id NOT IN ${sql.jsonValues()}` : "";
    const notParams: Param[] = restricted.length ? [JSON.stringify(restricted.map((r) => r.id))] : [];
    const total = Number((await all<{ n: number }>(`SELECT count(*) AS n FROM rows WHERE page_id=?${not}`, page.id, ...notParams))[0]?.n || 0);
    if (options.countOnly) return { total, rows: [] };
    const limit = options.limit;
    const rows = await full(
      not,
      [...notParams, ...(limit !== undefined ? [limit] : []), ...(offset ? [offset] : [])],
      `${limit !== undefined ? " LIMIT ?" : offset ? d.noLimit : ""}${offset ? " OFFSET ?" : ""}`,
    );
    return { total, rows: await compute(rows) };
  }

  // The cells the filter and the sorts read, nothing else.
  const ids = [...reads].filter((id) => !hidden.has(id) && !COLUMN.has(byId.get(id)?.type as Field["type"]));
  const safe = ids.every((id) => SAFE_ID.test(id));
  const columns = safe ? ids.map((id, i) => `,${d.extract(id)} AS c${i}`).join("") : ",r.cells";
  const light = await all<Light & { cells?: string }>(
    `SELECT r.id,r.position,r.access,r.created_by,r.created_at,r.updated_at,r.updated_by,r.number${columns} FROM ${d.from}${condition} ORDER BY r.position`,
    ...params,
  );
  const fieldIds = new Set(fields.map((f) => f.id));
  const candidates: (Pick<Row, "id" | "position" | "cells">)[] = [];
  for (const r of light) {
    if (!resolve(r)) continue;
    const cells: Record<string, unknown> = {};
    const all = safe ? null : (JSON.parse(r.cells || "{}") as Record<string, unknown>);
    ids.forEach((id, i) => {
      const raw = safe ? r[`c${i}`] : all![id] === undefined ? null : JSON.stringify(all![id]);
      if (raw === null || raw === undefined) return;
      let value = JSON.parse(raw) as unknown;
      // computedCells(): a number that is not finite is an error.
      if (typeof value === "number" && !Number.isFinite(value) && fieldIds.has(id)) value = "#ERROR";
      cells[id] = value;
    });
    for (const id of reads) {
      const field = byId.get(id);
      if (field && COLUMN.has(field.type))
        cells[id] = field.type === "id" ? ticketId(field, r.number) : r[field.type as "created_at"];
    }
    candidates.push({ id: r.id, position: r.position, cells });
  }
  const matched = candidates.filter((r) => matchesFilterGroup(r.cells, group, fields, now));
  if (options.countOnly) return { total: matched.length, rows: [] };
  if (sorts.length || view.rowOrder?.length) matched.sort(rowComparator(fields, view, {}, {}, options.labels));
  const wanted = slice(matched).map((r) => r.id);
  if (!wanted.length) return { total: matched.length, rows: [] };
  const loaded = new Map(
    (await full(` AND id IN ${sql.jsonValues()}`, [JSON.stringify(wanted)])).map((r) => [r.id, r]),
  );
  const rows = wanted.flatMap((id) => (loaded.has(id) ? [loaded.get(id)!] : []));
  return { total: matched.length, rows: await compute(rows) };
}
