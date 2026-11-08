// database.update with `optionRenames`: options of select and multi-select
// properties renamed (or merged into another option). Records, record
// templates, records in the trash, unsent form answers, the views'
// filters and groups, the done rule, workflow, automations, form
// conditions, the issue sync's status mapping and linked views of the
// database on other pages follow the new name. Runs in the command's
// transaction, before the schema is stored.
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { all, nowText, one, run, sql } from "./db";
import { HttpError } from "./auth";
import { databaseSnapshot } from "./database-operations";
import { databaseSettings } from "./database-settings";
import { assertFieldsWritable } from "./field-access";
import { isTagField } from "./page-properties";
import { pageRole } from "./permissions";
import { rewriteDocument } from "./document-rewrite";
import { linkedViewsSchema } from "./linked-views";
import {
  mergesOf,
  optionRenamesSchema,
  renameCells,
  renameInFormConfig,
  renameInSettings,
  renameInViews,
  renameMaps,
  type OptionRename,
  type RenameMaps,
} from "./option-renames";
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

// Returns the updates of host documents to send to open editors once the
// transaction is stored.
export async function applyOptionRenames(
  user: Identity,
  page: Page,
  before: Field[],
  after: Field[],
  views: View[],
  input: unknown,
): Promise<(() => void)[]> {
  const renames = validRenames(input, before, after);
  if (!renames.length) return [];
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
  return await renameInLinkedViews(user, page, maps);
}

// Linked views of the database (lib/linked-views.ts) keep views of their
// own in the block of their host page or record. Their filters and groups
// name the database's options, so they are part of the database like its
// records: they follow in every host of the workspace, also in pages and
// records the renaming person cannot open or edit (as records they cannot
// see follow). Nothing else of the host changes. The block's version goes
// up, so a linked view open elsewhere reloads before it saves its views.
export function renameLinkedBlocks(doc: PMNode, source: string, maps: RenameMaps): PMNode | null {
  const changes: { pos: number; attrs: Record<string, unknown> }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "linkedDatabase") return true;
    if (node.attrs.source !== source) return false;
    let views;
    try {
      views = linkedViewsSchema.parse(JSON.parse(String(node.attrs.views)));
    } catch {
      return false;
    }
    const unchanged = JSON.stringify(views);
    renameInViews(views, maps);
    if (JSON.stringify(views) !== unchanged)
      changes.push({ pos, attrs: { ...node.attrs, views: JSON.stringify(views), version: String((Number(node.attrs.version) || 1) + 1) } });
    return false;
  });
  if (!changes.length) return null;
  const tr = new Transform(doc);
  for (const { pos, attrs } of changes) tr.setNodeMarkup(pos, undefined, attrs);
  return tr.doc;
}
async function renameInLinkedViews(user: Identity, page: Page, maps: RenameMaps) {
  const needle = `data-linked-source="${page.id}"`;
  const hosts = [
    ...(await all<{ page_id: string; row_id: null }>(
      `SELECT d.page_id,NULL row_id FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=? AND ${sql.instr("d.html", "?")}>0`,
      page.workspace_id,
      needle,
    )),
    ...(await all<{ page_id: string; row_id: string }>(
      `SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
       WHERE p.workspace_id=? AND ${sql.instr("d.html", "?")}>0`,
      page.workspace_id,
      needle,
    )),
  ];
  const publish: (() => void)[] = [];
  for (const host of hosts) {
    const result = await rewriteDocument(host.page_id, host.row_id, user.id, (doc) => renameLinkedBlocks(doc, page.id, maps));
    if (result) publish.push(result.publish);
  }
  return publish;
}
