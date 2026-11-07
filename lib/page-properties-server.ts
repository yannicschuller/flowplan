// Tags and custom properties of pages (issue #70), server side: storage,
// permissions, the commands, the search filter and the portable form that
// templates, copies, archives and Markdown carry (lib/page-properties.ts has
// the shared part).
//
// Permissions: whoever may edit a page sets its tags and values; members
// with edit rights (not guests, not read tokens) may create a new tag of the
// page's space while tagging; workspace owners create and manage tags and
// property definitions of every scope, space managers those of their space
// (#136, lib/meta-scope-server.ts has the scope changes and moves). Values are read with
// the page (pageData) – private pages stay private. Pages of end-to-end
// encrypted spaces carry neither tags nor values (the server would read
// them): the commands are refused there (lib/e2ee-server.ts).
import { z } from "zod";
import { HttpError } from "./auth";
import { all, audit, id, one, run, nowText, lockFor } from "./db";
import { db, uniqueViolation, type Dialect } from "./db-driver";
import { auditAsync } from "./audit";

// The SQL dialect of this instance (lib/db-driver/dialect.ts): the
// synchronous functions below run on SQLite and, through the transitional
// bridge of lib/db.ts, on Postgres.
const d = () => db.dialect;
import { isEncryptedPage } from "./e2ee-server";
import { isGuest, memberRole, pageRole, requireMember, requirePage, spaceRole } from "./permissions";
import { lockedPageIds } from "./journal-extras";
import { validDateValue } from "./date-values";
import {
  cleanName,
  cleanTagName,
  foldName,
  isComputedProperty,
  isEmptyValue,
  matchesPropertyFilter,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_PROPERTIES,
  MAX_PROPERTY_NAME,
  MAX_TAGS,
  MAX_TAGS_PER_PAGE,
  MAX_TEXT_VALUE,
  PAGE_PROPERTY_TYPES,
  PAGE_TAG_COLORS,
  propertyText,
  tagColorFrom,
  type PageInfo,
  type PageMeta,
  type PagePropertyDef,
  type PagePropertyType,
  type PageTag,
  type PageTagColor,
  type ParsedQuery,
  type PortableMeta,
  type PropertyFilter,
  tagFilterIds,
  type WorkspaceTaxonomy,
  inScope,
} from "./page-properties";
import type { Identity, Page, Space } from "./types";
import { rewriteTagValues, syncTagFieldOptions, syncTagFieldOptionsAsync, taggedRecords } from "./tag-fields";
import { filterAsync, forEachAsync, mapAsync } from "./each-async";

export type TagRow = { id: string; workspace_id: string; space_id: string | null; name: string; color: string; position: number };
export type DefRow = { id: string; workspace_id: string; space_id: string | null; name: string; type: string; options: string; position: number };

export const asTag = (t: TagRow): PageTag => ({
  id: t.id,
  name: t.name,
  color: (PAGE_TAG_COLORS as readonly string[]).includes(t.color) ? (t.color as PageTagColor) : "gray",
  position: t.position,
  spaceId: t.space_id ?? null,
});
export const asDef = (d: DefRow): PagePropertyDef => ({
  id: d.id,
  spaceId: d.space_id ?? null,
  name: d.name,
  type: d.type as PagePropertyType,
  options: (() => {
    try {
      const list = JSON.parse(d.options);
      return Array.isArray(list) ? list.map(String) : [];
    } catch {
      return [];
    }
  })(),
  position: d.position,
});

// Every tag or definition of the workspace, of all scopes.
export async function workspaceTags(workspaceId: string): Promise<PageTag[]> {
  return (await all<TagRow>(`SELECT * FROM page_tags WHERE workspace_id=? ORDER BY position,${d().nocase("name")}`, workspaceId)).map(asTag);
}
export async function workspaceProperties(workspaceId: string): Promise<PagePropertyDef[]> {
  return (await all<DefRow>(`SELECT * FROM page_property_defs WHERE workspace_id=? ORDER BY position,${d().nocase("name")}`, workspaceId)).map(asDef);
}
// Those a page of `spaceId` uses: the workspace's and its space's (#136).
// null: only the workspace's.
export async function contextTags(workspaceId: string, spaceId: string | null): Promise<PageTag[]> {
  return (await all<TagRow>(
    `SELECT * FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) ORDER BY position,${d().nocase("name")}`,
    workspaceId,
    spaceId,
  )).map(asTag);
}
export async function contextProperties(workspaceId: string, spaceId: string | null): Promise<PagePropertyDef[]> {
  return (await all<DefRow>(
    `SELECT * FROM page_property_defs WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) ORDER BY position,${d().nocase("name")}`,
    workspaceId,
    spaceId,
  )).map(asDef);
}
export type MetaTable = "page_tags" | "page_property_defs";
// The item a new or renamed one would clash with (#136): within one context
// names are unique – a space's item with the workspace's and its own
// space's, a workspace item with every scope (it is in every context).
export async function scopeClash(table: MetaTable, workspaceId: string, spaceId: string | null, name: string, exceptId?: string) {
  return await one<{ id: string; space_id: string | null; name: string }>(
    `SELECT id,space_id,name FROM ${table} WHERE workspace_id=? AND ${d().ieq("name")} AND ${d().isNot("id")}${spaceId ? " AND (space_id IS NULL OR space_id=?)" : ""} ORDER BY space_id IS NOT NULL LIMIT 1`,
    workspaceId,
    name,
    exceptId ?? null,
    ...(spaceId ? [spaceId] : []),
  );
}
export async function clashMessage(table: MetaTable, clash: { space_id: string | null }) {
  const space = clash.space_id ? (await one<{ name: string }>("SELECT name FROM spaces WHERE id=?", clash.space_id))?.name : null;
  const what = table === "page_tags" ? "Diesen Tag" : "Eine Eigenschaft mit diesem Namen";
  return space ? `${what} gibt es schon im Bereich „${space}“.` : `${what} gibt es schon.`;
}

// ---- Who may do what ----

// Workspace owners: every scope.
export async function canManageTaxonomy(user: Identity, workspaceId: string) {
  return (await memberRole(user, workspaceId)) === "owner" && !(await isGuest(user, workspaceId)) && user.apiScope !== "read";
}
// A live space of the workspace for a scope, else 400/404; end-to-end
// encrypted spaces have no tags or properties.
export async function scopeSpace(workspaceId: string, spaceId: string): Promise<Space> {
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=?", spaceId, workspaceId);
  if (!space || space.deleted_at) throw new HttpError(404, "Bereich nicht gefunden.");
  if (await isEncryptedPage({ space_id: space.id })) throw new HttpError(409, "Seiten verschlüsselter Bereiche haben keine Tags und Eigenschaften.");
  return space;
}
// Owners for every scope; for a space also its managers (the space's owner
// with edit rights, as for the space's settings).
export async function canManageScope(user: Identity, workspaceId: string, spaceId: string | null) {
  if (await canManageTaxonomy(user, workspaceId)) return true;
  if (!spaceId || user.apiScope === "read" || await isGuest(user, workspaceId)) return false;
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=?", spaceId, workspaceId);
  return !!space && !space.deleted_at && space.owner_id === user.id && (await memberRole(user, workspaceId)) === "editor";
}
// New tags while tagging: members with edit rights for a space they may
// write in; workspace tags only owners. Without a scope: whether the person
// may create tags at all.
export async function canCreateTags(user: Identity, workspaceId: string, spaceId?: string | null) {
  const role = await memberRole(user, workspaceId);
  if (!role || role === "viewer" || await isGuest(user, workspaceId) || user.apiScope === "read") return false;
  if (spaceId === undefined) return true;
  if (spaceId === null) return await canManageTaxonomy(user, workspaceId);
  const space = await one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=?", spaceId, workspaceId);
  return !!space && ["editor", "owner"].includes(await spaceRole(user, space) || "");
}
async function requireManage(user: Identity, workspaceId: string, spaceId: string | null = null) {
  await requireMember(user, workspaceId, "editor");
  if (!(await canManageScope(user, workspaceId, spaceId)))
    throw new HttpError(
      403,
      spaceId
        ? "Tags und Eigenschaften eines Bereichs verwalten nur Eigentümer des Arbeitsbereichs und des Bereichs."
        : "Tags und Eigenschaften verwalten nur Eigentümer des Arbeitsbereichs.",
    );
}
// The spaces whose scoped tags and definitions a person sees: those they
// may open; owners see every scope (they manage them).
export async function visibleScopes(user: Identity, workspaceId: string): Promise<(spaceId: string | null | undefined) => boolean> {
  if (await canManageTaxonomy(user, workspaceId)) return () => true;
  const open = new Set(
    (await filterAsync(await all<Space>("SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL", workspaceId), async (s) => !!(await spaceRole(user, s))))
      .map((s) => s.id),
  );
  return (spaceId) => !spaceId || open.has(spaceId);
}

// ---- Reading ----

// The definitions and the tags of the visible pages for the bootstrap.
// Guests learn only the tags and properties used on pages shared with them.
export async function workspaceTaxonomy(user: Identity, workspaceId: string, visiblePages: Pick<Page, "id" | "space_id">[]): Promise<WorkspaceTaxonomy> {
  const visible = await filterAsync(visiblePages, async (p) => !(await isEncryptedPage(p)));
  const ids = new Set(visible.map((p) => p.id));
  const links: Record<string, string[]> = {};
  for (const link of await all<{ page_id: string; tag_id: string }>(
    "SELECT l.page_id,l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE t.workspace_id=? ORDER BY l.position,t.position",
    workspaceId,
  ))
    if (ids.has(link.page_id)) (links[link.page_id] ||= []).push(link.tag_id);
  // A space's own ones: for who may open that space, and where they are on
  // a page one may read (a page shared from a private space, #136).
  const visibleScope = await visibleScopes(user, workspaceId);
  const onPages = new Set(Object.values(links).flat());
  const scopedValues = new Set(
    (await all<{ page_id: string; property_id: string }>(
      "SELECT v.page_id,v.property_id FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE d.workspace_id=? AND d.space_id IS NOT NULL",
      workspaceId,
    ))
      .filter((v) => ids.has(v.page_id))
      .map((v) => v.property_id),
  );
  let tags = (await workspaceTags(workspaceId)).filter((t) => visibleScope(t.spaceId) || onPages.has(t.id)),
    properties = (await workspaceProperties(workspaceId)).filter((p) => visibleScope(p.spaceId) || scopedValues.has(p.id));
  if (await isGuest(user, workspaceId)) {
    // Tags of the pages and of the records (tag-backed properties, #79)
    // shared with the guest.
    const used = new Set([...Object.values(links).flat(), ...(await taggedRecords(user, workspaceId)).flatMap((r) => r.tags)]);
    tags = tags.filter((t) => used.has(t.id));
    const valued = new Set(
      (await all<{ page_id: string; property_id: string }>(
        "SELECT v.page_id,v.property_id FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE d.workspace_id=?",
        workspaceId,
      ))
        .filter((v) => ids.has(v.page_id))
        .map((v) => v.property_id),
    );
    properties = properties.filter((p) => valued.has(p.id));
  }
  const manage = await canManageTaxonomy(user, workspaceId);
  const manageSpaces = manage
    ? []
    : (await filterAsync((await all<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND deleted_at IS NULL AND owner_id=?", workspaceId, user.id))
        .map((s) => s.id), async (sid) => await canManageScope(user, workspaceId, sid)));
  return { tags, properties, links, manage, createTags: await canCreateTags(user, workspaceId), manageSpaces };
}

function storedValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export async function pageInfo(pageId: string): Promise<PageInfo> {
  const page = await one<{ created_at: string | null; created_by: string | null; updated_at: string | null }>(
    // Pages from before schema 82 have no created_at: their first version
    // or, without one, their last change.
    "SELECT COALESCE(created_at,(SELECT MIN(s.created_at) FROM snapshots s WHERE s.page_id=pages.id),updated_at) created_at,created_by,updated_at FROM pages WHERE id=?",
    pageId,
  );
  const editor = await one<{ user_id: string }>("SELECT user_id FROM page_edits WHERE page_id=? ORDER BY at DESC LIMIT 1", pageId);
  return {
    createdAt: page?.created_at ?? null,
    createdBy: page?.created_by ?? null,
    updatedAt: page?.updated_at ?? null,
    updatedBy: editor?.user_id ?? page?.created_by ?? null,
  };
}
// The tags and values of a page (no permission check: the caller read it).
export async function pageMeta(pageId: string): Promise<PageMeta> {
  return {
    tags: (await all<{ tag_id: string }>(
      "SELECT l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
      pageId,
    )).map((l) => l.tag_id),
    values: Object.fromEntries(
      (await all<{ property_id: string; value: string }>("SELECT property_id,value FROM page_property_values WHERE page_id=?", pageId)).map((v) => [
        v.property_id,
        storedValue(v.value),
      ]),
    ),
    info: await pageInfo(pageId),
  };
}
// What pageData hands out; nothing for encrypted pages.
export async function pageMetaFor(page: Pick<Page, "id" | "space_id">): Promise<PageMeta | undefined> {
  return (await isEncryptedPage(page)) ? undefined : (await pageMeta(page.id));
}

// ---- Values ----

// A value for a definition as stored, or null for "no value" (removed).
export async function parsePropertyValue(def: PagePropertyDef, value: unknown, workspaceId: string): Promise<unknown> {
  if (isComputedProperty(def.type)) throw new HttpError(400, `${def.name}: Diese Eigenschaft wird automatisch gesetzt.`);
  if (value === null || value === undefined || value === "") return null;
  const bad = (): never => {
    throw new HttpError(400, `${def.name}: Ungültiger Wert.`);
  };
  switch (def.type) {
    case "number": {
      const n = typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) bad();
      return n;
    }
    case "checkbox":
      if (typeof value !== "boolean") bad();
      return value ? true : null;
    case "date":
      if (!validDateValue(value)) bad();
      return value;
    case "select": {
      if (typeof value !== "string") bad();
      const option = def.options.find((o) => foldName(o) === foldName(String(value)));
      if (!option) throw new HttpError(400, `${def.name}: Unbekannte Auswahl.`);
      return option;
    }
    case "multiselect": {
      const list = z.array(z.string()).max(MAX_OPTIONS).safeParse(Array.isArray(value) ? value : [value]);
      if (!list.success) bad();
      const chosen = [...new Set(list.data!.map((v) => def.options.find((o) => foldName(o) === foldName(v)) ?? null))];
      if (chosen.includes(null)) throw new HttpError(400, `${def.name}: Unbekannte Auswahl.`);
      return chosen.length ? chosen : null;
    }
    case "person": {
      if (typeof value !== "string") bad();
      if (!(await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, String(value))))
        throw new HttpError(400, `${def.name}: Mitglied fehlt.`);
      return value;
    }
    default: {
      if (typeof value !== "string" && typeof value !== "number") bad();
      const text = String(value).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim();
      if (text.length > MAX_TEXT_VALUE) throw new HttpError(400, `${def.name}: Höchstens 2000 Zeichen.`);
      return text || null;
    }
  }
}

// Where a tag is looked up and created: a page's workspace and space (the
// context, #136). `spaceId` null: the workspace's tags only.
export type MetaScope = { workspaceId: string; spaceId: string | null };
export const scopeOf = (page: Pick<Page, "workspace_id" | "space_id">): MetaScope => ({ workspaceId: page.workspace_id, spaceId: page.space_id ?? null });
const OTHER_SPACE_TAG = "Dieser Tag gehört zu einem anderen Bereich.";
// An existing tag of the context by id or name.
async function findTag(scope: MetaScope, ref: string): Promise<string | undefined> {
  return (await one<{ id: string }>(
    `SELECT id FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) AND (id=? OR ${d().ieq("name")})`,
    scope.workspaceId,
    scope.spaceId,
    ref,
    cleanTagName(ref),
  ))?.id;
}
// A tag of the context by id or name; a new name creates the tag in the
// context's space (or the workspace for spaceId null) when the person may.
// A tag of another space is refused, never silently replaced.
export async function resolveTag(user: Identity | null, scope: MetaScope, ref: string, color?: string): Promise<string | null> {
  const { workspaceId, spaceId } = scope;
  const byId = await one<{ id: string; space_id: string | null }>("SELECT id,space_id FROM page_tags WHERE id=? AND workspace_id=?", ref, workspaceId);
  if (byId) {
    if (!inScope({ spaceId: byId.space_id }, spaceId)) throw new HttpError(400, OTHER_SPACE_TAG);
    return byId.id;
  }
  const name = cleanTagName(ref);
  if (!name) return null;
  const byName = await one<{ id: string }>(
    `SELECT id FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) AND ${d().ieq("name")} ORDER BY space_id IS NOT NULL`,
    workspaceId,
    spaceId,
    name,
  );
  if (byName) return byName.id;
  if (user && !(await canCreateTags(user, workspaceId, spaceId)))
    throw new HttpError(
      403,
      spaceId ? "Neue Tags legen nur Mitglieder mit Bearbeitungsrechten an." : "Tags für den ganzen Arbeitsbereich legen nur Eigentümer an.",
    );
  // Names, the limit and the position: one creation at a time per workspace.
  await lockFor(`tags:${workspaceId}`);
  const clash = await scopeClash("page_tags", workspaceId, spaceId, name);
  if (clash) throw new HttpError(409, await clashMessage("page_tags", clash));
  if (((await one<{ n: number }>("SELECT COUNT(*) n FROM page_tags WHERE workspace_id=?", workspaceId))?.n ?? 0) >= MAX_TAGS)
    throw new HttpError(400, "Höchstens 1000 Tags je Arbeitsbereich.");
  const tagId = id();
  await run(
    "INSERT INTO page_tags(id,workspace_id,space_id,name,color,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_tags WHERE workspace_id=?),?,?)",
    tagId,
    workspaceId,
    spaceId,
    name,
    color ? tagColorFrom(color) : (await autoColor(workspaceId)),
    workspaceId,
    user?.id ?? null,
    Date.now(),
  );
  // Tag-backed database properties offer it at once (lib/tag-fields.ts).
  await syncTagFieldOptions(workspaceId);
  return tagId;
}
// New tags take the colours in turn, so neighbours differ.
async function autoColor(workspaceId: string): Promise<PageTagColor> {
  const count = (await one<{ n: number }>("SELECT COUNT(*) n FROM page_tags WHERE workspace_id=?", workspaceId))?.n ?? 0;
  const palette = PAGE_TAG_COLORS.filter((c) => c !== "gray");
  return palette[count % palette.length];
}

async function setPageTags(user: Identity | null, page: Pick<Page, "id" | "workspace_id" | "space_id">, refs: string[]) {
  const ids: string[] = [];
  for (const ref of refs) {
    const tagId = await resolveTag(user, scopeOf(page), ref);
    if (tagId && !ids.includes(tagId)) ids.push(tagId);
  }
  if (ids.length > MAX_TAGS_PER_PAGE) throw new HttpError(400, "Höchstens 50 Tags je Seite.");
  await run(`DELETE FROM page_tag_links WHERE page_id=? AND tag_id NOT IN ${d().jsonValues()}`, page.id, JSON.stringify(ids));
  await forEachAsync(ids, async (tagId, i) =>
    await run("INSERT INTO page_tag_links(page_id,tag_id,position) VALUES(?,?,?) ON CONFLICT(page_id,tag_id) DO UPDATE SET position=excluded.position", page.id, tagId, i),
  );
  return ids;
}
export async function setPageValue(pageId: string, propertyId: string, value: unknown) {
  if (value === null || isEmptyValue(value)) await run("DELETE FROM page_property_values WHERE page_id=? AND property_id=?", pageId, propertyId);
  else
    await run(
      "INSERT INTO page_property_values(page_id,property_id,value) VALUES(?,?,?) ON CONFLICT(page_id,property_id) DO UPDATE SET value=excluded.value",
      pageId,
      propertyId,
      JSON.stringify(value),
    );
}

// The names of a page's tags, in its order.
export async function pageTagNames(pageId: string): Promise<string[]> {
  return (await all<{ name: string }>(
    "SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
    pageId,
  )).map((t) => t.name);
}

// ---- Commands ----

const uuid = z.string().uuid();
const tagRefs = z.array(z.string().min(1).max(200)).max(200);
const colorSchema = z.enum(PAGE_TAG_COLORS);
const optionsSchema = z.array(z.string().max(1000)).max(MAX_OPTIONS * 2);


export function cleanOptions(list: string[]) {
  const out: string[] = [];
  for (const raw of list) {
    const option = cleanName(raw, MAX_OPTION_LENGTH);
    if (option && !out.some((o) => foldName(o) === foldName(option))) out.push(option);
  }
  if (out.length > MAX_OPTIONS) throw new HttpError(400, "Höchstens 100 Optionen.");
  return out;
}
async function touch(pageId: string) {
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), pageId);
}
// The page's tags and values after a change (the command's answer).
const metaAnswer = async (pageId: string) => {
  const meta = await pageMeta(pageId);
  return { ok: true, tags: meta.tags, values: meta.values };
};

// `write` is the command's page check (editor rights, journal PIN, lock).
export async function pagePropertiesCommand(user: Identity, action: string, input: Record<string, unknown>, write: () => (Page) | Promise<Page>): Promise<unknown> {
  switch (action) {
    // { pageId, tags?: [id or name], addTags?, removeTags?, values?: { id or name: value | null } }
    case "page.properties": {
      const b = z
        .object({
          pageId: uuid,
          tags: tagRefs.optional(),
          addTags: tagRefs.optional(),
          removeTags: tagRefs.optional(),
          values: z.record(z.string().max(200), z.unknown()).optional(),
        })
        .parse(input);
      const page = await write();
      if (await isEncryptedPage(page)) throw new HttpError(409, "Seiten verschlüsselter Bereiche haben keine Tags und Eigenschaften.");
      if (b.tags || b.addTags || b.removeTags) {
        const ids = await setPageTags(user, page, [...(b.tags ?? (await pageMeta(page.id)).tags), ...(b.addTags || [])]);
        const removed = new Set(await mapAsync((b.removeTags || []), async (ref) => await findTag(scopeOf(page), ref)));
        if (ids.some((tagId) => removed.has(tagId))) await setPageTags(user, page, ids.filter((tagId) => !removed.has(tagId)));
      }
      if (b.values) {
        // The definitions of the page's context (#136).
        const defs = await contextProperties(page.workspace_id, page.space_id);
        for (const [key, value] of Object.entries(b.values)) {
          const def = defs.find((d) => d.id === key) ?? defs.find((d) => foldName(d.name) === foldName(key));
          if (!def) throw new HttpError(400, "Unbekannte Eigenschaft.");
          await setPageValue(page.id, def.id, await parsePropertyValue(def, value, page.workspace_id));
        }
      }
      await touch(page.id);
      return await metaAnswer(page.id);
    }
    // Several pages at once: { workspaceId, pageIds, addTags?, removeTags? }.
    case "pages.tag": {
      const b = z.object({ workspaceId: uuid, pageIds: z.array(uuid).min(1).max(500), addTags: tagRefs.optional(), removeTags: tagRefs.optional() }).parse(input);
      await requireMember(user, b.workspaceId);
      const pages = await mapAsync(b.pageIds, async (pid) => await requirePage(user, pid, true));
      if (pages.some((p) => p.workspace_id !== b.workspaceId)) throw new HttpError(400, "Seiten aus einem anderen Arbeitsbereich.");
      if (pages.some((p) => p.locked)) throw new HttpError(409, "Diese Seite ist gesperrt.");
      for (const page of pages) {
        if (await isEncryptedPage(page)) continue;
        const current = (await pageMeta(page.id)).tags;
        const removed = new Set(await mapAsync((b.removeTags || []), async (ref) => await findTag(scopeOf(page), ref)));
        await setPageTags(user, page, [...current.filter((t) => !removed.has(t)), ...(b.addTags || [])]);
        await touch(page.id);
      }
      return { ok: true, pages: pages.length };
    }
    // { workspaceId, tagId?, name, color?, spaceId? } – a new tag (of the
    // space `spaceId`, members who may write there; without it, or with
    // `spaceId: null`, of the whole workspace: owners) or a changed one
    // (owners, and space managers for their space's tags).
    case "tag.save": {
      const b = z
        .object({ workspaceId: uuid, tagId: uuid.optional(), name: z.string().max(1000), color: colorSchema.optional(), spaceId: uuid.nullable().optional() })
        .parse(input);
      await requireMember(user, b.workspaceId, "editor");
      const name = cleanTagName(b.name);
      if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
      if (!b.tagId) {
        const spaceId = b.spaceId ?? null;
        if (spaceId) await scopeSpace(b.workspaceId, spaceId);
        // A space's rights before the name check: a clash must not tell
        // outsiders which tags a space has (workspace tags every member
        // sees anyway, so there the clash still comes first).
        if (spaceId && !(await canCreateTags(user, b.workspaceId, spaceId))) throw new HttpError(403, "Keine Schreibrechte in diesem Bereich.");
        const clash = await scopeClash("page_tags", b.workspaceId, spaceId, name);
        if (clash) throw new HttpError(409, await clashMessage("page_tags", clash));
        if (!(await canCreateTags(user, b.workspaceId, spaceId)))
          throw new HttpError(403, spaceId ? "Keine Schreibrechte in diesem Bereich." : "Tags für den ganzen Arbeitsbereich legen nur Eigentümer an.");
        const tagId = await resolveTag(user, { workspaceId: b.workspaceId, spaceId }, name);
        if (b.color) await run("UPDATE page_tags SET color=? WHERE id=?", b.color, tagId);
        await audit(user.id, "tag.create", tagId!, `${name}${spaceId ? ` (${spaceId})` : ""}`);
        return { ok: true, id: tagId };
      }
      const before = await one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", b.tagId, b.workspaceId);
      if (!before) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      await requireManage(user, b.workspaceId, before.space_id);
      const clash = await scopeClash("page_tags", b.workspaceId, before.space_id, name, b.tagId);
      if (clash) throw new HttpError(409, `${await clashMessage("page_tags", clash)} Zum Zusammenführen „Zusammenführen“ wählen.`);
      await run("UPDATE page_tags SET name=?,color=COALESCE(?,color) WHERE id=?", name, b.color ?? null, b.tagId);
      // Records of tag-backed properties keep the tag under its new name.
      if (before.name !== name) await rewriteTagValues(user, b.workspaceId, before.name, name, before.space_id);
      await syncTagFieldOptions(b.workspaceId);
      await audit(user.id, "tag.save", b.tagId, name);
      return { ok: true, id: b.tagId };
    }
    case "tag.delete": {
      const b = z.object({ workspaceId: uuid, tagId: uuid }).parse(input);
      const tag = await one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", b.tagId, b.workspaceId);
      if (!tag) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      await requireManage(user, b.workspaceId, tag.space_id);
      await run("DELETE FROM page_tags WHERE id=?", tag.id);
      // The tag leaves the records of tag-backed properties too.
      await rewriteTagValues(user, b.workspaceId, tag.name, null, tag.space_id);
      await syncTagFieldOptions(b.workspaceId);
      await audit(user.id, "tag.delete", tag.id, tag.name);
      return { ok: true };
    }
    // { workspaceId, tagId, into }: pages with tagId get `into`, tagId goes.
    // Only into a tag every page of the source may carry: one of the
    // workspace or of the same space (#136).
    case "tag.merge": {
      const b = z.object({ workspaceId: uuid, tagId: uuid, into: uuid }).parse(input);
      if (b.tagId === b.into) throw new HttpError(400, "Einen Tag mit sich selbst zusammenführen geht nicht.");
      const [from, into] = await mapAsync([b.tagId, b.into], async (tid) => await one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", tid, b.workspaceId));
      if (!from || !into) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      await requireManage(user, b.workspaceId, from.space_id);
      await requireManage(user, b.workspaceId, into.space_id);
      if (into.space_id && into.space_id !== from.space_id)
        throw new HttpError(409, "Nur in einen Tag des ganzen Arbeitsbereichs oder desselben Bereichs zusammenführen.");
      await run(
        "INSERT INTO page_tag_links(page_id,tag_id,position) SELECT page_id,?,position FROM page_tag_links WHERE tag_id=? ON CONFLICT(page_id,tag_id) DO NOTHING",
        into.id,
        from.id,
      );
      await run("DELETE FROM page_tags WHERE id=?", from.id);
      // Records with the source carry the target (once).
      await rewriteTagValues(user, b.workspaceId, from.name, into.name, from.space_id);
      await syncTagFieldOptions(b.workspaceId);
      await audit(user.id, "tag.merge", into.id, `${from.name} → ${into.name}`);
      return { ok: true };
    }
    case "tag.reorder":
    case "property.reorder": {
      const b = z.object({ workspaceId: uuid, order: z.array(uuid).max(MAX_TAGS) }).parse(input);
      const table = action === "tag.reorder" ? "page_tags" : "page_property_defs";
      // Space managers order their space's own ones (#136).
      const scopes = new Set(
        (await all<{ space_id: string | null }>(`SELECT space_id FROM ${table} WHERE workspace_id=? AND id IN ${d().jsonValues()}`, b.workspaceId, JSON.stringify(b.order))).map(
          (r) => r.space_id,
        ),
      );
      if (!scopes.size) await requireManage(user, b.workspaceId);
      for (const scope of scopes) await requireManage(user, b.workspaceId, scope);
      await forEachAsync(b.order, async (itemId, i) => await run(`UPDATE ${table} SET position=? WHERE id=? AND workspace_id=?`, i + 1, itemId, b.workspaceId));
      if (action === "tag.reorder") await syncTagFieldOptions(b.workspaceId);
      return { ok: true };
    }
    // { workspaceId, propertyId?, name, type, options? }
    case "property.save": {
      const b = z
        .object({
          workspaceId: uuid,
          propertyId: uuid.optional(),
          name: z.string().max(1000),
          type: z.enum(PAGE_PROPERTY_TYPES).optional(),
          options: optionsSchema.optional(),
          // New ones: the space they belong to; without it the workspace (#136).
          spaceId: uuid.nullable().optional(),
        })
        .parse(input);
      const name = cleanName(b.name, MAX_PROPERTY_NAME);
      if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
      const stored = b.propertyId ? (await one<DefRow>("SELECT * FROM page_property_defs WHERE id=? AND workspace_id=?", b.propertyId, b.workspaceId)) : undefined;
      if (b.propertyId && !stored) throw new HttpError(404, "Eigenschaft nicht gefunden.");
      const spaceId = stored ? stored.space_id : (b.spaceId ?? null);
      if (!stored && spaceId) await scopeSpace(b.workspaceId, spaceId);
      await requireManage(user, b.workspaceId, spaceId);
      await lockFor(`properties:${b.workspaceId}`);
      const clash = await scopeClash("page_property_defs", b.workspaceId, spaceId, name, b.propertyId);
      if (clash) throw new HttpError(409, await clashMessage("page_property_defs", clash));
      if (!stored) {
        if (!b.type) throw new HttpError(400, "Bitte einen Typ wählen.");
        if (((await one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", b.workspaceId))?.n ?? 0) >= MAX_PROPERTIES)
          throw new HttpError(400, "Höchstens 100 Eigenschaften je Arbeitsbereich.");
        const propertyId = id();
        await run(
          "INSERT INTO page_property_defs(id,workspace_id,space_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
          propertyId,
          b.workspaceId,
          spaceId,
          name,
          b.type,
          JSON.stringify(["select", "multiselect"].includes(b.type) ? cleanOptions(b.options || []) : []),
          b.workspaceId,
          user.id,
          Date.now(),
        );
        await audit(user.id, "property.save", propertyId, name);
        return { ok: true, id: propertyId };
      }
      const before = asDef(stored);
      const type = b.type ?? before.type;
      const next: PagePropertyDef = {
        ...before,
        name,
        type,
        options: ["select", "multiselect"].includes(type) ? cleanOptions(b.options ?? before.options) : [],
      };
      await run("UPDATE page_property_defs SET name=?,type=?,options=? WHERE id=?", next.name, next.type, JSON.stringify(next.options), next.id);
      // Values that no longer fit (another type, a removed option) are
      // converted where possible, else removed.
      if (type !== before.type || JSON.stringify(next.options) !== JSON.stringify(before.options))
        for (const v of await all<{ page_id: string; value: string }>("SELECT page_id,value FROM page_property_values WHERE property_id=?", next.id)) {
          let value: unknown = null;
          if (!isComputedProperty(type))
            try {
              value = await parsePropertyValue(next, convertValue(before, next, storedValue(v.value)), b.workspaceId);
            } catch {
              value = null;
            }
          await setPageValue(v.page_id, next.id, value);
        }
      await audit(user.id, "property.save", next.id, name);
      return { ok: true, id: next.id };
    }
    case "property.delete": {
      const b = z.object({ workspaceId: uuid, propertyId: uuid }).parse(input);
      const stored = await one<DefRow>("SELECT * FROM page_property_defs WHERE id=? AND workspace_id=?", b.propertyId, b.workspaceId);
      if (!stored) throw new HttpError(404, "Eigenschaft nicht gefunden.");
      await requireManage(user, b.workspaceId, stored.space_id);
      await run("DELETE FROM page_property_defs WHERE id=?", stored.id);
      await audit(user.id, "property.delete", stored.id, stored.name);
      return { ok: true };
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}
// A value of one type as the next type would take it (text ↔ select …).
export function convertValue(from: PagePropertyDef, to: PagePropertyDef, value: unknown): unknown {
  if (from.type === to.type) return value;
  if (to.type === "multiselect") return Array.isArray(value) ? value : [String(value)];
  if (Array.isArray(value)) return to.type === "select" ? value[0] : value.join(", ");
  if (to.type === "checkbox") return typeof value === "boolean" ? value : null;
  if (to.type === "number") return typeof value === "number" ? value : String(value);
  if (from.type === "person" || from.type === "checkbox") return null;
  return typeof value === "number" ? String(value) : value;
}

// ---- Search ----

// The words of a page's tags and values in the search index (people are
// left out, as in records).
export async function pageMetaSearchText(pageId: string): Promise<string> {
  const tags = (await all<{ name: string }>(
    "SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position",
    pageId,
  )).map((t) => `#${t.name}`);
  const values = (await all<DefRow & { value: string }>(
    "SELECT d.*,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=?",
    pageId,
  ))
    .filter((v) => !["person", "checkbox"].includes(v.type))
    .map((v) => propertyText(asDef(v), storedValue(v.value)))
    .filter(Boolean);
  return [...tags, ...values].join(" · ");
}

// The pages of a workspace that pass the tag and property tokens of a
// search; null without tokens. Reading rights are checked by the search.
export async function filteredPageIds(user: Identity, workspaceId: string, parsed: Pick<ParsedQuery, "tags" | "properties">): Promise<Set<string> | null> {
  if (!parsed.tags.length && !parsed.properties.length) return null;
  let ids = new Set(
    (await all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0", workspaceId)).map((p) => p.id),
  );
  const keep = (next: Set<string>) => {
    ids = new Set([...ids].filter((pid) => next.has(pid)));
  };
  for (const filter of parsed.tags) {
    const tagged = new Set(
      (await all<{ page_id: string }>(`SELECT page_id FROM page_tag_links WHERE tag_id IN ${d().jsonValues()}`, JSON.stringify(tagFilterIds(filter)))).map((l) => l.page_id),
    );
    ids = new Set([...ids].filter((pid) => tagged.has(pid) !== filter.exclude));
  }
  if (parsed.properties.length) {
    const defs = new Map((await workspaceProperties(workspaceId)).map((d) => [d.id, d]));
    const names = new Map((await all<{ id: string; name: string }>("SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?", workspaceId)).map((u) => [u.id, u.name]));
    const people = (uid: string) => names.get(uid);
    // A token names a property: the one of that name in each space (#136)
    // – a page passes with the one of its context.
    const passingFor = async (filter: PropertyFilter): Promise<Set<string>> => {
      const def = defs.get(filter.propertyId);
      if (!def) return new Set();
      const own = [...ids].filter((pid) => !def.spaceId || pageSpaces.get(pid) === def.spaceId);
      if (isComputedProperty(def.type)) {
        const passing = new Set<string>();
        for (const pid of own) {
          const info = await pageInfo(pid);
          const value = { created_at: info.createdAt, updated_at: info.updatedAt, created_by: info.createdBy, updated_by: info.updatedBy }[def.type as "created_at"];
          if (matchesPropertyFilter(def, value, filter, people, user.id)) passing.add(pid);
        }
        return passing;
      }
      const values = new Map(
        (await all<{ page_id: string; value: string }>("SELECT page_id,value FROM page_property_values WHERE property_id=?", def.id)).map((v) => [v.page_id, storedValue(v.value)]),
      );
      return new Set(own.filter((pid) => matchesPropertyFilter(def, values.get(pid), filter, people, user.id)));
    };
    const pageSpaces = new Map((await all<{ id: string; space_id: string }>("SELECT id,space_id FROM pages WHERE workspace_id=?", workspaceId)).map((p) => [p.id, p.space_id]));
    for (const filter of parsed.properties) {
      if (!defs.has(filter.propertyId)) continue;
      const passing = await passingFor(filter);
      for (const other of filter.also ?? []) for (const pid of await passingFor(other)) passing.add(pid);
      keep(passing);
    }
  }
  return ids;
}

// ---- Portable form (templates, copies, archives, Markdown) ----

export async function portableMeta(pageId: string): Promise<PortableMeta | undefined> {
  const tags = (await all<TagRow>(
    "SELECT t.* FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
    pageId,
  )).map((t) => ({ name: t.name, color: t.color, ...(t.space_id ? { space: true } : {}) }));
  const properties = (await all<DefRow & { value: string }>(
    "SELECT d.*,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=? ORDER BY d.position",
    pageId,
  )).map((v) => {
    const def = asDef(v);
    return { name: def.name, type: def.type, ...(def.options.length ? { options: def.options } : {}), value: storedValue(v.value), ...(v.space_id ? { space: true } : {}) };
  });
  return tags.length || properties.length ? { ...(tags.length ? { tags } : {}), ...(properties.length ? { properties } : {}) } : undefined;
}
export const portableMetaSchema = z
  .object({
    tags: z.array(z.object({ name: z.string().max(1000), color: z.string().max(100).optional(), space: z.boolean().optional() })).max(200).optional(),
    properties: z
      .array(
        z.object({
          name: z.string().max(1000),
          type: z.enum(PAGE_PROPERTY_TYPES),
          options: z.array(z.string().max(1000)).max(500).optional(),
          value: z.unknown(),
          space: z.boolean().optional(),
        }),
      )
      .max(200)
      .optional(),
  })
  .optional();

// Puts tags and values by name onto a page, in its context (the
// workspace's and its space's, #136). Tags missing there are created for
// the page's space (when `user` may, or always for `user` null: imports run
// with the checks of their own command). Definitions missing are created
// only with `createDefinitions` (archives and imports of workspace owners;
// for one marked `space` – or listed in `createIn` – in the page's space,
// else for the workspace); values that do not fit are skipped, never fail
// the whole operation.
export async function applyPortableMeta(
  user: Identity | null,
  page: Pick<Page, "id" | "workspace_id" | "space_id">,
  meta: PortableMeta | undefined,
  // definitionsScope "marked": new definitions belong to the workspace
  // unless marked `space` (archives); by default to the page's space.
  options: { createDefinitions?: boolean; createTags?: boolean; createProperties?: Set<string>; definitionsScope?: "space" | "marked" } = {},
) {
  if (!meta || await isEncryptedPage(page)) return;
  const scope = scopeOf(page);
  const mayCreateTags = options.createTags ?? (user ? (await canCreateTags(user, page.workspace_id, page.space_id)) : true);
  const tagIds: string[] = [...(await pageMeta(page.id)).tags];
  for (const tag of meta.tags || []) {
    const name = cleanTagName(tag.name);
    if (!name) continue;
    let tagId =
      (await one<{ id: string }>(
        `SELECT id FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) AND ${d().ieq("name")} ORDER BY space_id IS NOT NULL`,
        scope.workspaceId,
        scope.spaceId,
        name,
      ))?.id ?? null;
    if (!tagId && mayCreateTags)
      try {
        tagId = await resolveTag(null, options.definitionsScope === "marked" && !tag.space ? { ...scope, spaceId: null } : scope, name, tag.color);
      } catch {
        tagId = null;
      }
    if (tagId && !tagIds.includes(tagId)) tagIds.push(tagId);
  }
  if (tagIds.length) await setPageTags(null, page, tagIds.slice(0, MAX_TAGS_PER_PAGE));
  for (const property of meta.properties || []) {
    if (isComputedProperty(property.type)) continue;
    const name = cleanName(property.name, MAX_PROPERTY_NAME);
    if (!name) continue;
    let stored = await one<DefRow>(
      `SELECT * FROM page_property_defs WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) AND ${d().ieq("name")} ORDER BY space_id IS NOT NULL`,
      page.workspace_id,
      scope.spaceId,
      name,
    );
    const copy = options.createProperties?.has(foldName(name));
    if (!stored && (options.createDefinitions || copy)) {
      await lockFor(`properties:${page.workspace_id}`);
      if (((await one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", page.workspace_id))?.n ?? 0) >= MAX_PROPERTIES) continue;
      const spaceId = property.space || copy || options.definitionsScope !== "marked" ? scope.spaceId : null;
      if (await scopeClash("page_property_defs", page.workspace_id, spaceId, name)) continue;
      const propertyId = id();
      await run(
        "INSERT INTO page_property_defs(id,workspace_id,space_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
        propertyId,
        page.workspace_id,
        spaceId,
        name,
        property.type,
        "[]",
        page.workspace_id,
        user?.id ?? null,
        Date.now(),
      );
      stored = await one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", propertyId);
    }
    if (!stored) continue;
    let def = asDef(stored);
    // Options a value needs are added when definitions may be created.
    if ((options.createDefinitions || copy) && ["select", "multiselect"].includes(def.type)) {
      const wanted = [...(property.options || []), ...(Array.isArray(property.value) ? property.value : [property.value])].filter(
        (v): v is string => typeof v === "string" && !!v.trim(),
      );
      const merged = cleanOptions([...def.options, ...wanted].slice(0, MAX_OPTIONS));
      if (merged.length !== def.options.length) {
        await run("UPDATE page_property_defs SET options=? WHERE id=?", JSON.stringify(merged), def.id);
        def = { ...def, options: merged };
      }
    }
    try {
      const value = await parsePropertyValue(def, convertValue({ ...def, type: property.type }, def, property.value), page.workspace_id);
      if (value !== null) await setPageValue(page.id, def.id, value);
    } catch {
      // A value that does not fit this workspace is left out.
    }
  }
}

// Duplicates, templates: the copy gets the source's tags and values. By id
// for what the copy's context has (the workspace's, its space's); the rest
// by name (#136: in another space or workspace the same-named one of the
// copy's context, else tags created for its space when allowed and
// definitions copied into its space – the source keeps its own).
export async function copyPageMeta(user: Identity, fromPageId: string, to: Pick<Page, "id" | "workspace_id" | "space_id">) {
  const from = await one<Page>("SELECT * FROM pages WHERE id=?", fromPageId);
  if (!from || await isEncryptedPage(from) || await isEncryptedPage(to)) return;
  if (from.workspace_id === to.workspace_id) {
    await run(
      d().insertIgnore("page_tag_links(page_id,tag_id,position) SELECT ?,l.tag_id,l.position FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? AND (t.space_id IS NULL OR t.space_id=?)"),
      to.id,
      from.id,
      to.space_id,
    );
    await run(
      d().insertIgnore("page_property_values(page_id,property_id,value) SELECT ?,v.property_id,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=? AND (d.space_id IS NULL OR d.space_id=?)"),
      to.id,
      from.id,
      to.space_id,
    );
    if (from.space_id === to.space_id) return;
  }
  const meta = await portableMeta(from.id);
  if (!meta) return;
  const own = from.workspace_id === to.workspace_id;
  const foreign: PortableMeta = {
    tags: (meta.tags || []).filter((t) => !own || t.space),
    properties: (meta.properties || []).filter((p) => !own || p.space),
  };
  await applyPortableMeta(user, to, foreign, {
    createProperties: new Set((foreign.properties || []).filter((p) => p.space || !own).map((p) => foldName(p.name))),
  });
}

// ---- Frontmatter (Markdown export and import) ----

// Keys of a page's frontmatter: `tags` (as Obsidian reads them) and each
// property by its name; dates as YYYY-MM-DD…, people by name.
export async function metaFrontmatter(pageId: string, people: (id: string) => string | undefined): Promise<Record<string, string | number | boolean | string[]>> {
  const out: Record<string, string | number | boolean | string[]> = {};
  const tags = (await all<{ name: string }>(
    "SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
    pageId,
  )).map((t) => t.name);
  if (tags.length) out.tags = tags;
  for (const v of await all<DefRow & { value: string }>(
    "SELECT d.*,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=? ORDER BY d.position",
    pageId,
  )) {
    const def = asDef(v),
      value = storedValue(v.value);
    if (isEmptyValue(value)) continue;
    // Our own keys keep their meaning; a property named like them gets its id.
    const key = ["tags", "tag", "aliases", "alias", "flowplan"].includes(foldName(def.name)) || def.name in out ? `${def.name} (${def.id})` : def.name;
    if (def.type === "multiselect" && Array.isArray(value)) out[key] = value.map(String);
    else if (def.type === "checkbox") out[key] = !!value;
    else if (def.type === "number" && typeof value === "number") out[key] = value;
    else if (def.type === "person") {
      const name = people(String(value));
      if (name) out[key] = name;
    } else out[key] = String(value);
  }
  return out;
}

// Keys a Markdown import never turns into properties: the page's own
// (aliases, tags, Flowplan's) and what publishing tools keep there.
const NOT_PROPERTIES = new Set([
  "aliases",
  "alias",
  "tags",
  "tag",
  "flowplan",
  "title",
  "cssclass",
  "cssclasses",
  "publish",
  "permalink",
  "layout",
  "slug",
  "draft",
  "weight",
  "position",
  "sidebar_position",
  "template",
]);

// What a frontmatter carries for a page: the tags (`tags:`/`tag:` as a
// list or "a, b" / "a b") and properties – existing definitions by name,
// unknown keys as new ones when definitions may be created (the type
// guessed from the value). `consumed` lists the keys taken.
export async function frontmatterMeta(
  data: Record<string, unknown>,
  workspaceId: string,
  people: (name: string) => string | undefined,
  options: { createDefinitions?: boolean; spaceId?: string | null } = {},
): Promise<{ meta: PortableMeta; consumed: string[] }> {
  const meta: PortableMeta = { tags: [], properties: [] },
    consumed: string[] = [];
  // The definitions of the page's context (#136); without a space all.
  const defs = options.spaceId === undefined ? (await workspaceProperties(workspaceId)) : (await contextProperties(workspaceId, options.spaceId));
  for (const [key, raw] of Object.entries(data)) {
    const folded = foldName(key);
    if (folded === "tags" || folded === "tag") {
      for (const item of Array.isArray(raw) ? raw : [raw])
        if (typeof item === "string" || typeof item === "number")
          for (const name of String(item).split(Array.isArray(raw) ? /,/ : /[,\s]+/)) {
            const tag = cleanTagName(name);
            if (tag && !meta.tags!.some((t) => foldName(t.name) === foldName(tag))) meta.tags!.push({ name: tag });
          }
      consumed.push(key);
      continue;
    }
    if (NOT_PROPERTIES.has(folded) || raw === null || (typeof raw === "object" && !Array.isArray(raw))) continue;
    // "Name (id)" as the export writes a name that clashes.
    const name = key.replace(/ \([0-9a-f-]{36}\)$/i, "");
    const def = defs.find((d) => foldName(d.name) === foldName(name));
    if (!def && !options.createDefinitions) continue;
    const type: PagePropertyType = def?.type ?? guessType(raw);
    if (isComputedProperty(type)) {
      consumed.push(key);
      continue;
    }
    let value: unknown = raw;
    if (type === "person") value = typeof raw === "string" ? (people(raw) ?? null) : null;
    else if (type === "multiselect") value = (Array.isArray(raw) ? raw : String(raw).split(",")).map((v) => String(v).trim()).filter(Boolean);
    else if (type === "select" && Array.isArray(raw)) value = raw[0] == null ? null : String(raw[0]);
    else if (type === "checkbox") value = typeof raw === "boolean" ? raw : /^(true|yes|ja|x|1)$/i.test(String(raw));
    else if (Array.isArray(raw)) value = raw.map(String).join(", ");
    else if (type !== "number" && typeof raw !== "string") value = String(raw);
    if (value === null) continue;
    meta.properties!.push({ name: def?.name ?? cleanName(name, MAX_PROPERTY_NAME), type, value });
    consumed.push(key);
  }
  return { meta, consumed };
}
function guessType(raw: unknown): PagePropertyType {
  if (typeof raw === "boolean") return "checkbox";
  if (typeof raw === "number") return "number";
  if (Array.isArray(raw)) return "multiselect";
  const text = String(raw);
  if (validDateValue(text)) return "date";
  if (/^https?:\/\/\S+$/i.test(text)) return "url";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "email";
  return "text";
}

// GET /api/tags: the workspace's tags with how many readable pages and
// records (tag-backed database properties, #79) carry each, the property
// definitions and – with `tagId` – those pages and records.
// `sameName`: also the tags of that name in other spaces (#136; by default
// a tag is one id).
export async function tagListing(user: Identity, workspaceId: string, tagId?: string, sameName = false) {
  await requireMember(user, workspaceId);
  const locked = await lockedPageIds(user, workspaceId);
  const pages = await filterAsync(await all<Page>("SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY updated_at DESC", workspaceId), 
    async (p) => !locked.has(p.id) && !(await isEncryptedPage(p)) && !!(await pageRole(user, p)),
  );
  const taxonomy = await workspaceTaxonomy(user, workspaceId, pages);
  const counts = new Map<string, number>(),
    recordCounts = new Map<string, number>();
  for (const ids of Object.values(taxonomy.links)) for (const t of ids) counts.set(t, (counts.get(t) || 0) + 1);
  const records = await taggedRecords(user, workspaceId);
  for (const r of records) for (const t of r.tags) recordCounts.set(t, (recordCounts.get(t) || 0) + 1);
  const chosen = taxonomy.tags.find((t) => t.id === tagId);
  if (tagId && !chosen) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
  const wanted = new Set(chosen ? (sameName ? taxonomy.tags.filter((t) => foldName(t.name) === foldName(chosen.name)).map((t) => t.id) : [chosen.id]) : []);
  const carries = (ids: string[] | undefined) => !!ids?.some((t) => wanted.has(t));
  return {
    tags: taxonomy.tags.map((t) => ({ ...t, pages: counts.get(t.id) || 0, records: recordCounts.get(t.id) || 0 })),
    properties: taxonomy.properties,
    ...(tagId
      ? {
          pages: pages
            .filter((p) => carries(taxonomy.links[p.id]))
            .map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, space_id: p.space_id, parent_id: p.parent_id, updated_at: p.updated_at, tags: taxonomy.links[p.id] })),
          records: records
            .filter((r) => carries(r.tags))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((r) => ({
              page_id: r.pageId,
              row_id: r.rowId,
              title: r.title,
              icon: r.icon,
              database: r.databaseTitle,
              space_id: r.spaceId,
              updated_at: r.updatedAt,
              tags: r.tags,
            })),
        }
      : {}),
  };
}

// Members by name (frontmatter names people).
export async function memberByName(workspaceId: string) {
  const members = await all<{ id: string; name: string }>("SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?", workspaceId);
  return (name: string) => members.find((m) => foldName(m.name) === foldName(name))?.id;
}

// Git export: a file changed in the repository brings its tags and values
// back – they replace the page's (as its aliases do). True when they changed.
export async function syncMetaFromFrontmatter(user: Identity, page: Page, data: Record<string, unknown>): Promise<boolean> {
  if (await isEncryptedPage(page)) return false;
  const before = JSON.stringify(await portableMeta(page.id) ?? {});
  const { meta } = await frontmatterMeta(data, page.workspace_id, await memberByName(page.workspace_id), { spaceId: page.space_id });
  await run("DELETE FROM page_tag_links WHERE page_id=?", page.id);
  await run("DELETE FROM page_property_values WHERE page_id=?", page.id);
  await applyPortableMeta(user, page, meta);
  const changed = before !== JSON.stringify(await portableMeta(page.id) ?? {});
  if (changed) await touch(page.id);
  return changed;
}

// Archives: the workspace's tags and definitions by name; existing names
// are kept as they are.
export async function importTaxonomy(
  user: Identity,
  workspaceId: string,
  taxonomy: { tags: { name: string; color?: string; spaceId?: string }[]; properties: { name: string; type: PagePropertyType; options?: string[]; spaceId?: string }[] } | undefined,
  createDefinitions: boolean,
  spaceMap?: Map<string, string>,
) {
  if (!taxonomy) return;
  // A space's own ones go to the space it was restored as (#136); without
  // that space they are left out (its pages bring the ones they use).
  const scopeFor = (spaceId: string | undefined) => (spaceId ? (spaceMap?.get(spaceId) ?? undefined) : null);
  if (await canCreateTags(user, workspaceId))
    for (const tag of taxonomy.tags) {
      const spaceId = scopeFor(tag.spaceId);
      if (spaceId === undefined || await scopeClash("page_tags", workspaceId, spaceId, cleanTagName(tag.name))) continue;
      try {
        await resolveTag(null, { workspaceId, spaceId }, tag.name, tag.color);
      } catch {
        break;
      }
    }
  if (!createDefinitions) return;
  for (const property of taxonomy.properties) {
    const name = cleanName(property.name, MAX_PROPERTY_NAME);
    const spaceId = scopeFor(property.spaceId);
    if (!name || spaceId === undefined || await scopeClash("page_property_defs", workspaceId, spaceId, name)) continue;
    if (((await one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", workspaceId))?.n ?? 0) >= MAX_PROPERTIES) break;
    await run(
      "INSERT INTO page_property_defs(id,workspace_id,space_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
      id(),
      workspaceId,
      spaceId,
      name,
      property.type,
      JSON.stringify(["select", "multiselect"].includes(property.type) ? cleanOptions(property.options || []) : []),
      workspaceId,
      user.id,
      Date.now(),
    );
  }
}

// ---- On the asynchronous database (lib/db-driver) ----
//
// The tag list and tag.save on `db`: the shape this module takes once its
// callers are asynchronous (docs/architecture/database.md). Until then the
// synchronous functions above stay for them – workspaceTags/contextTags
// alone reach 121 functions (scripts/db-async-impact.mjs) and tag.save runs
// inside command() (lib/api.ts), which is synchronous. The permission
// checks (lib/permissions.ts) stay synchronous reads: inside db.tx() on
// Postgres they read what was committed before the transaction, which is
// what they need.

const tagOrder = (d: Dialect) => `ORDER BY position,${d.nocase("name")}`;
// The tags of a workspace (spaceId undefined: every scope), or of a page's
// context (the workspace's and those of `spaceId`; null: the workspace's).
export async function listTags(workspaceId: string, spaceId?: string | null): Promise<PageTag[]> {
  const rows =
    spaceId === undefined
      ? await db.all<TagRow>(`SELECT * FROM page_tags WHERE workspace_id=? ${tagOrder(db.dialect)}`, workspaceId)
      : await db.all<TagRow>(`SELECT * FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) ${tagOrder(db.dialect)}`, workspaceId, spaceId);
  return rows.map(asTag);
}
async function tagClash(workspaceId: string, spaceId: string | null, name: string, exceptId?: string) {
  const d = db.dialect;
  return db.one<{ id: string; space_id: string | null; name: string }>(
    `SELECT id,space_id,name FROM page_tags WHERE workspace_id=? AND ${d.ieq("name")} AND ${d.isNot("id")}${spaceId ? " AND (space_id IS NULL OR space_id=?)" : ""} ORDER BY space_id IS NOT NULL LIMIT 1`,
    workspaceId,
    name,
    exceptId ?? null,
    ...(spaceId ? [spaceId] : []),
  );
}
// A new tag `name` in the scope (checks done by the caller), or the one
// that won a race for the same name (Postgres: two requests at once).
async function createTag(user: Identity, workspaceId: string, spaceId: string | null, name: string, color?: PageTagColor) {
  const count = (await db.one<{ n: number }>("SELECT COUNT(*) n FROM page_tags WHERE workspace_id=?", workspaceId))?.n ?? 0;
  if (count >= MAX_TAGS) throw new HttpError(400, "Höchstens 1000 Tags je Arbeitsbereich.");
  // New tags take the colours in turn, so neighbours differ.
  const palette = PAGE_TAG_COLORS.filter((c) => c !== "gray");
  const tagId = id();
  try {
    // A savepoint: on Postgres a failed statement spoils the whole
    // transaction unless it ran in one – catching the error and going on
    // needs it there (SQLite does not care).
    await db.tx(() =>
      db.run(
        "INSERT INTO page_tags(id,workspace_id,space_id,name,color,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_tags WHERE workspace_id=?),?,?)",
        tagId,
        workspaceId,
        spaceId,
        name,
        color ?? palette[count % palette.length],
        workspaceId,
        user.id,
        Date.now(),
      ),
    );
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const clash = await tagClash(workspaceId, spaceId, name);
    throw new HttpError(409, clash ? (await clashMessage("page_tags", clash)) : "Diesen Tag gibt es schon.");
  }
  return tagId;
}
// tag.save: { workspaceId, tagId?, name, color?, spaceId? } – the same
// rules as the command (pagePropertiesCommand) in one transaction.
export async function saveTag(user: Identity, input: unknown): Promise<{ ok: true; id: string }> {
  const b = z
    .object({ workspaceId: uuid, tagId: uuid.optional(), name: z.string().max(1000), color: colorSchema.optional(), spaceId: uuid.nullable().optional() })
    .parse(input);
  return db.tx(async () => {
    await requireMember(user, b.workspaceId, "editor");
    const name = cleanTagName(b.name);
    if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
    if (!b.tagId) {
      const spaceId = b.spaceId ?? null;
      if (spaceId) await scopeSpace(b.workspaceId, spaceId);
      if (spaceId && !(await canCreateTags(user, b.workspaceId, spaceId))) throw new HttpError(403, "Keine Schreibrechte in diesem Bereich.");
      const clash = await tagClash(b.workspaceId, spaceId, name);
      if (clash) throw new HttpError(409, await clashMessage("page_tags", clash));
      if (!(await canCreateTags(user, b.workspaceId, spaceId)))
        throw new HttpError(403, spaceId ? "Keine Schreibrechte in diesem Bereich." : "Tags für den ganzen Arbeitsbereich legen nur Eigentümer an.");
      const tagId = await createTag(user, b.workspaceId, spaceId, name, b.color);
      await syncTagFieldOptionsAsync(b.workspaceId);
      await auditAsync(user.id, "tag.create", tagId, `${name}${spaceId ? ` (${spaceId})` : ""}`);
      return { ok: true as const, id: tagId };
    }
    const before = await db.one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", b.tagId, b.workspaceId);
    if (!before) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
    await requireManage(user, b.workspaceId, before.space_id);
    const clash = await tagClash(b.workspaceId, before.space_id, name, b.tagId);
    if (clash) throw new HttpError(409, `${await clashMessage("page_tags", clash)} Zum Zusammenführen „Zusammenführen“ wählen.`);
    await db.run("UPDATE page_tags SET name=?,color=COALESCE(?,color) WHERE id=?", name, b.color ?? null, b.tagId);
    // Still synchronous (records of tag-backed properties): on Postgres it
    // refuses inside this transaction once it has records to rewrite.
    if (before.name !== name) await rewriteTagValues(user, b.workspaceId, before.name, name, before.space_id);
    await syncTagFieldOptionsAsync(b.workspaceId);
    await auditAsync(user.id, "tag.save", b.tagId, name);
    return { ok: true as const, id: b.tagId };
  });
}
