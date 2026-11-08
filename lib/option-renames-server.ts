// database.update with `optionRenames`: options of select and multi-select
// properties renamed (or merged into another option). Records, record
// templates, records in the trash, unsent form answers, the views'
// filters and groups, the done rule, workflow, automations, form
// conditions and the issue sync's status mapping follow the new name. Runs
// in the command's transaction, before the schema is stored.
import { all, nowText, one, run } from "./db";
import { HttpError } from "./auth";
import { databaseSnapshot } from "./database-operations";
import { databaseSettings } from "./database-settings";
import { assertFieldsWritable } from "./field-access";
import { isTagField } from "./page-properties";
import { pageRole } from "./permissions";
import { mergesOf, optionRenamesSchema, renameCells, renameInFormConfig, renameInSettings, renameInViews, renameMaps, type OptionRename } from "./option-renames";
import type { Field, Identity, Page, View } from "./types";

const choice = (f: Field | undefined) => !!f && (f.type === "select" || f.type === "multiselect") && !isTagField(f);

// A rename must fit the change of the options: the old name was an option
// and is gone, the new one is an option now (a new one, or an existing one
// to merge into).
function validRenames(input: unknown, before: Field[], after: Field[]): OptionRename[] {
  const renames = optionRenamesSchema.parse(input ?? []);
  const seen = new Set<string>();
  for (const r of renames) {
    const old = before.find((f) => f.id === r.field),
      next = after.find((f) => f.id === r.field);
    const key = JSON.stringify([r.field, r.from]);
    if (
      !choice(old) ||
      !choice(next) ||
      r.from === r.to ||
      seen.has(key) ||
      !old!.options?.includes(r.from) ||
      next!.options?.includes(r.from) ||
      !next!.options?.includes(r.to)
    )
      throw new HttpError(400, "Die umbenannte Option passt nicht zu den Optionen.");
    seen.add(key);
  }
  return renames;
}

export async function applyOptionRenames(user: Identity, page: Page, before: Field[], after: Field[], views: View[], input: unknown) {
  const renames = validRenames(input, before, after);
  if (!renames.length) return;
  // The values change as if each record were edited: only people who may
  // write the property, and statuses only owners set stay theirs.
  await assertFieldsWritable(user, page, before, new Set(renames.map((r) => r.field)));
  const merges = mergesOf(renames, (field) => before.find((f) => f.id === field)!.options!);
  const maps = renameMaps(renames);
  const current = await databaseSettings(page.id),
    settings = renameInSettings(current, maps, renameMaps(merges));
  const flow = (settings || current).workflow;
  const merged = flow && merges.find((r) => r.field === flow.field && flow.ownersOnly.includes(r.to));
  if (merged && (await pageRole(user, page)) !== "owner")
    throw new HttpError(403, `„${merged.to}“ dürfen nur Verantwortliche der Datenbank setzen.`);
  // Records: the state before is kept as a version of the database (as
  // bulk changes of records do). The value changes without the record
  // "moving": no workflow check, automations or done handling.
  let kept = false;
  for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", page.id)) {
    const cells = JSON.parse(row.cells) as Record<string, unknown>;
    if (!renameCells(cells, maps)) continue;
    if (!kept) {
      await databaseSnapshot(user, page);
      kept = true;
    }
    await run(
      "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
      JSON.stringify(cells),
      nowText(),
      user.id,
      row.id,
    );
  }
  for (const template of await all<{ id: string; cells: string }>("SELECT id,cells FROM row_templates WHERE page_id=?", page.id)) {
    const cells = JSON.parse(template.cells) as Record<string, unknown>;
    if (renameCells(cells, maps)) await run("UPDATE row_templates SET cells=? WHERE id=?", JSON.stringify(cells), template.id);
  }
  for (const draft of await all<{ user_id: string; cells: string }>("SELECT user_id,cells FROM form_drafts WHERE page_id=?", page.id)) {
    const cells = JSON.parse(draft.cells) as Record<string, unknown>;
    if (renameCells(cells, maps))
      await run("UPDATE form_drafts SET cells=? WHERE page_id=? AND user_id=?", JSON.stringify(cells), page.id, draft.user_id);
  }
  for (const trashed of await all<{ id: string; payload: string }>("SELECT id,payload FROM row_trash WHERE page_id=?", page.id)) {
    const payload = JSON.parse(trashed.payload) as { row?: { cells?: unknown } };
    if (!payload.row?.cells) continue;
    const asText = typeof payload.row.cells === "string";
    const cells = (asText ? JSON.parse(payload.row.cells as string) : payload.row.cells) as Record<string, unknown>;
    if (!renameCells(cells, maps)) continue;
    payload.row.cells = asText ? JSON.stringify(cells) : cells;
    await run("UPDATE row_trash SET payload=? WHERE id=?", JSON.stringify(payload), trashed.id);
  }
  renameInViews(views, maps);
  // The version goes up once, with the schema (api.ts).
  if (settings) await run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify(settings), page.id);
  const form = await one<{ config: string }>("SELECT config FROM forms WHERE page_id=?", page.id);
  if (form) {
    const config = renameInFormConfig(JSON.parse(form.config || "{}"), maps);
    if (config) await run("UPDATE forms SET config=? WHERE page_id=?", JSON.stringify(config), page.id);
  }
  const sync = await one<{ config: string }>("SELECT config FROM issue_sync_maps WHERE page_id=?", page.id);
  if (sync) {
    const config = JSON.parse(sync.config) as { status?: { field: string; map: { value: string }[] } | null };
    const map = config.status ? maps.get(config.status.field) : undefined;
    if (config.status && map && config.status.map.some((m) => map.has(m.value))) {
      // A merged option's mapping gives way to the target's own.
      const own = new Set(config.status.map.filter((m) => !map.has(m.value)).map((m) => m.value));
      config.status.map = config.status.map
        .filter((m) => !map.has(m.value) || !own.has(map.get(m.value)!))
        .map((m) => ({ ...m, value: map.get(m.value) ?? m.value }))
        .filter((m, i, list) => list.findIndex((o) => JSON.stringify(o) === JSON.stringify(m)) === i);
      await run("UPDATE issue_sync_maps SET config=? WHERE page_id=?", JSON.stringify(config), page.id);
    }
  }
}
