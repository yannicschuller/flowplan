import { numberCell } from "./field-format";
import { ROWS_BULK_MAX } from "./bulk-limits";
import {
  fileIdOf,
  fileRefSchema,
  fileUrls,
  MAX_CELL_FILES,
} from "./file-cells";
import { maintainRowOrders } from "./row-order-server";
import { trashRow } from "./row-trash";
import { isMultiPerson, MAX_PEOPLE, ONE_PERSON_MESSAGE, personCell, personIds } from "./person-values";
import { dateOnly, isTimed, newTimeRefused, NO_TIME_MESSAGE, validDateValue } from "./date-values";
import { z } from "zod";
import { all, one, run, id, nowText } from "./db";
import { requirePage } from "./permissions";
import { rowGrants, rowRoleResolver } from "./row-access";
import { HttpError } from "./auth";
import { assertFieldsWritable } from "./field-access";
import { replaceRowDocument } from "./row-documents";
import { relationPairs } from "./relation-sync";
import { parseAliases } from "./page-aliases";
import { colorOptions } from "./option-colors";
import { clearedRequired, requiredMessage } from "./field-required";
import type { Identity, Field, Page, Row } from "./types";
const computed = [
  "formula",
  "rollup",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "id",
  "progress",
  "time",
];
// The first property is the records' title (#463): typed in the record's
// heading, the table's first column, the links to the record. It cannot
// become an ID or another value Flowplan fills in itself (created/changed
// at/by, progress, time) – it could no longer be typed, and the record
// dialog's title would refuse every change. A formula or rollup may be the
// title: a title derived from other properties is a feature of its own.
// A title that already is a blocked type (saved before this check) may stay.
export const TITLE_BLOCKED_TYPES = computed.filter((type) => type !== "formula" && type !== "rollup");
export function assertEditableTitle(next: Field[], before: Field[]) {
  const title = next[0];
  if (!title || !TITLE_BLOCKED_TYPES.includes(title.type)) return;
  if (before[0]?.id === title.id && before[0].type === title.type) return;
  throw new HttpError(
    400,
    "Die erste Eigenschaft ist der Titel und kann keine ID oder automatisch gefüllte Eigenschaft sein.",
  );
}
// Most new options one import may add to select properties – a column of
// free text matched to a select property would otherwise make thousands.
export const IMPORT_NEW_OPTIONS_LIMIT = 100;
const OPTIONS_MAX = 1000;
const fold = (v: string) => v.normalize("NFKC").trim().toLocaleLowerCase();

// Imported records (rows.import): values of select and multi-select
// properties that are not options yet become options, as typing a new value
// in a cell does; a value that differs from an option only in letter case
// takes the option's spelling. Changes `rows` in place and returns the
// updated properties and the names added per property (empty: nothing
// new). Tag-backed properties are left alone (they create tags, #79).
export function addImportedOptions(fields: Field[], rows: Record<string, unknown>[]) {
  const added = new Map<string, string[]>();
  const next = fields.map((f) => {
    if ((f.type !== "select" && f.type !== "multiselect") || isTagField(f)) return f;
    const options = [...(f.options || [])];
    const known = new Map(options.map((o) => [fold(o), o]));
    const take = (value: unknown) => {
      if (typeof value !== "string") return value;
      const name = value.trim();
      if (!name) return value;
      const hit = known.get(fold(name));
      if (hit) return hit;
      const short = name.slice(0, 100);
      known.set(fold(short), short);
      options.push(short);
      added.set(f.id, [...(added.get(f.id) || []), short]);
      return short;
    };
    for (const cells of rows) {
      if (!(f.id in cells)) continue;
      const value = cells[f.id];
      cells[f.id] = Array.isArray(value) ? [...new Set(value.map(take))] : take(value);
    }
    return added.has(f.id) ? { ...f, options } : f;
  });
  const total = [...added.values()].reduce((n, names) => n + names.length, 0);
  if (total > IMPORT_NEW_OPTIONS_LIMIT)
    throw new HttpError(
      400,
      `Der Import würde ${total} neue Auswahl-Optionen anlegen (höchstens ${IMPORT_NEW_OPTIONS_LIMIT}). Passt die Spalte zur Eigenschaft?`,
    );
  for (const f of next)
    if (added.has(f.id) && (f.options?.length || 0) > OPTIONS_MAX)
      throw new HttpError(400, `„${f.name}“ hätte mehr als ${OPTIONS_MAX} Optionen.`);
  // New options get the next colour in turn (#242).
  colorOptions(next.filter((f) => added.has(f.id)), fields);
  return { fields: next, added: fields.filter((f) => added.has(f.id)).map((f) => ({ id: f.id, name: f.name, options: added.get(f.id)! })) };
}

// Imported records (rows.import): numbers, checkboxes and dates must fit
// their property as in validateCellPatch; empty values may be null. Options
// missing from a select property are added first (addImportedOptions).
// Dates with a time for a property without time keep only their day (in
// `zone`, the importing person's time zone).
export function validateImportedCells(fields: Field[], cells: Record<string, unknown>, zone?: string) {
  for (const f of fields) {
    const value = cells[f.id];
    if (value === undefined) continue;
    const fits =
      f.type === "number"
        ? value === null || (() => {
            try {
              numberCell(f, value);
              return true;
            } catch {
              return false;
            }
          })()
        : f.type === "checkbox"
          ? typeof value === "boolean"
          : f.type === "date"
            ? value === null || value === "" || validDateValue(value)
            : true;
    if (!fits) {
      const shown = typeof value === "string" ? value : JSON.stringify(value);
      throw new HttpError(400, `„${String(shown).slice(0, 80)}“ passt nicht in die Eigenschaft „${f.name}“.`);
    }
    // A date property without time (#327) takes the day of an imported
    // date with a time.
    if (f.type === "date" && f.noTime && isTimed(value)) cells[f.id] = dateOnly(value, zone);
    // People in the property's shape (#535): a list with "Mehrere
    // Personen", else the first one.
    if (f.type === "person" && value !== null) cells[f.id] = personCell(f, personIds(value));
  }
}
// Date properties without time (#327): a write that would add a time to
// one of them is refused; `before` are the stored cells (a value that
// already has a time may keep it).
export function assertNoNewTimes(fields: Field[], cells: Record<string, unknown>, before: Record<string, unknown> = {}) {
  for (const f of fields)
    if (f.id in cells && newTimeRefused(f, cells[f.id], before[f.id]))
      throw new HttpError(400, NO_TIME_MESSAGE);
}
// `before`: the record's cells as stored, when it exists – links to
// records hidden from this person that it already has may stay.
export async function validateCellPatch(
  user: Identity,
  page: Page,
  fields: Field[],
  input: unknown,
  before?: Record<string, unknown>,
) {
  const patch = z.record(z.string(), z.unknown()).parse(input),
    result: Record<string, unknown> = {};
  if (!Object.keys(patch).length)
    throw new HttpError(400, "Mindestens eine Eigenschaft wählen.");
  // Properties this person may not change (lib/field-access.ts).
  await assertFieldsWritable(user, page, fields, Object.keys(patch));
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.find((f) => f.id === key);
    if (!f || computed.includes(f.type))
      throw new HttpError(400, "Eigenschaft kann nicht bearbeitet werden.");
    if (f.type === "number") {
      try {
        result[key] = numberCell(f, value);
      } catch (e) {
        throw new HttpError(400, `${f.name}: ${(e as Error).message}`);
      }
    } else if (f.type === "checkbox") result[key] = z.boolean().parse(value);
    else if (isTagField(f))
      // The workspace's tags; new names create tags when allowed (#79).
      result[key] = await tagCell(user, page, f, z.array(z.string().max(1000)).max(100).parse(value));
    else if (f.type === "multiselect") {
      const values = z.array(z.string()).max(100).parse(value);
      if (values.some((v) => !f.options?.includes(v)))
        throw new HttpError(400, "Unbekannte Auswahl.");
      result[key] = [...new Set(values)];
    } else if (f.type === "person") {
      // One id or a list (#535): with "Mehrere Personen" a list of members,
      // else one – a list with one person is taken as that person.
      const ids = personIds(z.union([z.string().max(100), z.array(z.string().max(100)).max(MAX_PEOPLE)]).parse(value));
      if (!isMultiPerson(f) && ids.length > 1)
        throw new HttpError(400, ONE_PERSON_MESSAGE);
      for (const uid of ids)
        if (!(await one("SELECT user_id FROM members WHERE workspace_id=? AND user_id=?", page.workspace_id, uid)))
          throw new HttpError(400, "Mitglied fehlt.");
      result[key] = personCell(f, ids);
    } else if (f.type === "aliases") result[key] = parseAliases(value);
    else if (f.type === "checklist")
      result[key] = z
        .array(z.object({ text: z.string().max(500), done: z.boolean() }))
        .max(100)
        .parse(value);
    else if (f.type === "files") {
      const urls = z
        .union([
          z.literal(""),
          fileRefSchema,
          z.array(fileRefSchema).max(MAX_CELL_FILES),
        ])
        .parse(value);
      const list = [...new Set(fileUrls(urls))];
      for (const url of list) {
        const fid = fileIdOf(url);
        if (
          fid &&
          !(await one("SELECT id FROM files WHERE id=? AND page_id=?", fid, page.id))
        )
          throw new HttpError(400, "Datei gehört nicht zu dieser Datenbank.");
      }
      result[key] = list;
    } else if (f.type === "relation") {
      const ids = z.array(z.string().uuid()).max(500).parse(value);
      if (f.parent && ids.length > 1)
        throw new HttpError(400, "Ein Eintrag hat höchstens einen übergeordneten Eintrag.");
      if (!f.relationPage && ids.length)
        throw new HttpError(400, "Relationsziel fehlt.");
      if (f.relationPage) {
        const target = await requirePage(user, f.relationPage);
        // Only records this person may read (lib/row-access.ts): a link
        // shows the linked record's title wherever the record is shown.
        const readable = await rowRoleResolver(user, target);
        const kept = new Set(Array.isArray(before?.[key]) ? (before[key] as unknown[]) : []);
        for (const rid of ids) {
          const row = await one<{ id: string; access: string; created_by: string | null }>(
            "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
            rid,
            f.relationPage,
          );
          if (!row || (!readable(row) && !kept.has(rid)))
            throw new HttpError(400, "Verknüpfter Eintrag fehlt.");
        }
      }
      result[key] = [...new Set(ids)];
    } else {
      const text = z.string().max(10000).parse(value);
      if (f.type === "select" && text && !f.options?.includes(text))
        throw new HttpError(400, "Unbekannte Auswahl.");
      if (f.type === "sprint" && text && !(await databaseSettings(page.id)).sprints?.some((s) => s.id === text))
        throw new HttpError(400, "Unbekannter Sprint.");
      if (f.type === "date" && text && !validDateValue(text))
        throw new HttpError(400, "Ungültiges Datum.");
      // A date property without time (#327): no new time; a stored value
      // with a time may keep, move or lose it.
      if (newTimeRefused(f, text, before?.[key]))
        throw new HttpError(400, NO_TIME_MESSAGE);
      result[key] = text;
    }
  }
  if (JSON.stringify(result).length > 200000)
    throw new HttpError(413, "Änderung zu groß.");
  // A required property keeps its value (#443) – on an existing record.
  if (before) assertRequiredKept(fields, result, before);
  return result;
}
// Clearing a required property (#443, lib/field-required.ts) is refused; a
// value that was already empty may stay so. `before`: the stored cells.
export function assertRequiredKept(fields: Field[], patch: Record<string, unknown>, before: Record<string, unknown>) {
  const cleared = clearedRequired(fields, patch, before);
  if (cleared) throw new HttpError(400, requiredMessage(cleared));
}
// Automatic database version at the start of an editing session: the first
// edit after 10 quiet minutes keeps the previous state.
export async function autoDatabaseSnapshot(user: Identity, page: Page) {
  const recent = await one(
    `SELECT 1 WHERE EXISTS(SELECT 1 FROM snapshots WHERE page_id=? AND created_at>?)
       OR EXISTS(SELECT 1 FROM pages WHERE id=? AND updated_at>?)
       OR EXISTS(SELECT 1 FROM rows WHERE page_id=? AND updated_at>?)`,
    page.id, nowText(Date.now() - 600_000),
    page.id, nowText(Date.now() - 600_000),
    page.id, nowText(Date.now() - 600_000),
  );
  if (!recent) await databaseSnapshot(user, page);
}
export async function databaseSnapshot(user: Identity, page: Page) {
  const db = (await one<{ fields: string; views: string; record_layout: string }>(
    "SELECT fields,views,record_layout FROM databases WHERE page_id=?",
    page.id,
  ))!;
  const rows = await mapAsync(await all<Row & { cells: string }>(
    "SELECT * FROM rows WHERE page_id=? ORDER BY position",
    page.id,
  ), async (r) => ({
    ...r,
    cells: JSON.parse(r.cells),
    ...(r.access && r.access !== "inherit" ? { grants: await rowGrants(r.id) } : {}),
  }));
  const snapshotId = id();
  await run(
    "INSERT INTO snapshots(id,page_id,html,title,created_by) VALUES(?,?,?,?,?)",
    snapshotId,
    page.id,
    JSON.stringify({
      database: {
        fields: JSON.parse(db.fields),
        views: JSON.parse(db.views),
        recordLayout: JSON.parse(db.record_layout || "{}"),
      },
      relationPairs: await relationPairs(page.id),
      rows,
      comments: await all("SELECT * FROM comments WHERE page_id=?", page.id),
      inlineThreads: await exportInlineComments(page.id),
      rowTemplates: (await all<{
        name: string;
        cells: string;
        html: string;
        is_default: number;
      }>(
        "SELECT name,cells,html,is_default FROM row_templates WHERE page_id=?",
        page.id,
      )).map((t) => ({ ...t, cells: JSON.parse(t.cells) })),
      formConfig: JSON.parse(
        String(
          (await one("SELECT config FROM forms WHERE page_id=?", page.id))?.config ||
            "{}",
        ),
      ),
      // The settings that name options, restored with them (#173).
      ...(await versionSettings(page.id)),
    }),
    page.title,
    user.id,
  );
  return snapshotId;
}
export async function bulkRows(
  user: Identity,
  pageId: string,
  input: Record<string, unknown>,
) {
  const page = await requirePage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Datenbank ist gesperrt.");
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  // Up to ROWS_BULK_MAX records in one go (#675), with a message that says so.
  if (Array.isArray(input.rows) && input.rows.length > ROWS_BULK_MAX)
    throw new HttpError(400, "Höchstens 500 Einträge auf einmal.");
  const operation = z
      .enum(["update", "duplicate", "delete"])
      .parse(input.operation),
    selected = z
      .array(
        z.object({ id: z.string().uuid(), version: z.number().int().min(1) }),
      )
      .min(1)
      .max(ROWS_BULK_MAX)
      .parse(input.rows);
  if (new Set(selected.map((r) => r.id)).size !== selected.length)
    throw new HttpError(400, "Doppelte Einträge in der Auswahl.");
  const access = await rowRoleResolver(user, page);
  const source = await mapAsync(selected, async (selection) => {
    const row = await one<Row & { cells: string }>(
      "SELECT * FROM rows WHERE id=? AND page_id=?",
      selection.id,
      pageId,
    );
    const role = row && access(row);
    if (!row || !role) throw new HttpError(404, "Eintrag nicht gefunden.");
    if (operation !== "duplicate" && role === "viewer")
      throw new HttpError(
        403,
        "Mindestens ein ausgewählter Eintrag ist für dich schreibgeschützt.",
      );
    if (row.version !== selection.version)
      throw new HttpError(
        409,
        "Mindestens ein ausgewählter Eintrag wurde geändert. Bitte Auswahl erneuern.",
      );
    return row;
  });
  const db = (await one<{ fields: string }>(
      "SELECT fields FROM databases WHERE page_id=?",
      pageId,
    ))!,
    fields: Field[] = JSON.parse(db.fields);
  const patch =
    operation === "update"
      ? (await validateCellPatch(user, page, fields, input.cells))
      : null;
  const snapshotId = await databaseSnapshot(user, page),
    mapping = new Map(source.map((r) => [r.id, id()]));
  // Required properties (#443): none of the records loses its value.
  if (patch) for (const row of source) assertRequiredKept(fields, patch, JSON.parse(row.cells));
  for (const row of source) {
    if (operation === "update") {
      const cells = { ...JSON.parse(row.cells), ...patch };
      if (JSON.stringify(cells).length > 200000)
        throw new HttpError(413, "Datensatz zu groß.");
      await run(
        "UPDATE rows SET cells=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?",
        JSON.stringify(cells), nowText(),
        user.id,
        row.id,
      );
      await rowChanged(user, page, row.id, JSON.parse(row.cells), cells, fields);
    } else if (operation === "delete") {
      await trashRow(user, page, row.id);
    } else {
      const cells = JSON.parse(row.cells);
      for (const f of fields)
        if (f.type === "relation" && Array.isArray(cells[f.id]))
          cells[f.id] = cells[f.id].map(
            (rid: string) => mapping.get(rid) || rid,
          );
      const rid = mapping.get(row.id)!;
      await run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,icon,cover,recurrence,access,repeat) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        rid,
        pageId,
        JSON.stringify(cells),
        row.position + 0.5,
        user.id,
        user.id,
        row.icon || "",
        row.cover || "",
        row.recurrence || "",
        row.access || "inherit",
        row.repeat || "",
      );
      // Copies keep the record permissions of their original.
      await run(
        "INSERT INTO row_grants(row_id,user_id,group_id,role) SELECT ?,user_id,group_id,role FROM row_grants WHERE row_id=?",
        rid,
        row.id,
      );
      const html = String(
        (await one("SELECT html FROM row_documents WHERE row_id=?", row.id))?.html ||
          row.content ||
          "",
      );
      await replaceRowDocument(rid, html, user.id);
    }
  }
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), pageId);
  if (operation !== "update")
    await maintainRowOrders(pageId, operation === "duplicate" ? mapping : undefined);
  return {
    count: source.length,
    snapshotId,
    ...(operation === "duplicate" ? { ids: [...mapping.values()] } : {}),
  };
}
import { exportInlineComments } from "./inline-comment-archive";
import { rowChanged } from "./automations";
import { databaseSettings } from "./database-settings";
import { versionSettings } from "./database-version-settings";
import { isTagField, tagCell } from "./tag-fields";
import { mapAsync } from "./each-async";
