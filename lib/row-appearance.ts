import { z } from "zod";
import { run, nowText } from "./db";
import { HttpError } from "./auth";
import { coverSchema, pageIconSchema } from "./page-appearance";
import { validateCover, validateIcon } from "./page-covers";
import { requireRow } from "./row-documents";
import { recurrenceSchema } from "./recurrence";
import type { Identity } from "./types";

const schema = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  version: z.number().int().positive(),
  icon: pageIconSchema.optional(),
  cover: coverSchema.optional(),
});
// Record icons and covers use images uploaded to the database page, like its
// attachments; changing them is a normal versioned record edit.
export async function setRowAppearance(user: Identity, input: unknown) {
  const b = schema.parse(input);
  const { row } = await requireRow(user, b.pageId, b.rowId, true);
  if (row.version !== b.version)
    throw new HttpError(
      409,
      "Der Eintrag wurde inzwischen geändert. Bitte erneut versuchen.",
    );
  if (b.icon !== undefined) await validateIcon(b.pageId, b.icon);
  if (b.cover !== undefined) await validateCover(b.pageId, b.cover);
  await run(
    "UPDATE rows SET icon=COALESCE(?,icon),cover=COALESCE(?,cover),version=version+1,updated_by=?,updated_at=? WHERE id=?",
    b.icon ?? null,
    b.cover ?? null,
    user.id, nowText(),
    row.id,
  );
  return { ok: true };
}

const recurrenceInput = z.object({
  pageId: z.string().uuid(),
  rowId: z.string().uuid(),
  version: z.number().int().positive(),
  recurrence: recurrenceSchema.nullable(),
});
export async function setRowRecurrence(user: Identity, input: unknown) {
  const b = recurrenceInput.parse(input);
  const { row } = await requireRow(user, b.pageId, b.rowId, true);
  if (row.version !== b.version)
    throw new HttpError(
      409,
      "Der Eintrag wurde inzwischen geändert. Bitte erneut versuchen.",
    );
  await run(
    "UPDATE rows SET recurrence=?,version=version+1,updated_by=?,updated_at=? WHERE id=?",
    b.recurrence ? JSON.stringify(b.recurrence) : "",
    user.id, nowText(),
    row.id,
  );
  return { ok: true };
}
