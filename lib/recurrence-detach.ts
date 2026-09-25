import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireRow, replaceRowDocument } from "./row-documents";
import { maintainRowOrders } from "./row-order-server";
import { Temporal } from "./date-values";
import {
  occurrenceDates,
  parseRecurrence,
  shiftDateValue,
  type Recurrence,
} from "./recurrence";
import type { Field, Identity } from "./types";

const input = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  version: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startField: z.string().min(1).max(200),
  endField: z.string().min(1).max(200).optional(),
  // "single": only this occurrence; "following": this and all later ones.
  mode: z.enum(["single", "following"]).default("single"),
});

// "Only this occurrence": the occurrence becomes its own record with the
// series' properties, document, icon and reminders, and the series skips
// that date. "This and following" splits the series at that date instead.
// Both happen in the surrounding command transaction.
export function detachOccurrence(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  const { row } = requireRow(user, b.pageId, b.rowId, true);
  if (row.version !== b.version)
    throw new HttpError(
      409,
      "Der Eintrag wurde inzwischen geändert. Bitte erneut versuchen.",
    );
  const rule = parseRecurrence(row.recurrence);
  if (!rule) throw new HttpError(400, "Der Eintrag wiederholt sich nicht.");
  const fields = JSON.parse(
    one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      b.pageId,
    )!.fields,
  ) as Field[];
  const dateField = (fid?: string) =>
    fid ? fields.find((f) => f.id === fid && f.type === "date") : undefined;
  const start = dateField(b.startField),
    end = dateField(b.endField);
  if (!start || (b.endField && (!end || end.id === start.id)))
    throw new HttpError(400, "Ungültiges Datumsfeld.");
  const cells = JSON.parse(String(row.cells)) as Record<string, unknown>;
  const first = cells[start.id];
  if (
    typeof first !== "string" ||
    !first ||
    !occurrenceDates(first, rule, b.date, b.date).includes(b.date)
  )
    throw new HttpError(409, "Diesen Termin gibt es in der Serie nicht.");
  if (b.mode === "single" && (rule.exclude?.length || 0) >= 200)
    throw new HttpError(409, "Diese Serie hat bereits 200 Ausnahmen.");
  const shift = Temporal.PlainDate.from(first.slice(0, 10)).until(
    Temporal.PlainDate.from(b.date),
  ).days;
  const copy = { ...cells, [start.id]: shiftDateValue(first, shift) };
  if (end && typeof cells[end.id] === "string" && cells[end.id])
    copy[end.id] = shiftDateValue(cells[end.id] as string, shift);
  // Splitting a series: the old one ends the day before, the new record
  // continues the rule (remaining count, later exclusions) from this date.
  let tail = "",
    head: Recurrence | null = null;
  if (b.mode === "following") {
    const plain = { ...rule, exclude: undefined };
    const before = occurrenceDates(
      first,
      plain,
      first.slice(0, 10),
      Temporal.PlainDate.from(b.date).subtract({ days: 1 }).toString(),
      100000,
    ).length;
    // Occurrences before this date, including the stored first one.
    const done = before + 1;
    const later = rule.exclude?.filter((d) => d > b.date);
    const remaining = rule.count ? rule.count - done : undefined;
    if (remaining === undefined || remaining >= 2)
      tail = JSON.stringify({
        ...rule,
        count: remaining,
        exclude: later?.length ? later : undefined,
      });
    const earlier = rule.exclude?.filter((d) => d < b.date);
    head =
      done >= 2
        ? {
            ...rule,
            count: rule.count ? done : undefined,
            until: rule.count
              ? undefined
              : Temporal.PlainDate.from(b.date)
                  .subtract({ days: 1 })
                  .toString(),
            exclude: earlier?.length ? earlier : undefined,
          }
        : null;
  }
  const rid = id();
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,icon,cover,recurrence) VALUES(?,?,?,?,?,?,?,?,?)",
    rid,
    b.pageId,
    JSON.stringify(copy),
    row.position + 0.5,
    user.id,
    user.id,
    row.icon || "",
    row.cover || "",
    tail,
  );
  replaceRowDocument(
    rid,
    String(
      one<{ html: string }>(
        "SELECT html FROM row_documents WHERE row_id=?",
        row.id,
      )?.html ||
        row.content ||
        "",
    ),
    user.id,
  );
  // Reminders of the series keep working for the detached occurrence.
  for (const r of all<{
    user_id: string;
    field_id: string;
    offset_minutes: number;
    time_zone: string;
  }>(
    "SELECT user_id,field_id,offset_minutes,time_zone FROM date_reminders WHERE row_id=?",
    row.id,
  ))
    run(
      "INSERT INTO date_reminders(user_id,page_id,row_id,field_id,offset_minutes,time_zone,observed_value,armed_at) VALUES(?,?,?,?,?,?,?,?)",
      r.user_id,
      b.pageId,
      rid,
      r.field_id,
      r.offset_minutes,
      r.time_zone,
      String(copy[r.field_id] ?? ""),
      Date.now(),
    );
  run(
    "UPDATE rows SET recurrence=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    b.mode === "following"
      ? head
        ? JSON.stringify(head)
        : ""
      : JSON.stringify({
          ...rule,
          exclude: [...(rule.exclude || []), b.date].sort(),
        }),
    user.id,
    row.id,
  );
  maintainRowOrders(b.pageId, new Map([[row.id, rid]]));
  return { id: rid };
}
