import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import {
  cascadeShifts,
  dependencyFields,
  scheduleFields,
  schedulePatch,
} from "./database-timeline";
import { calendarChangeSchema, calendarPatch } from "./database-calendar";
import type { Field, Identity, View } from "./types";
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
// Executes inside the command transaction, including linked-view mutations.
export function scheduleRow(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
  context?: { fields: Field[]; views: View[]; version: number },
) {
  const page = requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = one<{ fields: string; views: string; version: number }>(
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
    row = one<{ cells: string; version: number }>(
      "SELECT cells,version FROM rows WHERE id=? AND page_id=?",
      rid,
      pageId,
    );
  if (!row) throw new HttpError(404, "Datensatz fehlt.");
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
  const nextCells = JSON.stringify({ ...cells, ...patch });
  if (nextCells.length > 200000) throw new HttpError(413, "Datensatz zu groß.");
  run(
    "UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?",
    nextCells,
    user.id,
    rid,
  );
  return { ok: true };
}

// Resolves every dependency conflict of a timeline view in one transaction.
export function cascadeTimeline(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
) {
  const page = requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const stored = one<{ fields: string; views: string; version: number }>(
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
  const rows = all<{ id: string; cells: string }>(
    "SELECT id,cells FROM rows WHERE page_id=?",
    pageId,
  ).map((r) => ({
    id: r.id,
    cells: JSON.parse(r.cells) as Record<string, unknown>,
  }));
  const { start, end } = scheduleFields(fields, view);
  const shifts = cascadeShifts(
    rows,
    field,
    start,
    end,
    view.timeline?.dependencyType,
  );
  if (!shifts)
    throw new HttpError(
      409,
      "Zyklische Abhängigkeiten lassen sich nicht auflösen.",
    );
  for (const [rid, days] of shifts) {
    const row = rows.find((r) => r.id === rid)!;
    const patch = schedulePatch(row, fields, view, { operation: "move", days });
    run(
      "UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?",
      JSON.stringify({ ...row.cells, ...patch }),
      user.id,
      rid,
    );
  }
  return { ok: true, moved: shifts.size };
}
