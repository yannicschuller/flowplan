import { z } from "zod";
import { all, id, one, run, nowText } from "./db";
import { HttpError } from "./auth";
import { requireRow, replaceRowDocument } from "./row-documents";
import { maintainRowOrders } from "./row-order-server";
import { Temporal, validZone } from "./date-values";
import {
  localDay,
  occurrenceDates,
  occurrenceValue,
  parseRecurrence,
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
  // The zone `date` is a day in (the calendar's); timed occurrences keep
  // their local time there across a clock change.
  timeZone: z.string().max(100).refine(validZone, "Ungültige Zeitzone.").default("UTC"),
});

// "Only this occurrence": the occurrence becomes its own record with the
// series' properties, document, icon and reminders, and the series skips
// that date. "This and following" splits the series at that date instead.
// Both happen in the surrounding command transaction.
export async function detachOccurrence(user: Identity, raw: unknown) {
  const b = input.parse(raw);
  const { row } = await requireRow(user, b.pageId, b.rowId, true);
  if (row.version !== b.version)
    throw new HttpError(
      409,
      "Der Eintrag wurde inzwischen geändert. Bitte erneut versuchen.",
    );
  const rule = parseRecurrence(row.recurrence);
  if (!rule) throw new HttpError(400, "Der Eintrag wiederholt sich nicht.");
  const fields = JSON.parse(
    (await one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      b.pageId,
    ))!.fields,
  ) as Field[];
  const dateField = (fid?: string) =>
    fid ? fields.find((f) => f.id === fid && f.type === "date") : undefined;
  const start = dateField(b.startField),
    end = dateField(b.endField);
  if (!start || (b.endField && (!end || end.id === start.id)))
    throw new HttpError(400, "Ungültiges Datumsfeld.");
  const cells = JSON.parse(String(row.cells)) as Record<string, unknown>;
  const first = cells[start.id],
    zone = b.timeZone;
  if (
    typeof first !== "string" ||
    !first ||
    !occurrenceDates(first, rule, b.date, b.date, 1, zone).includes(b.date)
  )
    throw new HttpError(409, "Diesen Termin gibt es in der Serie nicht.");
  if (b.mode === "single" && (rule.exclude?.length || 0) >= 200)
    throw new HttpError(409, "Diese Serie hat bereits 200 Ausnahmen.");
  const copy = { ...cells, [start.id]: occurrenceValue(first, first, b.date, zone) };
  if (end && typeof cells[end.id] === "string" && cells[end.id])
    copy[end.id] = occurrenceValue(cells[end.id] as string, first, b.date, zone);
  // Splitting a series: the old one ends the day before, the new record
  // continues the rule (remaining count, later exclusions) from this date.
  let tail = "",
    head: Recurrence | null = null;
  if (b.mode === "following") {
    const plain = { ...rule, exclude: undefined };
    const before = occurrenceDates(
      first,
      plain,
      localDay(first, zone),
      Temporal.PlainDate.from(b.date).subtract({ days: 1 }).toString(),
      100000,
      zone,
    ).length;
    // Occurrences before this date, including the stored first one.
    const done = before + 1;
    const later = rule.exclude?.filter((d) => d > b.date);
    const remaining = rule.count ? rule.count - done : undefined;
    // A month-end series split at a clamped date (28 Feb of a series on
    // the 31st) keeps its day of the month.
    const anchor = rule.day ?? Temporal.PlainDate.from(localDay(first, zone)).day;
    const day =
      (rule.freq === "monthly" || rule.freq === "yearly") &&
      anchor !== Temporal.PlainDate.from(b.date).day
        ? anchor
        : undefined;
    if (remaining === undefined || remaining >= 2)
      tail = JSON.stringify({
        ...rule,
        count: remaining,
        exclude: later?.length ? later : undefined,
        day,
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
  await run(
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
  await replaceRowDocument(
    rid,
    String(
      (await one<{ html: string }>(
        "SELECT html FROM row_documents WHERE row_id=?",
        row.id,
      ))?.html ||
        row.content ||
        "",
    ),
    user.id,
  );
  // Reminders of the series keep working for the detached occurrence.
  for (const r of await all<{
    user_id: string;
    field_id: string;
    offset_minutes: number;
    time_zone: string;
  }>(
    "SELECT user_id,field_id,offset_minutes,time_zone FROM date_reminders WHERE row_id=?",
    row.id,
  ))
    await run(
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
  await run(
    "UPDATE rows SET recurrence=?,version=version+1,updated_by=?,updated_at=? WHERE id=?",
    b.mode === "following"
      ? head
        ? JSON.stringify(head)
        : ""
      : JSON.stringify({
          ...rule,
          exclude: [...(rule.exclude || []), b.date].sort(),
        }),
    user.id, nowText(),
    row.id,
  );
  await maintainRowOrders(b.pageId, new Map([[row.id, rid]]));
  return { id: rid };
}
