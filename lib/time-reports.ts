// Time reports over the entries of time properties (lib/time-tracking.ts):
// one database or a whole workspace, filtered by period, person, database,
// project (the records a time-tracked record relates to), billing status
// and billable flag, grouped by person, project, record, database, day or
// week, with totals, CSV export and billing.
//
// Who sees what: everyone sees their own entries; entries of others only on
// records they may read, and only when the time property is readable for
// them (field permissions). The billing status (open, billed, not
// billable) is changed by people who may edit the record and its time
// property. Hourly rates per person or per project belong to the workspace:
// its owners set them, members with edit rights see the amounts.
import { z } from "zod";
import { all, audit, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import { memberRole, isGuest, pageRole, requireMember, requirePage } from "./permissions";
import { hiddenRowIds, rowRoleResolver } from "./row-access";
import { hiddenFieldsFor, readOnlyFieldIds } from "./field-access";
import { cellText, CSV_FORMULA } from "./cell-text";
import { hours } from "./durations";
import type { Field, Identity, Page, Role } from "./types";

export const billingStates = ["open", "billed", "unbillable"] as const;
export type BillingState = (typeof billingStates)[number];
export const reportGroups = ["person", "project", "record", "database", "day", "week"] as const;
export type ReportGroup = (typeof reportGroups)[number];
export const reportPeriods = ["this-week", "this-month", "last-month", "custom"] as const;

const DAY = 86_400_000;
const LIST_LIMIT = 1000;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const reportFilterSchema = z.object({
  workspace: z.uuid().optional(),
  page: z.uuid().optional(),
  period: z.enum(reportPeriods).default("this-month"),
  from: day.optional(),
  to: day.optional(),
  person: z.uuid().optional(),
  database: z.uuid().optional(),
  // A related record's ID, or "none" for entries without a project.
  project: z.string().max(100).optional(),
  status: z.enum(billingStates).optional(),
  billable: z.enum(["yes", "no"]).optional(),
  group: z.enum(reportGroups).default("person"),
});
export type ReportFilter = z.input<typeof reportFilterSchema>;

const rank: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const midnight = (text: string) => new Date(`${text}T00:00:00`).getTime();
const monday = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

// The days of a period (server time zone, weeks from Monday); `end` is
// exclusive.
export function periodRange(period: (typeof reportPeriods)[number], from?: string, to?: string, now = Date.now()) {
  let start: Date, end: Date;
  if (period === "this-week") {
    start = monday(now);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
  } else if (period === "this-month" || period === "last-month") {
    const d = new Date(now);
    start = new Date(d.getFullYear(), d.getMonth() - (period === "last-month" ? 1 : 0), 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  } else {
    if (!from || !to) throw new HttpError(400, "Bitte Start- und Enddatum angeben.");
    if (from > to) throw new HttpError(400, "Das Startdatum liegt nach dem Enddatum.");
    start = new Date(midnight(from));
    end = new Date(midnight(to));
    end.setDate(end.getDate() + 1);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new HttpError(400, "Ungültiges Datum.");
    if (end.getTime() - start.getTime() > 3 * 366 * DAY) throw new HttpError(400, "Der Zeitraum darf höchstens drei Jahre umfassen.");
  }
  const last = new Date(end);
  last.setDate(last.getDate() - 1);
  return { from: localDay(start.getTime()), to: localDay(last.getTime()), start: start.getTime(), end: end.getTime() };
}

type RawEntry = {
  id: string;
  page_id: string;
  row_id: string;
  field_id: string;
  user_id: string;
  start: number;
  end: number | null;
  note: string;
  billing: BillingState;
  billed_at: number | null;
  name: string | null;
  page_title: string;
  workspace_id: string;
  cells: string | null;
  access: string | null;
  created_by: string | null;
};
export type ReportEntry = {
  id: string;
  pageId: string;
  database: string;
  rowId: string;
  title: string;
  // The record is not readable (own entries on a record hidden since).
  restricted: boolean;
  userId: string;
  person: string;
  projects: { id: string; title: string }[];
  start: number;
  end: number | null;
  seconds: number;
  note: string;
  billing: BillingState;
  rate: number | null;
  amount: number | null;
  editable: boolean;
};

// The property that names an entry's project: the first relation of the
// database that is not the parent of subtasks.
export const projectFieldOf = (fields: Field[]) => fields.find((f) => f.type === "relation" && !f.parent && f.relationPage);

type PageContext = {
  page: Page;
  role: Role | null;
  fields: Field[];
  hiddenRows: Set<string>;
  hiddenFields: Set<string>;
  readOnly: Set<string>;
  rowRole: (row: { id: string; access?: string; created_by?: string | null }) => Role | null;
  project?: Field;
};

function contexts(user: Identity) {
  const cache = new Map<string, PageContext | null>();
  return (pageId: string): PageContext | null => {
    if (cache.has(pageId)) return cache.get(pageId)!;
    const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
    let context: PageContext | null = null;
    if (page) {
      const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]") as Field[];
      const role = pageRole(user, page);
      context = {
        page,
        role,
        fields,
        hiddenRows: role ? hiddenRowIds(user, page) : new Set(),
        hiddenFields: role ? hiddenFieldsFor(user, page, fields, role) : new Set(),
        readOnly: role ? new Set(readOnlyFieldIds(user, page, fields)) : new Set(),
        rowRole: role ? rowRoleResolver(user, page, role) : () => null,
        project: projectFieldOf(fields),
      };
    }
    cache.set(pageId, context);
    return context;
  };
}

// Titles of related records, only where the reader may see them.
function projectTitles(user: Identity) {
  const pages = contexts(user);
  const cache = new Map<string, { id: string; title: string } | null>();
  return (rowId: string) => {
    if (cache.has(rowId)) return cache.get(rowId)!;
    const row = one<{ id: string; page_id: string; cells: string }>("SELECT id,page_id,cells FROM rows WHERE id=?", rowId);
    const context = row ? pages(row.page_id) : null;
    const result =
      row && context?.role && !context.hiddenRows.has(row.id)
        ? { id: row.id, title: cellText(JSON.parse(row.cells)[context.fields[0]?.id || "title"]) || ct("Ohne Titel", "Untitled") }
        : null;
    cache.set(rowId, result);
    return result;
  };
}

function rates(workspaceId: string) {
  const rows = all<{ kind: "person" | "project"; target_id: string; rate: number }>(
    "SELECT kind,target_id,rate FROM time_rates WHERE workspace_id=?",
    workspaceId,
  );
  return {
    person: new Map(rows.filter((r) => r.kind === "person").map((r) => [r.target_id, r.rate])),
    project: new Map(rows.filter((r) => r.kind === "project").map((r) => [r.target_id, r.rate])),
  };
}
export const currencyOf = (workspaceId: string) =>
  one<{ currency: string }>("SELECT currency FROM time_billing WHERE workspace_id=?", workspaceId)?.currency || "EUR";
const seeAmounts = (user: Identity, workspaceId: string) => {
  const role = memberRole(user, workspaceId);
  return !!role && rank[role] >= rank.editor && !isGuest(user, workspaceId);
};

// The workspace (and database) a report is about; refuses without access.
function scopeOf(user: Identity, filter: z.infer<typeof reportFilterSchema>) {
  if (filter.page) {
    const page = requirePage(user, filter.page);
    if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
    return { workspaceId: page.workspace_id, pageId: page.id };
  }
  if (!filter.workspace) throw new HttpError(400, "Arbeitsbereich oder Datenbank fehlt.");
  requireMember(user, filter.workspace);
  return { workspaceId: filter.workspace, pageId: null as string | null };
}

// Every entry of the report a person may see, newest first.
function reportEntries(user: Identity, filter: z.infer<typeof reportFilterSchema>, now = Date.now()) {
  const scope = scopeOf(user, filter);
  const range = periodRange(filter.period, filter.from, filter.to, now);
  const where = ["p.workspace_id=?", "p.deleted_at IS NULL", "e.start>=?", "e.start<?"];
  const args: (string | number)[] = [scope.workspaceId, range.start, range.end];
  const pageFilter = scope.pageId || filter.database;
  if (scope.pageId && filter.database && filter.database !== scope.pageId) return { scope, range, entries: [] as ReportEntry[] };
  if (pageFilter) {
    where.push("e.page_id=?");
    args.push(pageFilter);
  }
  if (filter.person) {
    where.push("e.user_id=?");
    args.push(filter.person);
  }
  if (filter.status) {
    where.push("e.billing=?");
    args.push(filter.status);
  }
  if (filter.billable) where.push(filter.billable === "yes" ? "e.billing!='unbillable'" : "e.billing='unbillable'");
  const raw = all<RawEntry>(
    `SELECT e.id,e.page_id,e.row_id,e.field_id,e.user_id,e.start,e.end,e.note,e.billing,e.billed_at,u.name,p.title page_title,p.workspace_id,r.cells,r.access,r.created_by
     FROM time_entries e JOIN pages p ON p.id=e.page_id LEFT JOIN rows r ON r.id=e.row_id LEFT JOIN users u ON u.id=e.user_id
     WHERE ${where.join(" AND ")} ORDER BY e.start DESC`,
    ...args,
  );
  return { scope, range, entries: evaluate(user, scope.workspaceId, raw, now, filter.project) };
}

// Raw entries → what this person sees of them (or nothing).
function evaluate(user: Identity, workspaceId: string, raw: RawEntry[], now: number, project?: string) {
  const pages = contexts(user);
  const titles = projectTitles(user);
  const rate = rates(workspaceId);
  const amounts = seeAmounts(user, workspaceId);
  const result: ReportEntry[] = [];
  for (const e of raw) {
    const context = pages(e.page_id);
    if (!context) continue;
    const mine = e.user_id === user.id;
    const readable = !!context.role && !context.hiddenRows.has(e.row_id) && !!e.cells;
    const timeVisible = !!context.role && !context.hiddenFields.has(e.field_id);
    if (!mine && !(readable && timeVisible)) continue;
    const cells = readable ? (JSON.parse(e.cells!) as Record<string, unknown>) : {};
    const projectField = context.project && !context.hiddenFields.has(context.project.id) ? context.project : undefined;
    const ids = projectField && Array.isArray(cells[projectField.id]) ? (cells[projectField.id] as unknown[]).filter((v): v is string => typeof v === "string") : [];
    const projects = ids.map(titles).filter((p): p is { id: string; title: string } => !!p);
    if (project && (project === "none" ? projects.length : !projects.some((p) => p.id === project))) continue;
    const seconds = Math.max(0, Math.round(((e.end ?? now) - e.start) / 1000));
    const hourly = (projects.length ? rate.project.get(projects[0].id) : undefined) ?? rate.person.get(e.user_id) ?? null;
    const rowRole = readable ? context.rowRole({ id: e.row_id, access: e.access || undefined, created_by: e.created_by }) : null;
    result.push({
      id: e.id,
      pageId: e.page_id,
      database: context.role ? e.page_title : "",
      rowId: e.row_id,
      title: readable ? cellText(cells[context.fields[0]?.id || "title"]) || ct("Ohne Titel", "Untitled") : "",
      restricted: !readable,
      userId: e.user_id,
      person: e.name || "?",
      projects,
      start: e.start,
      end: e.end,
      seconds,
      note: readable || mine ? e.note : "",
      billing: billingStates.includes(e.billing) ? e.billing : "open",
      rate: amounts ? hourly : null,
      amount: amounts && hourly !== null ? Math.round(hours(seconds) * hourly * 100) / 100 : null,
      editable:
        e.end !== null &&
        user.apiScope !== "read" &&
        !!rowRole &&
        rank[rowRole] >= rank.editor &&
        timeVisible &&
        !context.readOnly.has(e.field_id),
    });
  }
  return result;
}

function groupKey(e: ReportEntry, group: ReportGroup): { key: string; label: string } {
  if (group === "person") return { key: e.userId, label: e.person };
  if (group === "project")
    return e.projects.length ? { key: e.projects[0].id, label: e.projects[0].title } : { key: "none", label: ct("Ohne Projekt", "No project") };
  if (group === "record") return { key: e.rowId, label: e.restricted ? ct("Eintrag ohne Zugriff", "Record without access") : e.title };
  if (group === "database") return { key: e.pageId, label: e.database || ct("Datenbank ohne Zugriff", "Database without access") };
  if (group === "day") return { key: localDay(e.start), label: localDay(e.start) };
  const week = localDay(monday(e.start).getTime());
  return { key: week, label: week };
}

export function timeReportData(user: Identity, input: unknown, now = Date.now()) {
  const filter = reportFilterSchema.parse(input);
  const { scope, range, entries } = reportEntries(user, filter, now);
  const amounts = seeAmounts(user, scope.workspaceId);
  const groups = new Map<string, { key: string; label: string; seconds: number; amount: number | null; entries: number }>();
  const byStatus: Record<BillingState, number> = { open: 0, billed: 0, unbillable: 0 };
  let seconds = 0,
    amount = 0;
  const people = new Map<string, string>(),
    databases = new Map<string, string>(),
    projects = new Map<string, string>();
  for (const e of entries) {
    const { key, label } = groupKey(e, filter.group);
    const g = groups.get(key) || { key, label, seconds: 0, amount: amounts ? 0 : null, entries: 0 };
    g.seconds += e.seconds;
    g.entries++;
    if (g.amount !== null && e.amount !== null) g.amount = Math.round((g.amount + e.amount) * 100) / 100;
    groups.set(key, g);
    byStatus[e.billing] += e.seconds;
    seconds += e.seconds;
    if (e.amount !== null) amount += e.amount;
    people.set(e.userId, e.person);
    if (e.database) databases.set(e.pageId, e.database);
    for (const p of e.projects) projects.set(p.id, p.title);
  }
  const chronological = filter.group === "day" || filter.group === "week";
  return {
    workspaceId: scope.workspaceId,
    pageId: scope.pageId,
    from: range.from,
    to: range.to,
    group: filter.group,
    total: { seconds, amount: amounts ? Math.round(amount * 100) / 100 : null, entries: entries.length },
    byStatus,
    groups: [...groups.values()].sort((a, b) => (chronological ? a.key.localeCompare(b.key) : b.seconds - a.seconds)),
    entries: entries.slice(0, LIST_LIMIT),
    truncated: entries.length > LIST_LIMIT,
    options: {
      people: [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      databases: [...databases].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
      projects: [...projects].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
    },
    currency: currencyOf(scope.workspaceId),
    showAmounts: amounts,
    canEditRates: memberRole(user, scope.workspaceId) === "owner" && user.apiScope !== "read",
    rates: amounts ? listRates(scope.workspaceId) : [],
  };
}
export type TimeReportData = ReturnType<typeof timeReportData>;

/* ---------- Export ---------- */

// CSV of every entry of the report. "excel": semicolons, decimal commas and
// a byte order mark, as German Excel opens it with a double click.
export function timeReportCsv(user: Identity, input: unknown, variant: "csv" | "excel" = "csv", now = Date.now()) {
  const filter = reportFilterSchema.parse(input);
  const { scope, range, entries } = reportEntries(user, filter, now);
  const amounts = seeAmounts(user, scope.workspaceId);
  const sep = variant === "excel" ? ";" : ",";
  const number = (n: number | null) => (n === null ? "" : variant === "excel" ? String(n).replace(".", ",") : String(n));
  const cell = (v: unknown) => {
    const text = String(v ?? "");
    const safe = CSV_FORMULA.test(text) ? `'${text}` : text;
    return safe.includes(sep) || /["\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const time = (ms: number | null) => (ms === null ? "" : new Date(ms).toTimeString().slice(0, 5));
  const status = (s: BillingState) =>
    s === "billed" ? ct("abgerechnet", "billed") : s === "unbillable" ? ct("nicht abrechenbar", "not billable") : ct("offen", "open");
  const header = [
    ct("Datum", "Date"),
    ct("Person", "Person"),
    ct("Datenbank", "Database"),
    ct("Eintrag", "Record"),
    ct("Projekt", "Project"),
    ct("Notiz", "Note"),
    ct("Beginn", "Start"),
    ct("Ende", "End"),
    ct("Stunden", "Hours"),
    ct("Abrechnung", "Billing"),
    ...(amounts ? [ct("Stundensatz", "Hourly rate"), ct("Betrag", "Amount"), ct("Währung", "Currency")] : []),
  ];
  const currency = currencyOf(scope.workspaceId);
  const lines = [...entries]
    .reverse()
    .map((e) =>
      [
        localDay(e.start),
        e.person,
        e.database,
        e.restricted ? ct("Eintrag ohne Zugriff", "Record without access") : e.title,
        e.projects.map((p) => p.title).join(", "),
        e.note,
        time(e.start),
        time(e.end),
        number(hours(e.seconds)),
        status(e.billing),
        ...(amounts ? [number(e.rate), number(e.amount), e.amount === null ? "" : currency] : []),
      ]
        .map(cell)
        .join(sep),
    );
  const body = [header.map(cell).join(sep), ...lines].join("\r\n");
  return {
    name: `${ct("Zeiten", "Time||tracked")} ${range.from} – ${range.to}.csv`,
    body: variant === "excel" ? "﻿" + body : body,
  };
}

/* ---------- Billing and rates ---------- */

const billingSchema = z.object({
  status: z.enum(billingStates),
  // Single entries; without them, the filtered set of the report.
  ids: z.array(z.uuid()).max(5000).optional(),
  filter: reportFilterSchema.optional(),
  workspace: z.uuid().optional(),
});
export function setBilling(user: Identity, input: unknown, now = Date.now()) {
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  const body = billingSchema.parse(input);
  let entries: ReportEntry[];
  let workspaceId: string;
  if (body.ids) {
    if (!body.workspace) throw new HttpError(400, "Arbeitsbereich fehlt.");
    workspaceId = body.workspace;
    requireMember(user, workspaceId);
    if (!body.ids.length) return { changed: 0, skipped: 0 };
    const raw = all<RawEntry>(
      `SELECT e.id,e.page_id,e.row_id,e.field_id,e.user_id,e.start,e.end,e.note,e.billing,e.billed_at,u.name,p.title page_title,p.workspace_id,r.cells,r.access,r.created_by
       FROM time_entries e JOIN pages p ON p.id=e.page_id LEFT JOIN rows r ON r.id=e.row_id LEFT JOIN users u ON u.id=e.user_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND e.id IN (${body.ids.map(() => "?").join(",")})`,
      workspaceId,
      ...body.ids,
    );
    entries = evaluate(user, workspaceId, raw, now);
  } else {
    if (!body.filter) throw new HttpError(400, "Filter oder Einträge fehlen.");
    const report = reportEntries(user, reportFilterSchema.parse(body.filter), now);
    workspaceId = report.scope.workspaceId;
    // "Mark as billed" for a filtered set leaves entries that are not
    // billable as they are.
    entries = report.entries.filter((e) => !(body.status === "billed" && e.billing === "unbillable"));
  }
  const target = entries.filter((e) => e.billing !== body.status);
  const allowed = target.filter((e) => e.editable);
  if (!allowed.length && target.length) throw new HttpError(403, "Nur Personen mit Bearbeitungsrechten ändern den Abrechnungsstatus.");
  transaction(() => {
    const byPage = new Map<string, number>();
    for (const e of allowed) {
      run(
        "UPDATE time_entries SET billing=?,billed_at=?,billed_by=? WHERE id=?",
        body.status,
        body.status === "billed" ? now : null,
        body.status === "billed" ? user.id : null,
        e.id,
      );
      byPage.set(e.pageId, (byPage.get(e.pageId) || 0) + 1);
    }
    for (const [pageId, count] of byPage) audit(user.id, "time.billing", pageId, JSON.stringify({ status: body.status, entries: count }));
  });
  return { changed: allowed.length, skipped: target.length - allowed.length };
}

export function listRates(workspaceId: string) {
  return all<{ kind: "person" | "project"; target_id: string; rate: number }>(
    "SELECT kind,target_id,rate FROM time_rates WHERE workspace_id=? ORDER BY kind,target_id",
    workspaceId,
  ).map((r) => ({ kind: r.kind, targetId: r.target_id, rate: r.rate }));
}
const rateSchema = z.object({
  workspace: z.uuid(),
  kind: z.enum(["person", "project"]),
  targetId: z.uuid(),
  // Per hour in the workspace's currency; null removes the rate.
  rate: z.number().min(0).max(1_000_000).nullable(),
});
export function setRate(user: Identity, input: unknown) {
  const body = rateSchema.parse(input);
  if (requireMember(user, body.workspace, "editor") !== "owner")
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs legen Stundensätze fest.");
  if (body.kind === "person" && !one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", body.workspace, body.targetId))
    throw new HttpError(404, "Person nicht gefunden.");
  if (body.kind === "project" && !one("SELECT 1 FROM rows r JOIN pages p ON p.id=r.page_id WHERE r.id=? AND p.workspace_id=?", body.targetId, body.workspace))
    throw new HttpError(404, "Eintrag nicht gefunden.");
  if (body.rate === null)
    run("DELETE FROM time_rates WHERE workspace_id=? AND kind=? AND target_id=?", body.workspace, body.kind, body.targetId);
  else
    run(
      "INSERT INTO time_rates(workspace_id,kind,target_id,rate,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,kind,target_id) DO UPDATE SET rate=excluded.rate,updated_at=excluded.updated_at",
      body.workspace,
      body.kind,
      body.targetId,
      body.rate,
      Date.now(),
    );
  audit(user.id, "time.rate", body.targetId, JSON.stringify({ kind: body.kind, rate: body.rate }));
  return listRates(body.workspace);
}
export function setCurrency(user: Identity, input: unknown) {
  const body = z.object({ workspace: z.uuid(), currency: z.string().trim().regex(/^[A-Z]{3}$/) }).parse(input);
  if (requireMember(user, body.workspace, "editor") !== "owner")
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs legen Stundensätze fest.");
  run(
    "INSERT INTO time_billing(workspace_id,currency) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET currency=excluded.currency",
    body.workspace,
    body.currency,
  );
  audit(user.id, "time.currency", body.workspace, body.currency);
  return { currency: body.currency };
}
