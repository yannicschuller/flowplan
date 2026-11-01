// Tags and custom properties of pages (issue #70), server side: storage,
// permissions, the commands, the search filter and the portable form that
// templates, copies, archives and Markdown carry (lib/page-properties.ts has
// the shared part).
//
// Permissions: whoever may edit a page sets its tags and values; members
// with edit rights (not guests, not read tokens) may create a new tag while
// tagging; only workspace owners rename, recolour, merge, reorder and delete
// tags and add, change or delete property definitions. Values are read with
// the page (pageData) – private pages stay private. Pages of end-to-end
// encrypted spaces carry neither tags nor values (the server would read
// them): the commands are refused there (lib/e2ee-server.ts).
import { z } from "zod";
import { HttpError } from "./auth";
import { all, audit, id, one, run } from "./db";
import { isEncryptedPage } from "./e2ee-server";
import { isGuest, memberRole, pageRole, requireMember, requirePage } from "./permissions";
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
  type WorkspaceTaxonomy,
} from "./page-properties";
import type { Identity, Page } from "./types";

type TagRow = { id: string; workspace_id: string; name: string; color: string; position: number };
type DefRow = { id: string; workspace_id: string; name: string; type: string; options: string; position: number };

const asTag = (t: TagRow): PageTag => ({
  id: t.id,
  name: t.name,
  color: (PAGE_TAG_COLORS as readonly string[]).includes(t.color) ? (t.color as PageTagColor) : "gray",
  position: t.position,
});
const asDef = (d: DefRow): PagePropertyDef => ({
  id: d.id,
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

export function workspaceTags(workspaceId: string): PageTag[] {
  return all<TagRow>("SELECT * FROM page_tags WHERE workspace_id=? ORDER BY position,name COLLATE NOCASE", workspaceId).map(asTag);
}
export function workspaceProperties(workspaceId: string): PagePropertyDef[] {
  return all<DefRow>("SELECT * FROM page_property_defs WHERE workspace_id=? ORDER BY position,name COLLATE NOCASE", workspaceId).map(asDef);
}

// ---- Who may do what ----

export function canManageTaxonomy(user: Identity, workspaceId: string) {
  return memberRole(user, workspaceId) === "owner" && !isGuest(user, workspaceId) && user.apiScope !== "read";
}
export function canCreateTags(user: Identity, workspaceId: string) {
  const role = memberRole(user, workspaceId);
  return !!role && role !== "viewer" && !isGuest(user, workspaceId) && user.apiScope !== "read";
}
function requireManage(user: Identity, workspaceId: string) {
  requireMember(user, workspaceId, "owner");
  if (!canManageTaxonomy(user, workspaceId))
    throw new HttpError(403, "Tags und Eigenschaften verwalten nur Eigentümer des Arbeitsbereichs.");
}

// ---- Reading ----

// The definitions and the tags of the visible pages for the bootstrap.
// Guests learn only the tags and properties used on pages shared with them.
export function workspaceTaxonomy(user: Identity, workspaceId: string, visiblePages: Pick<Page, "id" | "space_id">[]): WorkspaceTaxonomy {
  const visible = visiblePages.filter((p) => !isEncryptedPage(p));
  const ids = new Set(visible.map((p) => p.id));
  const links: Record<string, string[]> = {};
  for (const link of all<{ page_id: string; tag_id: string }>(
    "SELECT l.page_id,l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE t.workspace_id=? ORDER BY l.position,t.position",
    workspaceId,
  ))
    if (ids.has(link.page_id)) (links[link.page_id] ||= []).push(link.tag_id);
  let tags = workspaceTags(workspaceId),
    properties = workspaceProperties(workspaceId);
  if (isGuest(user, workspaceId)) {
    const used = new Set(Object.values(links).flat());
    tags = tags.filter((t) => used.has(t.id));
    const valued = new Set(
      all<{ page_id: string; property_id: string }>(
        "SELECT v.page_id,v.property_id FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE d.workspace_id=?",
        workspaceId,
      )
        .filter((v) => ids.has(v.page_id))
        .map((v) => v.property_id),
    );
    properties = properties.filter((p) => valued.has(p.id));
  }
  return { tags, properties, links, manage: canManageTaxonomy(user, workspaceId), createTags: canCreateTags(user, workspaceId) };
}

function storedValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export function pageInfo(pageId: string): PageInfo {
  const page = one<{ created_at: string | null; created_by: string | null; updated_at: string | null }>(
    // Pages from before schema 82 have no created_at: their first version
    // or, without one, their last change.
    "SELECT COALESCE(created_at,(SELECT MIN(s.created_at) FROM snapshots s WHERE s.page_id=pages.id),updated_at) created_at,created_by,updated_at FROM pages WHERE id=?",
    pageId,
  );
  const editor = one<{ user_id: string }>("SELECT user_id FROM page_edits WHERE page_id=? ORDER BY at DESC LIMIT 1", pageId);
  return {
    createdAt: page?.created_at ?? null,
    createdBy: page?.created_by ?? null,
    updatedAt: page?.updated_at ?? null,
    updatedBy: editor?.user_id ?? page?.created_by ?? null,
  };
}
// The tags and values of a page (no permission check: the caller read it).
export function pageMeta(pageId: string): PageMeta {
  return {
    tags: all<{ tag_id: string }>(
      "SELECT l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
      pageId,
    ).map((l) => l.tag_id),
    values: Object.fromEntries(
      all<{ property_id: string; value: string }>("SELECT property_id,value FROM page_property_values WHERE page_id=?", pageId).map((v) => [
        v.property_id,
        storedValue(v.value),
      ]),
    ),
    info: pageInfo(pageId),
  };
}
// What pageData hands out; nothing for encrypted pages.
export function pageMetaFor(page: Pick<Page, "id" | "space_id">): PageMeta | undefined {
  return isEncryptedPage(page) ? undefined : pageMeta(page.id);
}

// ---- Values ----

// A value for a definition as stored, or null for "no value" (removed).
export function parsePropertyValue(def: PagePropertyDef, value: unknown, workspaceId: string): unknown {
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
      if (!one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", workspaceId, String(value)))
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

// An existing tag by id or name.
function findTag(workspaceId: string, ref: string): string | undefined {
  return one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND (id=? OR name=? COLLATE NOCASE)", workspaceId, ref, cleanTagName(ref))?.id;
}
// A tag by id or name; a new name creates the tag when the person may.
function resolveTag(user: Identity | null, workspaceId: string, ref: string, color?: string): string | null {
  const byId = one<{ id: string }>("SELECT id FROM page_tags WHERE id=? AND workspace_id=?", ref, workspaceId);
  if (byId) return byId.id;
  const name = cleanTagName(ref);
  if (!name) return null;
  const byName = one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=? COLLATE NOCASE", workspaceId, name);
  if (byName) return byName.id;
  if (user && !canCreateTags(user, workspaceId)) throw new HttpError(403, "Neue Tags legen nur Mitglieder mit Bearbeitungsrechten an.");
  if ((one<{ n: number }>("SELECT COUNT(*) n FROM page_tags WHERE workspace_id=?", workspaceId)?.n ?? 0) >= MAX_TAGS)
    throw new HttpError(400, "Höchstens 1000 Tags je Arbeitsbereich.");
  const tagId = id();
  run(
    "INSERT INTO page_tags(id,workspace_id,name,color,position,created_by,created_at) VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_tags WHERE workspace_id=?),?,?)",
    tagId,
    workspaceId,
    name,
    color ? tagColorFrom(color) : autoColor(workspaceId),
    workspaceId,
    user?.id ?? null,
    Date.now(),
  );
  return tagId;
}
// New tags take the colours in turn, so neighbours differ.
function autoColor(workspaceId: string): PageTagColor {
  const count = one<{ n: number }>("SELECT COUNT(*) n FROM page_tags WHERE workspace_id=?", workspaceId)?.n ?? 0;
  const palette = PAGE_TAG_COLORS.filter((c) => c !== "gray");
  return palette[count % palette.length];
}

function setPageTags(user: Identity | null, page: Pick<Page, "id" | "workspace_id">, refs: string[]) {
  const ids: string[] = [];
  for (const ref of refs) {
    const tagId = resolveTag(user, page.workspace_id, ref);
    if (tagId && !ids.includes(tagId)) ids.push(tagId);
  }
  if (ids.length > MAX_TAGS_PER_PAGE) throw new HttpError(400, "Höchstens 50 Tags je Seite.");
  run(`DELETE FROM page_tag_links WHERE page_id=? AND tag_id NOT IN (SELECT value FROM json_each(?))`, page.id, JSON.stringify(ids));
  ids.forEach((tagId, i) =>
    run("INSERT INTO page_tag_links(page_id,tag_id,position) VALUES(?,?,?) ON CONFLICT(page_id,tag_id) DO UPDATE SET position=excluded.position", page.id, tagId, i),
  );
  return ids;
}
function setPageValue(pageId: string, propertyId: string, value: unknown) {
  if (value === null || isEmptyValue(value)) run("DELETE FROM page_property_values WHERE page_id=? AND property_id=?", pageId, propertyId);
  else
    run(
      "INSERT INTO page_property_values(page_id,property_id,value) VALUES(?,?,?) ON CONFLICT(page_id,property_id) DO UPDATE SET value=excluded.value",
      pageId,
      propertyId,
      JSON.stringify(value),
    );
}

// ---- Commands ----

const uuid = z.string().uuid();
const tagRefs = z.array(z.string().min(1).max(200)).max(200);
const colorSchema = z.enum(PAGE_TAG_COLORS);
const optionsSchema = z.array(z.string().max(1000)).max(MAX_OPTIONS * 2);

export const PAGE_PROPERTY_ACTIONS = [
  "page.properties",
  "pages.tag",
  "tag.save",
  "tag.delete",
  "tag.merge",
  "tag.reorder",
  "property.save",
  "property.delete",
  "property.reorder",
] as const;

function cleanOptions(list: string[]) {
  const out: string[] = [];
  for (const raw of list) {
    const option = cleanName(raw, MAX_OPTION_LENGTH);
    if (option && !out.some((o) => foldName(o) === foldName(option))) out.push(option);
  }
  if (out.length > MAX_OPTIONS) throw new HttpError(400, "Höchstens 100 Optionen.");
  return out;
}
function touch(pageId: string) {
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
}
// The page's tags and values after a change (the command's answer).
const metaAnswer = (pageId: string) => {
  const meta = pageMeta(pageId);
  return { ok: true, tags: meta.tags, values: meta.values };
};

// `write` is the command's page check (editor rights, journal PIN, lock).
export function pagePropertiesCommand(user: Identity, action: string, input: Record<string, unknown>, write: () => Page): unknown {
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
      const page = write();
      if (isEncryptedPage(page)) throw new HttpError(409, "Seiten verschlüsselter Bereiche haben keine Tags und Eigenschaften.");
      if (b.tags || b.addTags || b.removeTags) {
        const ids = setPageTags(user, page, [...(b.tags ?? pageMeta(page.id).tags), ...(b.addTags || [])]);
        const removed = new Set((b.removeTags || []).map((ref) => findTag(page.workspace_id, ref)));
        if (ids.some((tagId) => removed.has(tagId))) setPageTags(user, page, ids.filter((tagId) => !removed.has(tagId)));
      }
      if (b.values) {
        const defs = workspaceProperties(page.workspace_id);
        for (const [key, value] of Object.entries(b.values)) {
          const def = defs.find((d) => d.id === key) ?? defs.find((d) => foldName(d.name) === foldName(key));
          if (!def) throw new HttpError(400, "Unbekannte Eigenschaft.");
          setPageValue(page.id, def.id, parsePropertyValue(def, value, page.workspace_id));
        }
      }
      touch(page.id);
      return metaAnswer(page.id);
    }
    // Several pages at once: { workspaceId, pageIds, addTags?, removeTags? }.
    case "pages.tag": {
      const b = z.object({ workspaceId: uuid, pageIds: z.array(uuid).min(1).max(500), addTags: tagRefs.optional(), removeTags: tagRefs.optional() }).parse(input);
      requireMember(user, b.workspaceId);
      const pages = b.pageIds.map((pid) => requirePage(user, pid, true));
      if (pages.some((p) => p.workspace_id !== b.workspaceId)) throw new HttpError(400, "Seiten aus einem anderen Arbeitsbereich.");
      if (pages.some((p) => p.locked)) throw new HttpError(409, "Diese Seite ist gesperrt.");
      for (const page of pages) {
        if (isEncryptedPage(page)) continue;
        const current = pageMeta(page.id).tags;
        const removed = new Set((b.removeTags || []).map((ref) => findTag(page.workspace_id, ref)));
        setPageTags(user, page, [...current.filter((t) => !removed.has(t)), ...(b.addTags || [])]);
        touch(page.id);
      }
      return { ok: true, pages: pages.length };
    }
    // { workspaceId, tagId?, name, color? } – a new tag (editors) or a
    // changed one (owners).
    case "tag.save": {
      const b = z.object({ workspaceId: uuid, tagId: uuid.optional(), name: z.string().max(1000), color: colorSchema.optional() }).parse(input);
      requireMember(user, b.workspaceId, "editor");
      const name = cleanTagName(b.name);
      if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
      const clash = one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=? COLLATE NOCASE", b.workspaceId, name);
      if (!b.tagId) {
        if (clash) throw new HttpError(409, "Diesen Tag gibt es schon.");
        const tagId = resolveTag(user, b.workspaceId, name);
        if (b.color) run("UPDATE page_tags SET color=? WHERE id=?", b.color, tagId);
        return { ok: true, id: tagId };
      }
      requireManage(user, b.workspaceId);
      if (!one("SELECT 1 FROM page_tags WHERE id=? AND workspace_id=?", b.tagId, b.workspaceId)) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      if (clash && clash.id !== b.tagId) throw new HttpError(409, "Diesen Tag gibt es schon. Zum Zusammenführen „Zusammenführen“ wählen.");
      run("UPDATE page_tags SET name=?,color=COALESCE(?,color) WHERE id=?", name, b.color ?? null, b.tagId);
      audit(user.id, "tag.save", b.tagId, name);
      return { ok: true, id: b.tagId };
    }
    case "tag.delete": {
      const b = z.object({ workspaceId: uuid, tagId: uuid }).parse(input);
      requireManage(user, b.workspaceId);
      const tag = one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", b.tagId, b.workspaceId);
      if (!tag) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      run("DELETE FROM page_tags WHERE id=?", tag.id);
      audit(user.id, "tag.delete", tag.id, tag.name);
      return { ok: true };
    }
    // { workspaceId, tagId, into }: pages with tagId get `into`, tagId goes.
    case "tag.merge": {
      const b = z.object({ workspaceId: uuid, tagId: uuid, into: uuid }).parse(input);
      requireManage(user, b.workspaceId);
      if (b.tagId === b.into) throw new HttpError(400, "Einen Tag mit sich selbst zusammenführen geht nicht.");
      const [from, into] = [b.tagId, b.into].map((tid) => one<TagRow>("SELECT * FROM page_tags WHERE id=? AND workspace_id=?", tid, b.workspaceId));
      if (!from || !into) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
      run(
        "INSERT INTO page_tag_links(page_id,tag_id,position) SELECT page_id,?,position FROM page_tag_links WHERE tag_id=? ON CONFLICT(page_id,tag_id) DO NOTHING",
        into.id,
        from.id,
      );
      run("DELETE FROM page_tags WHERE id=?", from.id);
      audit(user.id, "tag.merge", into.id, `${from.name} → ${into.name}`);
      return { ok: true };
    }
    case "tag.reorder":
    case "property.reorder": {
      const b = z.object({ workspaceId: uuid, order: z.array(uuid).max(MAX_TAGS) }).parse(input);
      requireManage(user, b.workspaceId);
      const table = action === "tag.reorder" ? "page_tags" : "page_property_defs";
      b.order.forEach((itemId, i) => run(`UPDATE ${table} SET position=? WHERE id=? AND workspace_id=?`, i + 1, itemId, b.workspaceId));
      return { ok: true };
    }
    // { workspaceId, propertyId?, name, type, options? }
    case "property.save": {
      const b = z
        .object({ workspaceId: uuid, propertyId: uuid.optional(), name: z.string().max(1000), type: z.enum(PAGE_PROPERTY_TYPES).optional(), options: optionsSchema.optional() })
        .parse(input);
      requireManage(user, b.workspaceId);
      const name = cleanName(b.name, MAX_PROPERTY_NAME);
      if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
      const clash = one<{ id: string }>("SELECT id FROM page_property_defs WHERE workspace_id=? AND name=? COLLATE NOCASE", b.workspaceId, name);
      if (clash && clash.id !== b.propertyId) throw new HttpError(409, "Eine Eigenschaft mit diesem Namen gibt es schon.");
      if (!b.propertyId) {
        if (!b.type) throw new HttpError(400, "Bitte einen Typ wählen.");
        if ((one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", b.workspaceId)?.n ?? 0) >= MAX_PROPERTIES)
          throw new HttpError(400, "Höchstens 100 Eigenschaften je Arbeitsbereich.");
        const propertyId = id();
        run(
          "INSERT INTO page_property_defs(id,workspace_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
          propertyId,
          b.workspaceId,
          name,
          b.type,
          JSON.stringify(["select", "multiselect"].includes(b.type) ? cleanOptions(b.options || []) : []),
          b.workspaceId,
          user.id,
          Date.now(),
        );
        audit(user.id, "property.save", propertyId, name);
        return { ok: true, id: propertyId };
      }
      const stored = one<DefRow>("SELECT * FROM page_property_defs WHERE id=? AND workspace_id=?", b.propertyId, b.workspaceId);
      if (!stored) throw new HttpError(404, "Eigenschaft nicht gefunden.");
      const before = asDef(stored);
      const type = b.type ?? before.type;
      const next: PagePropertyDef = {
        ...before,
        name,
        type,
        options: ["select", "multiselect"].includes(type) ? cleanOptions(b.options ?? before.options) : [],
      };
      run("UPDATE page_property_defs SET name=?,type=?,options=? WHERE id=?", next.name, next.type, JSON.stringify(next.options), next.id);
      // Values that no longer fit (another type, a removed option) are
      // converted where possible, else removed.
      if (type !== before.type || JSON.stringify(next.options) !== JSON.stringify(before.options))
        for (const v of all<{ page_id: string; value: string }>("SELECT page_id,value FROM page_property_values WHERE property_id=?", next.id)) {
          let value: unknown = null;
          if (!isComputedProperty(type))
            try {
              value = parsePropertyValue(next, convertValue(before, next, storedValue(v.value)), b.workspaceId);
            } catch {
              value = null;
            }
          setPageValue(v.page_id, next.id, value);
        }
      audit(user.id, "property.save", next.id, name);
      return { ok: true, id: next.id };
    }
    case "property.delete": {
      const b = z.object({ workspaceId: uuid, propertyId: uuid }).parse(input);
      requireManage(user, b.workspaceId);
      const stored = one<DefRow>("SELECT * FROM page_property_defs WHERE id=? AND workspace_id=?", b.propertyId, b.workspaceId);
      if (!stored) throw new HttpError(404, "Eigenschaft nicht gefunden.");
      run("DELETE FROM page_property_defs WHERE id=?", stored.id);
      audit(user.id, "property.delete", stored.id, stored.name);
      return { ok: true };
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}
// A value of one type as the next type would take it (text ↔ select …).
function convertValue(from: PagePropertyDef, to: PagePropertyDef, value: unknown): unknown {
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
export function pageMetaSearchText(pageId: string): string {
  const tags = all<{ name: string }>(
    "SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position",
    pageId,
  ).map((t) => `#${t.name}`);
  const values = all<DefRow & { value: string }>(
    "SELECT d.*,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=?",
    pageId,
  )
    .filter((v) => !["person", "checkbox"].includes(v.type))
    .map((v) => propertyText(asDef(v), storedValue(v.value)))
    .filter(Boolean);
  return [...tags, ...values].join(" · ");
}

// The pages of a workspace that pass the tag and property tokens of a
// search; null without tokens. Reading rights are checked by the search.
export function filteredPageIds(user: Identity, workspaceId: string, parsed: Pick<ParsedQuery, "tags" | "properties">): Set<string> | null {
  if (!parsed.tags.length && !parsed.properties.length) return null;
  let ids = new Set(
    all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0", workspaceId).map((p) => p.id),
  );
  const keep = (next: Set<string>) => {
    ids = new Set([...ids].filter((pid) => next.has(pid)));
  };
  for (const filter of parsed.tags) {
    const tagged = new Set(all<{ page_id: string }>("SELECT page_id FROM page_tag_links WHERE tag_id=?", filter.tagId).map((l) => l.page_id));
    ids = new Set([...ids].filter((pid) => tagged.has(pid) !== filter.exclude));
  }
  if (parsed.properties.length) {
    const defs = new Map(workspaceProperties(workspaceId).map((d) => [d.id, d]));
    const names = new Map(all<{ id: string; name: string }>("SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?", workspaceId).map((u) => [u.id, u.name]));
    const people = (uid: string) => names.get(uid);
    for (const filter of parsed.properties) {
      const def = defs.get(filter.propertyId);
      if (!def) continue;
      if (isComputedProperty(def.type)) {
        const passing = new Set<string>();
        for (const pid of ids) {
          const info = pageInfo(pid);
          const value = { created_at: info.createdAt, updated_at: info.updatedAt, created_by: info.createdBy, updated_by: info.updatedBy }[def.type as "created_at"];
          if (matchesPropertyFilter(def, value, filter, people, user.id)) passing.add(pid);
        }
        keep(passing);
        continue;
      }
      const values = new Map(
        all<{ page_id: string; value: string }>("SELECT page_id,value FROM page_property_values WHERE property_id=?", def.id).map((v) => [v.page_id, storedValue(v.value)]),
      );
      keep(new Set([...ids].filter((pid) => matchesPropertyFilter(def, values.get(pid), filter, people, user.id))));
    }
  }
  return ids;
}

// ---- Portable form (templates, copies, archives, Markdown) ----

export function portableMeta(pageId: string): PortableMeta | undefined {
  const tags = all<TagRow>(
    "SELECT t.* FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
    pageId,
  ).map((t) => ({ name: t.name, color: t.color }));
  const properties = all<DefRow & { value: string }>(
    "SELECT d.*,v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=? ORDER BY d.position",
    pageId,
  ).map((v) => {
    const def = asDef(v);
    return { name: def.name, type: def.type, ...(def.options.length ? { options: def.options } : {}), value: storedValue(v.value) };
  });
  return tags.length || properties.length ? { ...(tags.length ? { tags } : {}), ...(properties.length ? { properties } : {}) } : undefined;
}
export const portableMetaSchema = z
  .object({
    tags: z.array(z.object({ name: z.string().max(1000), color: z.string().max(100).optional() })).max(200).optional(),
    properties: z
      .array(z.object({ name: z.string().max(1000), type: z.enum(PAGE_PROPERTY_TYPES), options: z.array(z.string().max(1000)).max(500).optional(), value: z.unknown() }))
      .max(200)
      .optional(),
  })
  .optional();

// Puts tags and values by name onto a page. Tags missing in the workspace
// are created (when `user` may, or always for `user` null: imports run with
// the checks of their own command). Definitions missing are created only
// with `createDefinitions` (archives and imports of workspace owners);
// values that do not fit are skipped, never fail the whole operation.
export function applyPortableMeta(
  user: Identity | null,
  page: Pick<Page, "id" | "workspace_id" | "space_id">,
  meta: PortableMeta | undefined,
  options: { createDefinitions?: boolean; createTags?: boolean } = {},
) {
  if (!meta || isEncryptedPage(page)) return;
  const mayCreateTags = options.createTags ?? (user ? canCreateTags(user, page.workspace_id) : true);
  const tagIds: string[] = [...pageMeta(page.id).tags];
  for (const tag of meta.tags || []) {
    const name = cleanTagName(tag.name);
    if (!name) continue;
    const known = one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=? COLLATE NOCASE", page.workspace_id, name);
    let tagId = known?.id ?? null;
    if (!tagId && mayCreateTags)
      try {
        tagId = resolveTag(null, page.workspace_id, name, tag.color);
      } catch {
        tagId = null;
      }
    if (tagId && !tagIds.includes(tagId)) tagIds.push(tagId);
  }
  if (tagIds.length) setPageTags(null, page, tagIds.slice(0, MAX_TAGS_PER_PAGE));
  for (const property of meta.properties || []) {
    if (isComputedProperty(property.type)) continue;
    const name = cleanName(property.name, MAX_PROPERTY_NAME);
    if (!name) continue;
    let stored = one<DefRow>("SELECT * FROM page_property_defs WHERE workspace_id=? AND name=? COLLATE NOCASE", page.workspace_id, name);
    if (!stored && options.createDefinitions) {
      if ((one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", page.workspace_id)?.n ?? 0) >= MAX_PROPERTIES) continue;
      const propertyId = id();
      run(
        "INSERT INTO page_property_defs(id,workspace_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
        propertyId,
        page.workspace_id,
        name,
        property.type,
        "[]",
        page.workspace_id,
        user?.id ?? null,
        Date.now(),
      );
      stored = one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", propertyId);
    }
    if (!stored) continue;
    let def = asDef(stored);
    // Options a value needs are added when definitions may be created.
    if (options.createDefinitions && ["select", "multiselect"].includes(def.type)) {
      const wanted = [...(property.options || []), ...(Array.isArray(property.value) ? property.value : [property.value])].filter(
        (v): v is string => typeof v === "string" && !!v.trim(),
      );
      const merged = cleanOptions([...def.options, ...wanted].slice(0, MAX_OPTIONS));
      if (merged.length !== def.options.length) {
        run("UPDATE page_property_defs SET options=? WHERE id=?", JSON.stringify(merged), def.id);
        def = { ...def, options: merged };
      }
    }
    try {
      const value = parsePropertyValue(def, convertValue({ ...def, type: property.type }, def, property.value), page.workspace_id);
      if (value !== null) setPageValue(page.id, def.id, value);
    } catch {
      // A value that does not fit this workspace is left out.
    }
  }
}

// Duplicates, templates: the copy gets the source's tags and values. In the
// same workspace by id; elsewhere by name (tags created when allowed,
// definitions only where they exist).
export function copyPageMeta(user: Identity, fromPageId: string, to: Pick<Page, "id" | "workspace_id" | "space_id">) {
  const from = one<Page>("SELECT * FROM pages WHERE id=?", fromPageId);
  if (!from || isEncryptedPage(from) || isEncryptedPage(to)) return;
  if (from.workspace_id === to.workspace_id) {
    run("INSERT OR IGNORE INTO page_tag_links(page_id,tag_id,position) SELECT ?,tag_id,position FROM page_tag_links WHERE page_id=?", to.id, from.id);
    run("INSERT OR IGNORE INTO page_property_values(page_id,property_id,value) SELECT ?,property_id,value FROM page_property_values WHERE page_id=?", to.id, from.id);
    return;
  }
  applyPortableMeta(user, to, portableMeta(from.id));
}

// ---- Frontmatter (Markdown export and import) ----

// Keys of a page's frontmatter: `tags` (as Obsidian reads them) and each
// property by its name; dates as YYYY-MM-DD…, people by name.
export function metaFrontmatter(pageId: string, people: (id: string) => string | undefined): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  const tags = all<{ name: string }>(
    "SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY l.position,t.position",
    pageId,
  ).map((t) => t.name);
  if (tags.length) out.tags = tags;
  for (const v of all<DefRow & { value: string }>(
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
export function frontmatterMeta(
  data: Record<string, unknown>,
  workspaceId: string,
  people: (name: string) => string | undefined,
  options: { createDefinitions?: boolean } = {},
): { meta: PortableMeta; consumed: string[] } {
  const meta: PortableMeta = { tags: [], properties: [] },
    consumed: string[] = [];
  const defs = workspaceProperties(workspaceId);
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

// GET /api/tags: the workspace's tags with how many readable pages carry
// each, the property definitions and – with `tagId` – those pages.
export function tagListing(user: Identity, workspaceId: string, tagId?: string) {
  requireMember(user, workspaceId);
  const locked = lockedPageIds(user, workspaceId);
  const pages = all<Page>("SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 ORDER BY updated_at DESC", workspaceId).filter(
    (p) => !locked.has(p.id) && !isEncryptedPage(p) && !!pageRole(user, p),
  );
  const taxonomy = workspaceTaxonomy(user, workspaceId, pages);
  const counts = new Map<string, number>();
  for (const ids of Object.values(taxonomy.links)) for (const t of ids) counts.set(t, (counts.get(t) || 0) + 1);
  if (tagId && !taxonomy.tags.some((t) => t.id === tagId)) throw new HttpError(404, "Schlagwort (Tag) nicht gefunden.");
  return {
    tags: taxonomy.tags.map((t) => ({ ...t, pages: counts.get(t.id) || 0 })),
    properties: taxonomy.properties,
    ...(tagId
      ? {
          pages: pages
            .filter((p) => taxonomy.links[p.id]?.includes(tagId))
            .map((p) => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, space_id: p.space_id, parent_id: p.parent_id, updated_at: p.updated_at, tags: taxonomy.links[p.id] })),
        }
      : {}),
  };
}

// Members by name (frontmatter names people).
export function memberByName(workspaceId: string) {
  const members = all<{ id: string; name: string }>("SELECT u.id,u.name FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?", workspaceId);
  return (name: string) => members.find((m) => foldName(m.name) === foldName(name))?.id;
}

// Git export: a file changed in the repository brings its tags and values
// back – they replace the page's (as its aliases do). True when they changed.
export function syncMetaFromFrontmatter(user: Identity, page: Page, data: Record<string, unknown>): boolean {
  if (isEncryptedPage(page)) return false;
  const before = JSON.stringify(portableMeta(page.id) ?? {});
  const { meta } = frontmatterMeta(data, page.workspace_id, memberByName(page.workspace_id));
  run("DELETE FROM page_tag_links WHERE page_id=?", page.id);
  run("DELETE FROM page_property_values WHERE page_id=?", page.id);
  applyPortableMeta(user, page, meta);
  const changed = before !== JSON.stringify(portableMeta(page.id) ?? {});
  if (changed) touch(page.id);
  return changed;
}

// Archives: the workspace's tags and definitions by name; existing names
// are kept as they are.
export function importTaxonomy(
  user: Identity,
  workspaceId: string,
  taxonomy: { tags: { name: string; color?: string }[]; properties: { name: string; type: PagePropertyType; options?: string[] }[] } | undefined,
  createDefinitions: boolean,
) {
  if (!taxonomy) return;
  if (canCreateTags(user, workspaceId))
    for (const tag of taxonomy.tags)
      try {
        resolveTag(null, workspaceId, tag.name, tag.color);
      } catch {
        break;
      }
  if (!createDefinitions) return;
  for (const property of taxonomy.properties) {
    const name = cleanName(property.name, MAX_PROPERTY_NAME);
    if (!name || one("SELECT 1 FROM page_property_defs WHERE workspace_id=? AND name=? COLLATE NOCASE", workspaceId, name)) continue;
    if ((one<{ n: number }>("SELECT COUNT(*) n FROM page_property_defs WHERE workspace_id=?", workspaceId)?.n ?? 0) >= MAX_PROPERTIES) break;
    run(
      "INSERT INTO page_property_defs(id,workspace_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
      id(),
      workspaceId,
      name,
      property.type,
      JSON.stringify(["select", "multiselect"].includes(property.type) ? cleanOptions(property.options || []) : []),
      workspaceId,
      user.id,
      Date.now(),
    );
  }
}
