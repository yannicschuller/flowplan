// Multi-select properties of databases whose options are the workspace's
// tags (issue #79). Such a property stays a "multiselect" (filters, sorting,
// groups, formulas, board columns, automations, imports and exports keep
// working) with `tagOptions: true`; its cells keep the tag NAMES, its
// `options` mirror the workspace's tags in their order (kept in step here,
// without a new database version: what reads `options` sees the tags).
//
// - Renaming, merging or deleting a tag rewrites the cells of every
//   tag-backed property of the workspace in the same transaction (records,
//   record templates, records in the trash, filters and board columns of
//   views); a version of each database changed is kept first.
// - A value that is no tag yet creates it, as on pages: members with edit
//   rights may, viewers, guests and read tokens may not.
// - Records carry their tags into the tag view and the search (#tag, -#tag),
//   with every access rule of records (private records, hidden properties,
//   journal PIN, trash).
// - Guests learn only the tags used in records shared with them.
// - End-to-end encrypted spaces have no tags: the option is refused there.
import { all, one, run, nowText } from "./db";
import { db } from "./db-driver";
import { HttpError } from "./auth";
import { isEncryptedPage } from "./e2ee-server";
import { isGuest, pageRole } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { rowRoleResolver } from "./row-access";
import { hiddenFieldsFor } from "./field-access";
import { databaseSnapshot } from "./database-operations";
import { groupKey } from "./database-groups";
import { cellText } from "./cell-text";
import { canCreateTags, contextTags, listTags, resolveTag, scopeOf, workspaceTags } from "./page-properties-server";
import { cleanTagName, foldName, isTagField, MAX_OPTIONS } from "./page-properties";
import type { Field, FilterGroup, FilterNode, Identity, Page, View } from "./types";
import { flatMapAsync, mapAsync } from "./each-async";

export { isTagField };
export const TAG_FIELD_LIMIT = 100;
const NEW_TAG_REFUSED = "Neue Tags legen nur Mitglieder mit Bearbeitungsrechten an.";

type TagDatabase = { page: Page; fields: Field[]; views: View[] };

// Databases of a workspace with a tag-backed property (also those in the
// trash: restoring them shows the current names).
async function tagDatabases(workspaceId: string): Promise<TagDatabase[]> {
  return (await all<Page & { db_fields: string; db_views: string }>(
    `SELECT p.*,d.fields db_fields,d.views db_views FROM databases d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND ${db.dialect.instr("d.fields", `'"tagOptions":true'`)}>0`,
    workspaceId,
  )).flatMap(({ db_fields, db_views, ...page }) => {
    const fields = JSON.parse(db_fields) as Field[];
    return fields.some(isTagField) ? [{ page: page as Page, fields, views: JSON.parse(db_views) as View[] }] : [];
  });
}

// The tags a database of `spaceId` offers: the workspace's and its space's
// (#136).
const tagNames = async (workspaceId: string, spaceId: string | null) => (await contextTags(workspaceId, spaceId)).map((t) => t.name);

// The options of every tag-backed property follow the tags of its
// database's context.
export async function syncTagFieldOptions(workspaceId: string) {
  const bySpace = new Map<string, string[]>();
  for (const db of await tagDatabases(workspaceId)) {
    const names = bySpace.get(db.page.space_id) ?? await tagNames(workspaceId, db.page.space_id);
    bySpace.set(db.page.space_id, names);
    let changed = false;
    const fields = db.fields.map((f) => {
      if (!isTagField(f) || JSON.stringify(f.options || []) === JSON.stringify(names)) return f;
      changed = true;
      return { ...f, options: names };
    });
    if (changed) await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db.page.id);
  }
}

// The same on the asynchronous database (lib/db-driver), for tag.save
// there (saveTag in lib/page-properties-server.ts). One statement per
// changed database, inside the caller's transaction.
export async function syncTagFieldOptionsAsync(workspaceId: string) {
  const bySpace = new Map<string, string[]>();
  const databases = await db.all<Page & { db_fields: string }>(
    `SELECT p.*,d.fields db_fields FROM databases d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND ${db.dialect.instr("d.fields", "'\"tagOptions\":true'")}>0`,
    workspaceId,
  );
  for (const { db_fields, ...page } of databases) {
    const fields = JSON.parse(db_fields) as Field[];
    if (!fields.some(isTagField)) continue;
    const names = bySpace.get(page.space_id) ?? (await listTags(workspaceId, page.space_id ?? null)).map((t) => t.name);
    bySpace.set(page.space_id, names);
    let changed = false;
    const next = fields.map((f) => {
      if (!isTagField(f) || JSON.stringify(f.options || []) === JSON.stringify(names)) return f;
      changed = true;
      return { ...f, options: names };
    });
    if (changed) await db.run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(next), page.id);
  }
}

// ---- Values ----

// The tag names for values entered into a tag-backed property: an existing
// tag (any case) by its exact name, a new name creates the tag when `user`
// may (always for `user` null: imports run with their own checks). Guests
// only use the tags they know (`known`, folded names). `strict` refuses what
// may not be created; otherwise it is left out.
export async function tagValues(
  user: Identity | null,
  page: Pick<Page, "workspace_id" | "space_id">,
  values: unknown,
  options: { strict: boolean; known?: Set<string> },
): Promise<string[]> {
  const workspaceId = page.workspace_id;
  const list = (Array.isArray(values) ? values : values === null || values === undefined || values === "" ? [] : [values]).filter(
    (v): v is string | number => typeof v === "string" || typeof v === "number",
  );
  // The tags of the database's context; new ones belong to its space (#136).
  const tags = new Map((await contextTags(workspaceId, page.space_id)).map((t) => [foldName(t.name), t.name]));
  const mayCreate = (user ? await canCreateTags(user, workspaceId, page.space_id) && !(await isGuest(user, workspaceId)) : true) && !options.known;
  const out: string[] = [];
  let created = false;
  for (const raw of list) {
    const name = cleanTagName(String(raw));
    if (!name) continue;
    const folded = foldName(name);
    let tag = tags.get(folded);
    if (tag && options.known && !options.known.has(folded)) tag = undefined;
    if (!tag) {
      if (!mayCreate) {
        if (options.strict) throw new HttpError(403, NEW_TAG_REFUSED);
        continue;
      }
      try {
        await resolveTag(null, scopeOf(page), name);
      } catch (error) {
        if (options.strict) throw error;
        continue;
      }
      tags.set(folded, name);
      tag = name;
      created = true;
    }
    if (!out.some((o) => foldName(o) === folded)) out.push(tag);
  }
  if (out.length > MAX_OPTIONS) throw new HttpError(400, "Höchstens 100 Optionen.");
  if (created) await syncTagFieldOptions(workspaceId);
  return out;
}

// The tags a guest may pick in a database: those used in its records the
// guest sees (folded names).
async function guestKnownTags(user: Identity, page: Page, field: Field) {
  const resolve = await rowRoleResolver(user, page);
  const known = new Set<string>();
  for (const row of await all<{ id: string; cells: string; access: string; created_by: string }>(
    "SELECT id,cells,access,created_by FROM rows WHERE page_id=?",
    page.id,
  )) {
    if (!resolve(row)) continue;
    const value = (JSON.parse(row.cells) as Record<string, unknown>)[field.id];
    if (Array.isArray(value)) for (const v of value) if (typeof v === "string") known.add(foldName(v));
  }
  return known;
}

// A cell of a tag-backed property as stored (validateCellPatch).
export async function tagCell(user: Identity, page: Page, field: Field, value: unknown): Promise<string[]> {
  const known = (await isGuest(user, page.workspace_id)) ? (await guestKnownTags(user, page, field)) : undefined;
  return await tagValues(user, page, value, { strict: true, known });
}

// The tag-backed cells of new records (row.create, rows.import, imports).
export async function tagCells<T extends Record<string, unknown>>(
  user: Identity | null,
  page: Page,
  fields: Field[],
  cells: T,
  strict: boolean,
): Promise<T> {
  let out = cells;
  for (const f of fields) {
    if (!isTagField(f) || cells[f.id] === undefined) continue;
    const known = user && await isGuest(user, page.workspace_id) ? (await guestKnownTags(user, page, f)) : undefined;
    out = { ...out, [f.id]: await tagValues(user, page, cells[f.id], { strict, known }) };
  }
  return out;
}

// ---- Guests ----

// Guests see as options only the tags used in the records they see.
export async function guestTagOptions(user: Identity, page: Page, fields: Field[]): Promise<Field[]> {
  if (!fields.some(isTagField) || !(await isGuest(user, page.workspace_id))) return fields;
  return await mapAsync(fields, async (f) => {
    if (!isTagField(f)) return f;
    const known = await guestKnownTags(user, page, f);
    return { ...f, options: (f.options || []).filter((o) => known.has(foldName(o))) };
  });
}

// ---- Renaming, merging, deleting tags ----

const changedList = (values: unknown, map: (name: string) => string | null | undefined): string[] | null => {
  if (!Array.isArray(values)) return null;
  let changed = false;
  const out: string[] = [];
  for (const v of values) {
    const next = typeof v === "string" ? map(v) : undefined;
    if (next !== undefined) changed = true;
    const value = next === undefined ? v : next;
    if (value === null || value === undefined) continue;
    if (!out.some((o) => foldName(String(o)) === foldName(String(value)))) out.push(value as string);
    else changed = true;
  }
  return changed ? out : null;
};

function rewriteCells(cells: Record<string, unknown>, fields: Field[], map: (name: string) => string | null | undefined) {
  let changed = false;
  for (const f of fields) {
    if (!isTagField(f)) continue;
    const next = changedList(cells[f.id], map);
    if (next) {
      cells[f.id] = next;
      changed = true;
    }
  }
  return changed;
}

// Filters and board columns of views on a tag-backed property follow too.
function rewriteViews(views: View[], fields: Field[], map: (name: string) => string | null | undefined) {
  const tagIds = new Set(fields.filter(isTagField).map((f) => f.id));
  let changed = false;
  // A condition whose list of tags became empty goes (a deleted tag).
  const condition = <F extends { field: string; value: string; values?: string[] }>(f: F): F | null => {
    if (!tagIds.has(f.field)) return f;
    let next = f;
    const value = map(f.value);
    if (typeof value === "string") next = { ...next, value };
    if (f.values) {
      const values = changedList(f.values, map);
      if (values) next = { ...next, values };
    }
    if (next !== f) changed = true;
    return next.values && !next.values.length ? null : next;
  };
  const group = (g: FilterGroup): FilterGroup => ({
    ...g,
    rules: g.rules.flatMap((r: FilterNode) => {
      const next = r.kind === "group" ? group(r) : condition(r);
      return next ? [next] : [];
    }),
  });
  const keyMap = (key: string): string | null | undefined => {
    let value: unknown;
    try {
      value = JSON.parse(key);
    } catch {
      return undefined;
    }
    if (typeof value !== "string") return undefined;
    const next = map(value);
    return next === undefined ? undefined : next === null ? null : groupKey(next);
  };
  const keys = (list: string[] | undefined) => {
    if (!list) return list;
    const next = list.flatMap((k) => {
      const mapped = keyMap(k);
      return mapped === undefined ? [k] : mapped === null ? [] : [mapped];
    });
    if (JSON.stringify(next) === JSON.stringify(list)) return list;
    changed = true;
    return [...new Set(next)];
  };
  const record = <V>(entries: Record<string, V> | undefined) => {
    if (!entries) return entries;
    const next: Record<string, V> = {};
    let moved = false;
    for (const [k, v] of Object.entries(entries)) {
      const mapped = keyMap(k);
      if (mapped === undefined) next[k] = v;
      else {
        moved = true;
        if (mapped !== null && !(mapped in next)) next[mapped] = v;
      }
    }
    if (moved) changed = true;
    return moved ? next : entries;
  };
  const next = views.map((v) => {
    const grouped = [v.groupBy, v.subGroupBy, ...(v.groupLevels || [])].some((fid) => !!fid && tagIds.has(fid));
    return {
      ...v,
      filters: v.filters.flatMap((f) => {
        const next = condition(f);
        return next ? [next] : [];
      }),
      ...(v.filterGroup ? { filterGroup: group(v.filterGroup) } : {}),
      ...(grouped && v.groupSettings
        ? { groupSettings: { ...v.groupSettings, collapsed: keys(v.groupSettings.collapsed)!, ...(v.groupSettings.order ? { order: keys(v.groupSettings.order) } : {}) } }
        : {}),
      ...(grouped && v.wip ? { wip: record(v.wip) } : {}),
      ...(grouped && v.groupRowOrder ? { groupRowOrder: record(v.groupRowOrder) } : {}),
    };
  });
  return changed ? next : null;
}

// A tag renamed (`from` → `to`), merged (the source's name → the target's)
// or deleted (`to` null): every tag-backed cell where the tag is known
// follows – in the whole workspace, or for a space's tag (#136) in that
// space; `only` limits it to some databases (pages moved, lib/meta-scope-server.ts).
export async function rewriteTagValues(user: Identity, workspaceId: string, from: string, to: string | null, spaceId: string | null = null, only?: Set<string>) {
  const gone = foldName(from);
  const map = (name: string) => (foldName(name) === gone ? to : undefined);
  for (const db of await tagDatabases(workspaceId)) {
    if (spaceId && db.page.space_id !== spaceId) continue;
    if (only && !only.has(db.page.id)) continue;
    let kept = false,
      touched = false;
    for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", db.page.id)) {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      if (!rewriteCells(cells, db.fields, map)) continue;
      // The state before is kept as a version of the database (as bulk
      // changes of records do).
      if (!kept) {
        await databaseSnapshot(user, db.page);
        kept = true;
      }
      await run(
        "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
        JSON.stringify(cells), nowText(),
        user.id,
        row.id,
      );
      touched = true;
    }
    for (const template of await all<{ id: string; cells: string }>("SELECT id,cells FROM row_templates WHERE page_id=?", db.page.id)) {
      const cells = JSON.parse(template.cells) as Record<string, unknown>;
      if (rewriteCells(cells, db.fields, map)) await run("UPDATE row_templates SET cells=? WHERE id=?", JSON.stringify(cells), template.id);
    }
    for (const trashed of await all<{ id: string; payload: string }>("SELECT id,payload FROM row_trash WHERE page_id=?", db.page.id)) {
      const payload = JSON.parse(trashed.payload) as { row?: { cells?: unknown } };
      if (!payload.row?.cells) continue;
      const asText = typeof payload.row.cells === "string";
      const cells = (asText ? JSON.parse(payload.row.cells as string) : payload.row.cells) as Record<string, unknown>;
      if (!rewriteCells(cells, db.fields, map)) continue;
      payload.row.cells = asText ? JSON.stringify(cells) : cells;
      await run("UPDATE row_trash SET payload=? WHERE id=?", JSON.stringify(payload), trashed.id);
    }
    const views = rewriteViews(db.views, db.fields, map);
    if (views) {
      await run("UPDATE databases SET views=?,version=version+1 WHERE page_id=?", JSON.stringify(views), db.page.id);
      touched = true;
    }
    if (touched) await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), db.page.id);
  }
}

// ---- Switching a property, copies ----

// database.update: a multi-select switched to the workspace's tags maps its
// options to tags (case-insensitive, missing ones created) and keeps its
// values under the tags' exact names; switched back, the tags it uses and
// offers become its own options (values kept). Own lists keep at most 100
// options. Runs in the command's transaction, before the schema is stored.
export async function prepareTagFields(user: Identity, page: Page, fields: Field[], before: Field[]) {
  for (const f of fields) if (f.tagOptions && f.type !== "multiselect") delete f.tagOptions;
  if (fields.some(isTagField) && await isEncryptedPage(page))
    throw new HttpError(409, "Seiten verschlüsselter Bereiche haben keine Tags und Eigenschaften.");
  const switched = fields.filter((f) => isTagField(f) && !before.some((b) => b.id === f.id && isTagField(b)));
  for (const f of switched) {
    const old = before.find((b) => b.id === f.id);
    // Existing options become tags (with the permission to create them).
    const wanted = [...(old?.options || []), ...(f.options || [])].filter((o) => !!cleanTagName(o));
    await tagValues(user, page, wanted.slice(0, 1000), { strict: true });
    // Values of the records: under the tags' names (new ones created).
    if (old)
      for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", page.id)) {
        const cells = JSON.parse(row.cells) as Record<string, unknown>;
        const value = cells[f.id];
        if (value === undefined || value === null || value === "") continue;
        const next = await tagValues(user, page, value, { strict: true });
        if (JSON.stringify(next) === JSON.stringify(value)) continue;
        cells[f.id] = next;
        await run(
          "UPDATE rows SET cells=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
          JSON.stringify(cells), nowText(),
          user.id,
          row.id,
        );
      }
  }
  const names = await tagNames(page.workspace_id, page.space_id);
  for (const f of fields) {
    const old = before.find((b) => b.id === f.id);
    if (isTagField(f)) f.options = names;
    else if (old && isTagField(old) && (f.type === "multiselect" || f.type === "select")) {
      // Back to an own list: the tags in use first, then the others offered.
      const used = new Set<string>();
      for (const row of await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", page.id)) {
        const value = (JSON.parse(row.cells) as Record<string, unknown>)[f.id];
        for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") used.add(foldName(v));
      }
      const ordered = [...names.filter((n) => used.has(foldName(n))), ...names.filter((n) => !used.has(foldName(n)))];
      f.options = ordered.slice(0, TAG_FIELD_LIMIT);
    } else if ((f.options?.length || 0) > TAG_FIELD_LIMIT) throw new HttpError(400, "Höchstens 100 Optionen.");
  }
}

// A database copied or restored (templates, archives, duplicates, versions):
// its tag-backed values become tags of this workspace where allowed (names
// that may not be created stay as they are) and its options follow.
export async function reconcileTagFields(user: Identity | null, pageId: string) {
  const db = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!db || !page) return;
  const fields = JSON.parse(db.fields) as Field[];
  if (!fields.some(isTagField)) return;
  if (await isEncryptedPage(page)) {
    await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields.map(({ tagOptions: _drop, ...f }) => f)), pageId);
    return;
  }
  const mayCreate = !user || (await canCreateTags(user, page.workspace_id, page.space_id) && !(await isGuest(user, page.workspace_id)));
  const tags = new Map((await contextTags(page.workspace_id, page.space_id)).map((t) => [foldName(t.name), t.name]));
  for (const row of await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", pageId)) {
    const cells = JSON.parse(row.cells) as Record<string, unknown>;
    let changed = false;
    for (const f of fields.filter(isTagField)) {
      const value = cells[f.id];
      if (!Array.isArray(value) || !value.length) continue;
      const next = await flatMapAsync(value, async (v) => {
        if (typeof v !== "string") return [];
        const known = tags.get(foldName(v));
        if (known) return [known];
        const name = cleanTagName(v);
        if (!mayCreate || !name) return [v];
        try {
          await resolveTag(null, scopeOf(page), name);
          tags.set(foldName(name), name);
          return [name];
        } catch {
          return [v];
        }
      });
      if (JSON.stringify(next) !== JSON.stringify(value)) {
        cells[f.id] = [...new Set(next)];
        changed = true;
      }
    }
    if (changed) await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(cells), row.id);
  }
  await syncTagFieldOptions(page.workspace_id);
}

// ---- Records with tags (tag view, search, guests) ----

export type TaggedRecord = {
  pageId: string;
  rowId: string;
  title: string;
  icon: string;
  databaseTitle: string;
  spaceId: string;
  updatedAt: string;
  // Tag ids, in the order of the workspace's tags.
  tags: string[];
};

// The records a person may read that carry tags in a tag-backed property
// they may read: no private records of others, no hidden properties, no
// databases behind a journal PIN, in the trash or end-to-end encrypted.
export async function taggedRecords(user: Identity, workspaceId: string): Promise<TaggedRecord[]> {
  const databases = (await tagDatabases(workspaceId)).filter((db) => !db.page.deleted_at && !db.page.synced);
  if (!databases.length) return [];
  const tags = await workspaceTags(workspaceId);
  // A name means the tag of the database's context (#136).
  const byName = (spaceId: string, name: string) => tags.find((t) => (!t.spaceId || t.spaceId === spaceId) && foldName(t.name) === name)?.id;
  const locked = await lockedPageIds(user, workspaceId);
  const out: TaggedRecord[] = [];
  for (const db of databases) {
    if (locked.has(db.page.id) || await isEncryptedPage(db.page)) continue;
    const role = await pageRole(user, db.page);
    if (!role) continue;
    const hidden = await hiddenFieldsFor(user, db.page, db.fields, role);
    const tagFields = db.fields.filter((f) => isTagField(f) && !hidden.has(f.id));
    if (!tagFields.length) continue;
    const resolve = await rowRoleResolver(user, db.page, role);
    const titleField = db.fields[0]?.id || "title";
    for (const row of await all<{ id: string; cells: string; access: string; created_by: string; updated_at: string; icon: string | null }>(
      "SELECT id,cells,access,created_by,updated_at,icon FROM rows WHERE page_id=? ORDER BY position",
      db.page.id,
    )) {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      const ids = new Set<string>();
      for (const f of tagFields) {
        const value = cells[f.id];
        if (Array.isArray(value))
          for (const v of value) {
            const tagId = typeof v === "string" ? byName(db.page.space_id, foldName(v)) : undefined;
            if (tagId) ids.add(tagId);
          }
      }
      if (!ids.size || !resolve(row)) continue;
      out.push({
        pageId: db.page.id,
        rowId: row.id,
        title: cellText(cells[titleField]) || "",
        icon: row.icon || "",
        databaseTitle: db.page.title,
        spaceId: db.page.space_id,
        updatedAt: row.updated_at,
        tags: tags.filter((t) => ids.has(t.id)).map((t) => t.id),
      });
    }
  }
  return out;
}

