// Sprints: time boxes with start, end and goal, kept in the database
// settings; a "Sprint" property says which sprint a record belongs to (none:
// backlog). Completing a sprint moves what is not done into the next sprint
// and keeps the numbers for velocity; the status log gives the burndown.
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { databaseSettings, storeSettings } from "./database-settings";
import { doneRule, isDone, type Sprint } from "./database-settings-schema";
import type { Field, Identity, Page, View } from "./types";

const day = /^\d{4}-\d{2}-\d{2}$/;
const fieldsOf = (pageId: string) => JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];
export const sprintField = (fields: Field[]) => fields.find((f) => f.type === "sprint");
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

function rowsOf(pageId: string) {
  return all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", pageId).map((r) => ({ id: r.id, cells: JSON.parse(r.cells) as Record<string, unknown> }));
}
function points(fields: Field[], pointsField: string | undefined, cells: Record<string, unknown>) {
  if (!pointsField) return 1;
  const v = Number(cells[pointsField]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function sprintCommand(user: Identity, page: Page, action: string, b: Record<string, unknown>) {
  const settings = databaseSettings(page.id);
  const sprints = [...(settings.sprints || [])];
  let fields = fieldsOf(page.id);
  const save = () => storeSettings(page.id, { ...settings, sprints });
  const find = (sprintId: unknown) => {
    const s = sprints.find((x) => x.id === sprintId);
    if (!s) throw new HttpError(404, "Sprint nicht gefunden.");
    return s;
  };
  if (action === "sprint.setup") {
    // First use: a "Sprint" property, a planning view and the first sprint.
    if (!sprintField(fields)) {
      fields = [...fields, { id: id(), name: "Sprint", type: "sprint" }];
      run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(fields), page.id);
    }
    const views = JSON.parse(one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", page.id)!.views) as View[];
    let viewId = views.find((v) => v.type === "sprint")?.id;
    if (!viewId) {
      viewId = id();
      views.push({ id: viewId, name: z.string().trim().min(1).max(80).catch("Sprints").parse(b.viewName), type: "sprint", filters: [], sorts: [] });
      run("UPDATE databases SET views=?,version=version+1 WHERE page_id=?", JSON.stringify(views), page.id);
    }
    if (!sprints.length) {
      sprints.push({ id: id(), name: "Sprint 1", start: today(), end: addDays(today(), 13), goal: "", state: "planned" });
      save();
    }
    return { viewId };
  }
  if (action === "sprint.create") {
    const last = sprints.filter((s) => s.state !== "closed").at(-1) || sprints.at(-1);
    const start = last ? addDays(last.end, 1) : today();
    const length = last ? Math.max(1, Math.round((Date.parse(last.end) - Date.parse(last.start)) / 86_400_000)) : 13;
    const sprint: Sprint = { id: id(), name: `Sprint ${sprints.length + 1}`, start, end: addDays(start, length), goal: "", state: "planned" };
    sprints.push(sprint);
    save();
    return sprint;
  }
  if (action === "sprint.update") {
    const s = find(b.sprintId);
    const input = z
      .object({
        name: z.string().trim().min(1).max(120),
        start: z.string().regex(day),
        end: z.string().regex(day),
        goal: z.string().trim().max(500).default(""),
      })
      .parse(b);
    if (input.end < input.start) throw new HttpError(400, "Das Ende liegt vor dem Start.");
    Object.assign(s, input);
    save();
    return s;
  }
  if (action === "sprint.start") {
    const s = find(b.sprintId);
    if (sprints.some((x) => x.state === "active" && x.id !== s.id)) throw new HttpError(409, "Es läuft schon ein Sprint. Schließe ihn zuerst ab.");
    s.state = "active";
    save();
    return s;
  }
  if (action === "sprint.complete") {
    const s = find(b.sprintId);
    const field = sprintField(fields);
    const rule = doneRule(fields, settings);
    const next = sprints.find((x) => x.state === "planned" && x.id !== s.id && x.start >= s.start) || sprints.find((x) => x.state === "planned" && x.id !== s.id);
    const target = b.moveTo === "backlog" ? null : b.moveTo ? find(b.moveTo) : next || null;
    let completed = 0,
      committed = 0,
      moved = 0;
    if (field)
      for (const r of rowsOf(page.id)) {
        if (r.cells[field.id] !== s.id) continue;
        const p = points(fields, settings.pointsField, r.cells);
        committed += p;
        if (isDone(rule, r.cells)) {
          completed += p;
          continue;
        }
        r.cells[field.id] = target?.id ?? "";
        run("UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?", JSON.stringify(r.cells), user.id, r.id);
        moved++;
      }
    Object.assign(s, { state: "closed", completed, committed, closedAt: new Date().toISOString() });
    save();
    return { sprint: s, moved, movedTo: target?.name ?? null };
  }
  if (action === "sprint.delete") {
    const s = find(b.sprintId);
    const field = sprintField(fields);
    if (field)
      for (const r of rowsOf(page.id))
        if (r.cells[field.id] === s.id) {
          r.cells[field.id] = "";
          run("UPDATE rows SET cells=?,version=version+1 WHERE id=?", JSON.stringify(r.cells), r.id);
        }
    sprints.splice(sprints.indexOf(s), 1);
    save();
    return { ok: true };
  }
  if (action === "sprint.points") {
    const pointsField = z.string().max(500).nullable().parse(b.pointsField ?? null);
    if (pointsField && !fields.some((f) => f.id === pointsField && f.type === "number")) throw new HttpError(400, "Story Points brauchen eine Zahl-Eigenschaft.");
    storeSettings(page.id, { ...settings, sprints, pointsField: pointsField || undefined });
    return { ok: true };
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// Burndown of a sprint: work remaining per day, against the ideal line.
export function sprintCharts(user: Identity, pageId: string, sprintId: string) {
  const page = requirePage(user, pageId);
  const settings = databaseSettings(pageId);
  const sprint = settings.sprints?.find((s) => s.id === sprintId);
  if (!sprint) throw new HttpError(404, "Sprint nicht gefunden.");
  const fields = fieldsOf(pageId);
  const field = sprintField(fields);
  const rule = doneRule(fields, settings);
  const hidden = hiddenRowIds(user, page);
  const rows = rowsOf(pageId).filter((r) => field && r.cells[field.id] === sprint.id && !hidden.has(r.id));
  const doneAt = new Map<string, number>();
  for (const e of all<{ row_id: string; done: number; at: number }>("SELECT row_id,done,at FROM row_status_log WHERE page_id=? ORDER BY at", pageId))
    if (e.done) doneAt.set(e.row_id, e.at);
    else doneAt.delete(e.row_id);
  const total = rows.reduce((s, r) => s + points(fields, settings.pointsField, r.cells), 0);
  const days: string[] = [];
  for (let d = sprint.start; d <= sprint.end && days.length < 120; d = addDays(d, 1)) days.push(d);
  const last = days.length - 1;
  const remaining = days.map((d) => {
    if (d > today()) return null;
    const end = Date.parse(`${d}T23:59:59`);
    return rows.reduce((s, r) => {
      const at = isDone(rule, r.cells) ? (doneAt.get(r.id) ?? Date.parse(`${sprint.start}T00:00:00`)) : Infinity;
      return s + (at <= end ? 0 : points(fields, settings.pointsField, r.cells));
    }, 0);
  });
  return {
    sprint,
    unit: settings.pointsField ? fields.find((f) => f.id === settings.pointsField)?.name || "Punkte" : null,
    days,
    remaining,
    ideal: days.map((_, i) => (last ? Math.round(total * (1 - i / last) * 10) / 10 : 0)),
    total,
    // Velocity: what the last closed sprints finished.
    velocity: (settings.sprints || [])
      .filter((s) => s.state === "closed")
      .slice(-8)
      .map((s) => ({ name: s.name, completed: s.completed ?? 0, committed: s.committed ?? 0 })),
  };
}
