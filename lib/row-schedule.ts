import { z } from "zod";
import { all, one, run, nowText } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { assertRowAccess, assertRowsWritable } from "./row-access";
import {
  createsCycle,
  dateDay,
  dependencyFields,
  rowRange,
  scheduleFields,
  schedulePatch,
} from "./database-timeline";
import { followShifts, linkedDelta, planInputs, planShifts, rangePatch, shiftModeOf } from "./timeline-plan";
import { calendarChangeSchema, calendarPatch } from "./database-calendar";
import { assertNoNewTimes } from "./database-operations";
import { assertFieldsWritable } from "./field-access";
import type { Field, Identity, View } from "./types";
import { rowChanged } from "./automations";
// The properties a write changes: property write rules apply to them as
// they do for row.update (lib/field-access.ts, #488).
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
const changeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("set"),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/),
  }),
  z.object({
    operation: z.enum(["move", "resize-start", "resize-end"]),
    days: z.number().int().min(-366000).max(366000),
  }),
]);
export { linkedDelta };
// Executes inside the command transaction, including linked-view mutations.
export async function scheduleRow(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
  context?: { fields: Field[]; views: View[]; version: number },
) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = await one<{ fields: string; views: string; version: number }>(
    "SELECT * FROM databases WHERE page_id=?",
    pageId,
  );
  if (!stored) throw new HttpError(400, "Datenbank fehlt.");
  const db = context || {
    fields: JSON.parse(stored.fields) as Field[],
    views: JSON.parse(stored.views) as View[],
    version: stored.version,
  };
  if (input.version !== db.version)
    throw new HttpError(
      409,
      "Die Ansicht wurde inzwischen geändert. Bitte neu laden.",
    );
  const view = db.views.find((v) => v.id === input.viewId);
  if (!view || !["timeline", "calendar"].includes(view.type))
    throw new HttpError(400, "Kalender- oder Timeline-Ansicht fehlt.");
  const rid = z.string().uuid().parse(input.rowId),
    row = await one<{ id: string; cells: string; version: number }>(
      "SELECT id,cells,version,access,created_by FROM rows WHERE id=? AND page_id=?",
      rid,
      pageId,
    );
  if (!row) throw new HttpError(404, "Datensatz fehlt.");
  await assertRowAccess(user, page, row, true);
  if (input.rowVersion !== row.version)
    throw new HttpError(
      409,
      "Datensatz wurde inzwischen geändert. Dein Entwurf bleibt erhalten.",
    );
  const cells = JSON.parse(row.cells),
    change = z.union([changeSchema, calendarChangeSchema]).parse(input.change);
  let patch;
  try {
    patch =
      "timeZone" in change
        ? calendarPatch({ cells }, db.fields, view, change)
        : schedulePatch({ cells }, db.fields, view, change);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  // A date property without time gets no new time here either (#327).
  assertNoNewTimes(db.fields, patch, cells);
  await assertFieldsWritable(user, page, db.fields, changedKeys(cells, patch));
  const nextCells = JSON.stringify({ ...cells, ...patch });
  if (nextCells.length > 200000) throw new HttpError(413, "Datensatz zu groß.");
  // What waits for the record follows it under the view's shift mode
  // (#395, lib/timeline-plan.ts): only as far as a link needs ("overlap"),
  // or by as many days as the linked end of the record moved ("keep", the
  // old "Nachfolger mitverschieben") – its start for start-based links
  // (ss, sf), its end for end-based ones (fs, ff) –, optionally off
  // weekends.
  let moved = 0;
  if (view.type === "timeline" && shiftModeOf(view.timeline) !== "off") {
    const field = dependencyFields(db.fields, pageId).find(
      (f) => f.id === view.timeline?.dependencyField,
    );
    const { start, end } = scheduleFields(db.fields, view);
    const before = rowRange({ cells }, start, end),
      after = rowRange({ cells: JSON.parse(nextCells) }, start, end);
    const days = before && after ? linkedDelta(view.timeline?.dependencyType, before, after) : 0;
    if (field && after && (days || shiftModeOf(view.timeline) === "overlap")) {
      const rows = (await all<{ id: string; cells: string }>(
        "SELECT id,cells FROM rows WHERE page_id=?",
        pageId,
      )).map((r) => ({ id: r.id, cells: JSON.parse(r.cells) as Record<string, unknown> }));
      const shifts = followShifts(rows, field, start, end, view.timeline, { id: rid, range: after }, days);
      if (!shifts)
        throw new HttpError(409, "Zyklische Abhängigkeiten lassen sich nicht auflösen.");
      await assertRowsWritable(user, page, shifts.keys());
      for (const [sid, target] of shifts) {
        const successor = rows.find((r) => r.id === sid)!;
        const next = { ...successor.cells, ...rangePatch(successor, db.fields, view, rowRange(successor, start, end)!, target) };
        await assertFieldsWritable(user, page, db.fields, changedKeys(successor.cells, next));
        await run(
          "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
          JSON.stringify(next), nowText(),
          user.id,
          sid,
        );
        await rowChanged(user, page, sid, successor.cells, next, db.fields);
      }
      moved = shifts.size;
    }
  }
  await run(
    "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
    nextCells, nowText(),
    user.id,
    rid,
  );
  await rowChanged(user, page, rid, cells, JSON.parse(nextCells), db.fields);
  return { ok: true, moved };
}

// Dragging from the end of one bar onto another: the other waits for the
// first. Refused when it would close a circle.
export async function linkTimeline(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = await one<{ fields: string; views: string; version: number }>(
    "SELECT * FROM databases WHERE page_id=?",
    pageId,
  );
  if (!stored) throw new HttpError(400, "Datenbank fehlt.");
  if (input.version !== stored.version)
    throw new HttpError(409, "Die Ansicht wurde inzwischen geändert. Bitte neu laden.");
  const fields = JSON.parse(stored.fields) as Field[],
    view = (JSON.parse(stored.views) as View[]).find((v) => v.id === input.viewId);
  if (!view || view.type !== "timeline") throw new HttpError(400, "Timeline-Ansicht fehlt.");
  const field = dependencyFields(fields, pageId).find((f) => f.id === view.timeline?.dependencyField);
  if (!field) throw new HttpError(400, "Keine Abhängigkeiten eingerichtet.");
  const from = z.string().uuid().parse(input.from),
    to = z.string().uuid().parse(input.to);
  const rows = await all<{ id: string; cells: string; version: number; access: string; created_by: string }>(
    "SELECT id,cells,version,access,created_by FROM rows WHERE page_id=?",
    pageId,
  );
  const source = rows.find((r) => r.id === from),
    target = rows.find((r) => r.id === to);
  if (!source || !target) throw new HttpError(404, "Datensatz fehlt.");
  await assertRowAccess(user, page, source, false);
  await assertRowAccess(user, page, target, true);
  const parsed = rows.map((r) => ({ id: r.id, cells: JSON.parse(r.cells) as Record<string, unknown> }));
  if (createsCycle(parsed, field, from, to))
    throw new HttpError(409, "Diese Abhängigkeit würde einen Kreis bilden.");
  const cells = parsed.find((r) => r.id === to)!.cells;
  const current = Array.isArray(cells[field.id]) ? (cells[field.id] as unknown[]) : [];
  if (current.includes(from)) return { ok: true, added: false };
  if (current.length >= 500) throw new HttpError(413, "Zu viele Abhängigkeiten.");
  await assertFieldsWritable(user, page, fields, [field.id]);
  const next = { ...cells, [field.id]: [...current, from] };
  await run(
    "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
    JSON.stringify(next), nowText(),
    user.id,
    to,
  );
  await rowChanged(user, page, to, cells, next, fields);
  return { ok: true, added: true };
}

// The × at the end of an arrow (#395): `to` no longer waits for `from`.
export async function unlinkTimeline(user: Identity, pageId: string, input: Record<string, unknown>) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = await one<{ fields: string; views: string; version: number }>("SELECT * FROM databases WHERE page_id=?", pageId);
  if (!stored) throw new HttpError(400, "Datenbank fehlt.");
  if (input.version !== stored.version) throw new HttpError(409, "Die Ansicht wurde inzwischen geändert. Bitte neu laden.");
  const fields = JSON.parse(stored.fields) as Field[],
    view = (JSON.parse(stored.views) as View[]).find((v) => v.id === input.viewId);
  if (!view || view.type !== "timeline") throw new HttpError(400, "Timeline-Ansicht fehlt.");
  const field = dependencyFields(fields, pageId).find((f) => f.id === view.timeline?.dependencyField);
  if (!field) throw new HttpError(400, "Keine Abhängigkeiten eingerichtet.");
  const from = z.string().uuid().parse(input.from),
    to = z.string().uuid().parse(input.to);
  const target = await one<{ id: string; cells: string; version: number; access: string; created_by: string }>(
    "SELECT id,cells,version,access,created_by FROM rows WHERE id=? AND page_id=?",
    to,
    pageId,
  );
  if (!target) throw new HttpError(404, "Datensatz fehlt.");
  await assertRowAccess(user, page, target, true);
  const cells = JSON.parse(target.cells) as Record<string, unknown>;
  const current = Array.isArray(cells[field.id]) ? (cells[field.id] as unknown[]) : [];
  if (!current.includes(from)) return { ok: true, removed: false };
  await assertFieldsWritable(user, page, fields, [field.id]);
  const next = { ...cells, [field.id]: current.filter((v) => v !== from) };
  await run(
    "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
    JSON.stringify(next),
    nowText(),
    user.id,
    to,
  );
  await rowChanged(user, page, to, cells, next, fields);
  return { ok: true, removed: true };
}

// "Rückgängig" after records moved along (#395, lib/undo.ts): the start
// and end of each record back to what they were, in one step. Each record
// carries the version it had after the move; one changed since is refused
// (409), so a later edit is never overwritten.
const restoreSchema = z
  .array(
    z.object({
      rowId: z.string().uuid(),
      rowVersion: z.number().int(),
      start: z.string().max(40).nullable(),
      end: z.string().max(40).nullable(),
    }),
  )
  .min(1)
  .max(2000);
export async function restoreTimeline(user: Identity, pageId: string, input: Record<string, unknown>) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = await one<{ fields: string; views: string; version: number }>("SELECT * FROM databases WHERE page_id=?", pageId);
  if (!stored) throw new HttpError(400, "Datenbank fehlt.");
  const fields = JSON.parse(stored.fields) as Field[],
    view = (JSON.parse(stored.views) as View[]).find((v) => v.id === input.viewId);
  if (!view || view.type !== "timeline") throw new HttpError(400, "Timeline-Ansicht fehlt.");
  const { start, end, invalidEnd } = scheduleFields(fields, view);
  if (!start || invalidEnd) throw new HttpError(400, "Gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.");
  const entries = restoreSchema.parse(input.rows);
  const value = (v: string | null) => {
    if (v === null || v === "") return v ?? null;
    if (dateDay(v) === null) throw new HttpError(400, "Ungültiges Datum.");
    return v;
  };
  const rows = [];
  for (const entry of entries) {
    const row = await one<{ id: string; cells: string; version: number; access: string; created_by: string }>(
      "SELECT id,cells,version,access,created_by FROM rows WHERE id=? AND page_id=?",
      entry.rowId,
      pageId,
    );
    if (!row) throw new HttpError(404, "Datensatz fehlt.");
    if (row.version !== entry.rowVersion)
      throw new HttpError(409, "Datensatz wurde inzwischen geändert. Dein Entwurf bleibt erhalten.");
    rows.push({ row, entry });
  }
  await assertRowsWritable(user, page, rows.map((r) => r.row.id));
  for (const { row, entry } of rows) {
    const cells = JSON.parse(row.cells) as Record<string, unknown>;
    const next = { ...cells, [start.id]: value(entry.start), ...(end ? { [end.id]: value(entry.end) } : {}) };
    assertNoNewTimes(fields, { [start.id]: next[start.id], ...(end ? { [end.id]: next[end.id] } : {}) }, cells);
    await assertFieldsWritable(user, page, fields, changedKeys(cells, next));
    await run(
      "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
      JSON.stringify(next),
      nowText(),
      user.id,
      row.id,
    );
    await rowChanged(user, page, row.id, cells, next, fields);
  }
  return { ok: true, restored: rows.length };
}

// Resolves every dependency conflict of a timeline view in one transaction.
export async function cascadeTimeline(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = await one<{ fields: string; views: string; version: number }>(
    "SELECT * FROM databases WHERE page_id=?",
    pageId,
  );
  if (!stored) throw new HttpError(400, "Datenbank fehlt.");
  if (input.version !== stored.version)
    throw new HttpError(
      409,
      "Die Ansicht wurde inzwischen geändert. Bitte neu laden.",
    );
  const fields = JSON.parse(stored.fields) as Field[],
    view = (JSON.parse(stored.views) as View[]).find(
      (v) => v.id === input.viewId,
    );
  if (!view || view.type !== "timeline")
    throw new HttpError(400, "Timeline-Ansicht fehlt.");
  const field = dependencyFields(fields, pageId).find(
    (f) => f.id === view.timeline?.dependencyField,
  );
  if (!field) throw new HttpError(400, "Keine Abhängigkeiten eingerichtet.");
  const rows = (await all<{ id: string; cells: string }>(
    "SELECT id,cells FROM rows WHERE page_id=?",
    pageId,
  )).map((r) => ({
    id: r.id,
    cells: JSON.parse(r.cells) as Record<string, unknown>,
  }));
  const { start, end } = scheduleFields(fields, view);
  // Every record as far as its links need, off weekends when the view asks.
  const { ranges, predecessors } = planInputs(rows, field, start, end);
  const shifts = planShifts({
    ranges,
    predecessors,
    type: view.timeline?.dependencyType,
    scope: "all",
    avoidWeekends: !!view.timeline?.avoidWeekends,
  });
  if (!shifts)
    throw new HttpError(
      409,
      "Zyklische Abhängigkeiten lassen sich nicht auflösen.",
    );
  await assertRowsWritable(user, page, shifts.keys());
  for (const [rid, target] of shifts) {
    const row = rows.find((r) => r.id === rid)!;
    const next = { ...row.cells, ...rangePatch(row, fields, view, ranges.get(rid)!, target) };
    await assertFieldsWritable(user, page, fields, changedKeys(row.cells, next));
    await run(
      "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
      JSON.stringify(next), nowText(),
      user.id,
      rid,
    );
    await rowChanged(user, page, rid, row.cells, next, fields);
  }
  return { ok: true, moved: shifts.size };
}
