// Records from all databases of a workspace in one list: "everything open
// that is assigned to me, in every project". Filters can be saved as named
// views per person (shown in "My tasks").
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage } from "./permissions";
import { visibleRows } from "./row-access";
import { cellText } from "./cell-text";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import { ticketId } from "./ticket-ids";
import type { Field, Identity, Page, Row } from "./types";

export const crossFilterSchema = z.object({
  mine: z.boolean().default(true),
  open: z.boolean().default(true),
  due: z.enum(["any", "overdue", "week", "dated"]).default("any"),
  databases: z.array(z.uuid()).max(100).default([]),
  query: z.string().trim().max(200).default(""),
});
export type CrossFilter = z.infer<typeof crossFilterSchema>;

const MAX = 500;
const dueField = (fields: Field[]) =>
  fields.find((f) => f.type === "date" && /fällig|due|deadline|frist|termin|bis/i.test(f.name)) || fields.find((f) => f.type === "date");

export function crossRecords(user: Identity, workspaceId: string, input: unknown) {
  requireMember(user, workspaceId);
  const filter = crossFilterSchema.parse(input ?? {});
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const pages = all<Page>("SELECT * FROM pages WHERE workspace_id=? AND kind='database' AND deleted_at IS NULL", workspaceId).filter(
    (p) => !filter.databases.length || filter.databases.includes(p.id),
  );
  const out: {
    pageId: string;
    database: string;
    icon: string;
    rowId: string;
    key: string;
    title: string;
    status: string;
    due: string | null;
    done: boolean;
  }[] = [];
  const databases: { id: string; title: string }[] = [];
  for (const page of pages) {
    try {
      requirePage(user, page.id);
    } catch {
      continue;
    }
    const raw = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id);
    if (!raw) continue;
    const fields = JSON.parse(raw.fields) as Field[];
    const people = fields.filter((f) => f.type === "person");
    // "Mine" needs a person property; such databases are skipped then.
    if (filter.mine && !people.length) continue;
    databases.push({ id: page.id, title: page.title });
    const rule = doneRule(fields, databaseSettings(page.id));
    const due = dueField(fields);
    const idField = fields.find((f) => f.type === "id");
    const rows = visibleRows(
      user,
      page,
      all<Row & { cells: string }>("SELECT * FROM rows WHERE page_id=? ORDER BY position", page.id),
    ).map((r) => ({ ...r, cells: JSON.parse(r.cells as unknown as string) as Record<string, unknown> }));
    for (const r of rows) {
      if (filter.mine && !people.some((f) => r.cells[f.id] === user.id || (Array.isArray(r.cells[f.id]) && (r.cells[f.id] as unknown[]).includes(user.id)))) continue;
      const done = isDone(rule, r.cells);
      if (filter.open && done) continue;
      const date = due && typeof r.cells[due.id] === "string" && r.cells[due.id] ? String(r.cells[due.id]).slice(0, 10) : null;
      if (filter.due === "dated" && !date) continue;
      if (filter.due === "overdue" && !(date && date < today && !done)) continue;
      if (filter.due === "week" && !(date && date <= week)) continue;
      const title = cellText(r.cells[fields[0]?.id || "title"]);
      const key = idField ? ticketId(idField, r.number) : "";
      if (filter.query && !`${title} ${key}`.toLowerCase().includes(filter.query.toLowerCase())) continue;
      out.push({
        pageId: page.id,
        database: page.title,
        icon: page.icon,
        rowId: r.id,
        key,
        title,
        status: rule && rule.field.type === "select" ? cellText(r.cells[rule.field.id]) : "",
        due: date,
        done,
      });
      if (out.length >= MAX) break;
    }
    if (out.length >= MAX) break;
  }
  // Dated first (soonest), then the rest by database.
  out.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.database.localeCompare(b.database, "de")));
  return { records: out, databases, limited: out.length >= MAX };
}

/* ---------- Saved views ---------- */

export function recordViews(user: Identity, workspaceId: string) {
  return all<{ id: string; name: string; config: string }>(
    "SELECT id,name,config FROM record_views WHERE user_id=? AND workspace_id=? ORDER BY created_at",
    user.id,
    workspaceId,
  ).map((v) => ({ id: v.id, name: v.name, filter: crossFilterSchema.parse(JSON.parse(v.config)) }));
}
export function saveRecordView(user: Identity, input: unknown) {
  const b = z.object({ workspaceId: z.uuid(), name: z.string().trim().min(1).max(80), filter: crossFilterSchema }).parse(input);
  requireMember(user, b.workspaceId);
  if ((one<{ n: number }>("SELECT count(*) n FROM record_views WHERE user_id=? AND workspace_id=?", user.id, b.workspaceId)?.n || 0) >= 30)
    throw new HttpError(400, "Höchstens 30 gespeicherte Ansichten.");
  const vid = id();
  run("INSERT INTO record_views(id,user_id,workspace_id,name,config,created_at) VALUES(?,?,?,?,?,?)", vid, user.id, b.workspaceId, b.name, JSON.stringify(b.filter), Date.now());
  return { id: vid };
}
export function deleteRecordView(user: Identity, input: unknown) {
  const viewId = z.uuid().parse((input as { viewId?: unknown })?.viewId);
  run("DELETE FROM record_views WHERE id=? AND user_id=?", viewId, user.id);
  return { ok: true };
}
