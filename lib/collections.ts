// Collections (issue #86): saved queries in the search language
// (lib/collection-query.ts) shown in the sidebar, whose results are worked
// out anew each time they are opened – pages and database records that
// match now, as the person opening it may read them.
//
// A collection belongs to the person who made it and is private; shared
// with the workspace, every member (not guests) sees it in the sidebar's
// "Geteilt" part. Its creator and the workspace's owners change and delete
// it, the others may duplicate it as their own. The results always follow
// the reader's own rights: pages and spaces they may read, no private
// records of others, no hidden properties, no journals behind a PIN, nothing
// in the trash. End-to-end encrypted spaces stay out (the server cannot read
// them); the results say so. Personal saved searches (before #86) became
// collections with schema 85 (lib/db.ts); search.save and search.delete
// still work on them.
//
// Tables: collections (the queries; deleted_at while in the trash, for
// "Rückgängig", purged after COLLECTION_TRASH_DAYS) and collection_order (each
// person's order in the sidebar).
import { z } from "zod";
import { HttpError } from "./auth";
import { all, audit, id, one, run } from "./db";
import { refreshSearchIndex } from "./search-index";
import { isEncryptedPage } from "./e2ee-server";
import { hiddenFieldsFor } from "./field-access";
import { lockedPageIds } from "./journal-extras";
import { isGuest, memberRole, pageRole, requireMember, spaceRole } from "./permissions";
import { rowRoleResolver } from "./row-access";
import { cellText } from "./cell-text";
import {
  conditions,
  dateRange,
  inDateRange,
  isRelativeDate,
  isGroup,
  itemTypeOf,
  normalizeQuery,
  parseQuery,
  possibleTypes,
  type Cond,
  type ItemType,
  type QueryNode,
} from "./collection-query";
import { foldName, isComputedProperty, isTagField, matchesPropertyFilter, propertyFilter, type PagePropertyDef, type PagePropertyType } from "./page-properties";
import { workspaceProperties, workspaceTags } from "./page-properties-server";
import { inScope } from "./page-properties";
import type { Field, Identity, Page, Space } from "./types";

export const MAX_COLLECTIONS = 100,
  MAX_SHARED_COLLECTIONS = 100,
  // Results of one collection (newest change first).
  COLLECTION_RESULTS = 500,
  COLLECTION_TRASH_DAYS = 30;

export type CollectionInfo = {
  id: string;
  name: string;
  icon: string;
  query: string;
  shared: boolean;
  // Made by the reader.
  mine: boolean;
  // May change and delete it.
  canEdit: boolean;
  ownerName: string;
};
export type CollectionItem = {
  pageId: string;
  rowId?: string;
  type: ItemType;
  title: string;
  icon: string;
  spaceId: string;
  // A record's database.
  database?: string;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  creatorName: string;
  // A journal's day.
  journalDate?: string;
};
export type CollectionResults = {
  items: CollectionItem[];
  total: number;
  truncated: boolean;
  // Spaces the reader may read but the server cannot search.
  encryptedLeftOut: boolean;
};

type Row = { id: string; workspace_id: string; owner_id: string; name: string; icon: string; query: string; shared: number; deleted_at: number | null };

// ---- Reading ----

// `owner`: the reader is an owner of the workspace (not a guest).
function canEditRow(user: Identity, c: Row, owner = memberRole(user, c.workspace_id) === "owner" && !isGuest(user, c.workspace_id)) {
  if (user.apiScope === "read") return false;
  if (c.owner_id === user.id) return true;
  return !!c.shared && owner;
}
function canSee(user: Identity, c: Row) {
  if (c.owner_id === user.id) return !!memberRole(user, c.workspace_id);
  return !!c.shared && !!memberRole(user, c.workspace_id) && !isGuest(user, c.workspace_id);
}
const info = (user: Identity, c: Row & { owner_name: string | null }, owner?: boolean): CollectionInfo => ({
  id: c.id,
  name: c.name,
  icon: c.icon,
  query: c.query,
  shared: !!c.shared,
  mine: c.owner_id === user.id,
  canEdit: canEditRow(user, c, owner),
  ownerName: c.owner_name ?? "",
});

// The collections a person sees in a workspace: their own and the shared
// ones (not for guests), in their order.
export function listCollections(user: Identity, workspaceId: string): CollectionInfo[] {
  const role = memberRole(user, workspaceId);
  if (!role) return [];
  run("DELETE FROM collections WHERE deleted_at IS NOT NULL AND deleted_at<?", Date.now() - COLLECTION_TRASH_DAYS * 86_400_000);
  const guest = isGuest(user, workspaceId);
  const owner = role === "owner" && !guest;
  return all<Row & { owner_name: string | null }>(
    `SELECT c.*,u.name owner_name FROM collections c LEFT JOIN users u ON u.id=c.owner_id
     LEFT JOIN collection_order o ON o.collection_id=c.id AND o.user_id=?
     WHERE c.workspace_id=? AND c.deleted_at IS NULL AND (c.owner_id=?${guest ? "" : " OR c.shared=1"})
     ORDER BY o.position IS NULL,o.position,c.created_at,c.rowid`,
    user.id,
    workspaceId,
    user.id,
  ).map((c) => info(user, c, owner));
}
function requireCollection(user: Identity, collectionId: string, edit = false, deleted = false): Row {
  const c = one<Row>(`SELECT * FROM collections WHERE id=? AND deleted_at IS ${deleted ? "NOT " : ""}NULL`, collectionId);
  if (!c || !canSee(user, c)) throw new HttpError(404, "Sammlung nicht gefunden.");
  if (edit && !canEditRow(user, c))
    throw new HttpError(403, "Diese Sammlung ändern nur die Person, die sie angelegt hat, und Eigentümer des Arbeitsbereichs.");
  return c;
}
export function getCollection(user: Identity, collectionId: string): CollectionInfo {
  const c = requireCollection(user, collectionId);
  return info(user, { ...c, owner_name: one<{ name: string }>("SELECT name FROM users WHERE id=?", c.owner_id)?.name ?? null });
}

// ---- Changing ----

const nameSchema = z.string().trim().min(1).max(120);
const querySchema = z.string().trim().min(1).max(1000);
const iconSchema = z.string().trim().max(16);
function cleanQuery(raw: string) {
  const query = normalizeQuery(querySchema.parse(raw));
  if (!query) throw new HttpError(400, "Die Abfrage der Sammlung ist leer.");
  if (query.length > 1000) throw new HttpError(400, "Die Abfrage der Sammlung ist zu lang.");
  return query;
}
function checkLimits(user: Identity, workspaceId: string, shared: boolean, except?: string) {
  const own = Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM collections WHERE owner_id=? AND workspace_id=? AND deleted_at IS NULL AND id!=?", user.id, workspaceId, except ?? "")?.n || 0,
  );
  if (own >= MAX_COLLECTIONS) throw new HttpError(409, `Höchstens ${MAX_COLLECTIONS} Sammlungen je Person und Arbeitsbereich.`);
  if (!shared) return;
  if (isGuest(user, workspaceId)) throw new HttpError(403, "Gäste können keine Sammlungen teilen.");
  const sharedCount = Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM collections WHERE workspace_id=? AND shared=1 AND deleted_at IS NULL AND id!=?", workspaceId, except ?? "")?.n || 0,
  );
  if (sharedCount >= MAX_SHARED_COLLECTIONS) throw new HttpError(409, `Höchstens ${MAX_SHARED_COLLECTIONS} geteilte Sammlungen je Arbeitsbereich.`);
}
function append(userId: string, collectionId: string, workspaceId: string) {
  const last = one<{ p: number | null }>(
    "SELECT MAX(o.position) p FROM collection_order o JOIN collections c ON c.id=o.collection_id WHERE o.user_id=? AND c.workspace_id=?",
    userId,
    workspaceId,
  )?.p;
  run("INSERT OR REPLACE INTO collection_order(user_id,collection_id,position) VALUES(?,?,?)", userId, collectionId, (last ?? 0) + 1);
}
export function createCollection(user: Identity, raw: unknown) {
  const b = z
    .object({ workspaceId: z.uuid(), name: nameSchema, query: z.string(), icon: iconSchema.optional(), shared: z.boolean().optional() })
    .parse(raw);
  requireMember(user, b.workspaceId);
  const query = cleanQuery(b.query);
  checkLimits(user, b.workspaceId, !!b.shared);
  const cid = id();
  const now = Date.now();
  {
    run(
      "INSERT INTO collections(id,workspace_id,owner_id,name,icon,query,shared,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      cid,
      b.workspaceId,
      user.id,
      b.name,
      b.icon ?? "",
      query,
      b.shared ? 1 : 0,
      now,
      now,
    );
    append(user.id, cid, b.workspaceId);
  }
  if (b.shared) audit(user.id, "collection.share", cid, b.name);
  return { id: cid, query };
}
export function updateCollection(user: Identity, raw: unknown) {
  const b = z
    .object({ collectionId: z.uuid(), name: nameSchema.optional(), query: z.string().optional(), icon: iconSchema.optional(), shared: z.boolean().optional() })
    .parse(raw);
  const c = requireCollection(user, b.collectionId, true);
  const query = b.query === undefined ? c.query : cleanQuery(b.query);
  if (b.shared !== undefined && b.shared !== !!c.shared) {
    // Only its creator shares or unshares a collection.
    if (c.owner_id !== user.id) throw new HttpError(403, "Nur die Person, die die Sammlung angelegt hat, kann sie teilen.");
    if (b.shared) checkLimits(user, c.workspace_id, true, c.id);
    audit(user.id, b.shared ? "collection.share" : "collection.unshare", c.id, c.name);
  }
  run(
    "UPDATE collections SET name=?,icon=?,query=?,shared=?,updated_at=? WHERE id=?",
    b.name ?? c.name,
    b.icon ?? c.icon,
    query,
    (b.shared ?? !!c.shared) ? 1 : 0,
    Date.now(),
    c.id,
  );
  return { id: c.id, query };
}
export function deleteCollection(user: Identity, collectionId: unknown) {
  const c = requireCollection(user, z.uuid().parse(collectionId), true);
  run("UPDATE collections SET deleted_at=? WHERE id=?", Date.now(), c.id);
  return { id: c.id };
}
export function restoreCollection(user: Identity, collectionId: unknown) {
  const c = requireCollection(user, z.uuid().parse(collectionId), true, true);
  checkLimits(user, c.workspace_id, !!c.shared && c.owner_id === user.id, c.id);
  run("UPDATE collections SET deleted_at=NULL WHERE id=?", c.id);
  return { id: c.id };
}
export function duplicateCollection(user: Identity, raw: unknown) {
  const b = z.object({ collectionId: z.uuid(), name: nameSchema.optional() }).parse(raw);
  const c = requireCollection(user, b.collectionId);
  return createCollection(user, { workspaceId: c.workspace_id, name: b.name ?? c.name, query: c.query, icon: c.icon, shared: false });
}
// The person's order of the collections they see.
export function reorderCollections(user: Identity, raw: unknown) {
  const b = z.object({ workspaceId: z.uuid(), order: z.array(z.uuid()).max(MAX_COLLECTIONS + MAX_SHARED_COLLECTIONS + 50) }).parse(raw);
  const visible = new Set(listCollections(user, b.workspaceId).map((c) => c.id));
  // (command() runs this in its transaction.)
  b.order
    .filter((cid) => visible.has(cid))
    .forEach((cid, i) => run("INSERT OR REPLACE INTO collection_order(user_id,collection_id,position) VALUES(?,?,?)", user.id, cid, i + 1));
}
// search.save (before #86): the kind and the space become part of the query.
export function saveSearchAsCollection(user: Identity, raw: unknown) {
  const b = z
    .object({
      workspaceId: z.uuid(),
      name: nameSchema,
      query: z.string().trim().min(1).max(500),
      kind: z.enum(["all", "document", "database", "whiteboard", "row", "comment", "file"]),
      spaceId: z.uuid().nullish(),
    })
    .parse(raw);
  requireMember(user, b.workspaceId);
  let query = b.query;
  if (["document", "database", "whiteboard", "row"].includes(b.kind)) query += ` type:${b.kind === "row" ? "record" : b.kind}`;
  if (b.spaceId) {
    const space = one<Space>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", b.spaceId, b.workspaceId);
    if (!space || !spaceRole(user, space)) throw new HttpError(404, "Bereich nicht gefunden.");
    query += ` in:"${space.name.replace(/"/g, "")}"`;
  }
  return createCollection(user, { workspaceId: b.workspaceId, name: b.name, query });
}

// ---- Evaluating ----

type Item = CollectionItem & {
  key: string;
  page: Page;
  updatedBy: string | null;
  // Records: the cells and fields the reader may see.
  cells?: Record<string, unknown>;
  fields?: Field[];
};
export type EvalOptions = { timeZone?: string; now?: Date; limit?: number; spaceId?: string; types?: ItemType[]; excludeDays?: boolean };

const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const validZone = (zone: string | undefined) => {
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
};
const PAGE_TYPES: Record<string, ItemType> = { document: "document", database: "database", whiteboard: "whiteboard", journal: "journal", dashboard: "dashboard", notebook: "notebook" };
const typeMatches = (item: ItemType, wanted: ItemType | null) =>
  !!wanted && (item === wanted || (wanted === "document" && (item === "journal" || item === "dashboard" || item === "notebook")));

// The keys ("pageId" or "pageId:rowId") whose indexed title and text
// contain a phrase.
function textMatches(workspaceId: string, phrase: string): Set<string> {
  const query = phrase.trim().slice(0, 200);
  const short = [...query].length < 3;
  const rows = short
    ? all<{ page_id: string; row_id: string }>(
        `SELECT s.page_id,s.row_id FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE p.workspace_id=? AND (s.title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\') LIMIT 50000`,
        workspaceId,
        ...(() => {
          const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          return [like, like];
        })(),
      )
    : all<{ page_id: string; row_id: string }>(
        `SELECT s.page_id,s.row_id FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE search_index MATCH ? AND p.workspace_id=? LIMIT 50000`,
        `"${query.replace(/"/g, '""')}"`,
        workspaceId,
      );
  return new Set(rows.filter((r) => !/^[cmf]:/.test(r.row_id)).map((r) => (r.row_id ? `${r.page_id}:${r.row_id}` : r.page_id)));
}

// The pages and records of a workspace that match a query, as the person
// may read them, latest change first.
export function evaluateQuery(user: Identity, workspaceId: string, input: string | QueryNode | null, options: EvalOptions = {}): CollectionResults {
  const node = typeof input === "string" ? parseQuery(input).node : input;
  const timeZone = validZone(options.timeZone);
  const now = options.now ?? new Date();
  const limit = options.limit ?? COLLECTION_RESULTS;
  // Keep the index current for this request (as the search does).
  refreshSearchIndex();
  const conds = conditions(node);
  // Names mean the tag or definition of a page's context: the workspace's
  // or its space's (#136); one name may stand for one per space.
  const tags = workspaceTags(workspaceId);
  const tagsByName = new Map<string, string[]>();
  for (const t of tags) tagsByName.set(foldName(t.name), [...(tagsByName.get(foldName(t.name)) ?? []), t.id]);
  const tagIn = (spaceId: string, name: string) => tags.find((t) => inScope(t, spaceId) && foldName(t.name) === name)?.id;
  const defs = workspaceProperties(workspaceId);
  const defByName = new Map(defs.map((d) => [foldName(d.name), d]));
  const defIn = (spaceId: string, name: string) => defs.find((d) => inScope(d, spaceId) && foldName(d.name) === name);
  const members = new Map(
    all<{ id: string; name: string }>("SELECT u.id,u.name FROM users u WHERE u.id IN (SELECT user_id FROM members WHERE workspace_id=?) OR u.id IN (SELECT created_by FROM pages WHERE workspace_id=?)", workspaceId, workspaceId).map(
      (u) => [u.id, u.name],
    ),
  );
  const people = (uid: string) => members.get(uid);
  const spaces = all<Space>("SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL", workspaceId);
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
  // Which kinds of items can match at all.
  const allowedTypes = possibleTypes(node);
  const wantType = (t: ItemType) =>
    (!allowedTypes || [...allowedTypes].some((w) => typeMatches(t, w))) && (!options.types || options.types.some((w) => typeMatches(t, w)));
  const locked = lockedPageIds(user, workspaceId);
  let encryptedLeftOut = false;
  const pages = all<Page & { created: string | null }>(
    `SELECT p.*,COALESCE(p.created_at,(SELECT MIN(s.created_at) FROM snapshots s WHERE s.page_id=p.id),p.updated_at) created
     FROM pages p WHERE p.workspace_id=? AND p.deleted_at IS NULL AND COALESCE(p.synced,0)=0${options.spaceId ? " AND p.space_id=?" : ""}`,
    workspaceId,
    ...(options.spaceId ? [options.spaceId] : []),
  );
  const roles = new Map<string, ReturnType<typeof pageRole>>();
  const readable = pages.filter((p) => {
    if (locked.has(p.id)) return false;
    const role = pageRole(user, p);
    roles.set(p.id, role);
    if (!role) return false;
    if (isEncryptedPage(p)) {
      encryptedLeftOut = true;
      return false;
    }
    return true;
  });
  // Tags of pages, the last editor of each page.
  const pageTags = new Map<string, string[]>();
  for (const link of all<{ page_id: string; tag_id: string }>(
    "SELECT l.page_id,l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE t.workspace_id=? ORDER BY l.position,t.position",
    workspaceId,
  ))
    (pageTags.get(link.page_id) ?? pageTags.set(link.page_id, []).get(link.page_id)!).push(link.tag_id);
  const needsEditor = conds.some((c) => c.type === "editor" || (c.type === "prop" && defByName.get(foldName(c.name ?? ""))?.type === "updated_by"));
  const editors = new Map<string, string>();
  if (needsEditor)
    for (const e of all<{ page_id: string; user_id: string }>(
      `SELECT e.page_id,e.user_id FROM page_edits e JOIN pages p ON p.id=e.page_id WHERE p.workspace_id=? ORDER BY e.at`,
      workspaceId,
    ))
      editors.set(e.page_id, e.user_id);
  const items: Item[] = [];
  for (const p of readable) {
    const type = PAGE_TYPES[p.kind] ?? "document";
    if (!wantType(type) || (options.excludeDays && p.journal_date)) continue;
    items.push({
      key: p.id,
      pageId: p.id,
      type,
      title: p.title,
      icon: p.icon,
      spaceId: p.space_id,
      tags: pageTags.get(p.id) ?? [],
      createdAt: p.created,
      updatedAt: p.updated_at,
      createdBy: p.created_by ?? null,
      creatorName: (p.created_by && people(p.created_by)) || "",
      updatedBy: editors.get(p.id) ?? p.created_by ?? null,
      ...(p.journal_date ? { journalDate: p.journal_date } : {}),
      page: p,
    });
  }
  // Records of the databases the person may read.
  if (wantType("record")) {
    for (const p of readable) {
      if (p.kind !== "database") continue;
      const stored = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", p.id);
      if (!stored) continue;
      const fields = JSON.parse(stored.fields) as Field[];
      const role = roles.get(p.id)!;
      const hidden = hiddenFieldsFor(user, p, fields, role);
      const shown = hidden.size ? fields.filter((f) => !hidden.has(f.id)) : fields;
      const titleField = fields[0] && !hidden.has(fields[0].id) ? fields[0].id : null;
      const tagFields = shown.filter(isTagField);
      const resolve = rowRoleResolver(user, p, role);
      for (const row of all<{ id: string; cells: string; access: string; created_by: string | null; updated_by: string | null; created_at: string; updated_at: string; icon: string | null }>(
        "SELECT id,cells,access,created_by,updated_by,created_at,updated_at,icon FROM rows WHERE page_id=?",
        p.id,
      )) {
        if (!resolve(row)) continue;
        const cells = JSON.parse(row.cells) as Record<string, unknown>;
        const own = new Set<string>();
        for (const f of tagFields) {
          const value = cells[f.id];
          if (Array.isArray(value))
            for (const v of value) {
              const tagId = typeof v === "string" ? tagIn(p.space_id, foldName(v)) : undefined;
              if (tagId) own.add(tagId);
            }
        }
        items.push({
          key: `${p.id}:${row.id}`,
          pageId: p.id,
          rowId: row.id,
          type: "record",
          title: titleField ? cellText(cells[titleField]) : "",
          icon: row.icon || "",
          spaceId: p.space_id,
          database: p.title,
          tags: tags.filter((t) => own.has(t.id)).map((t) => t.id),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          createdBy: row.created_by,
          creatorName: (row.created_by && people(row.created_by)) || "",
          updatedBy: row.updated_by ?? row.created_by,
          page: p,
          cells,
          fields: shown,
        });
      }
    }
  }
  // Text conditions: one look into the index each.
  const texts = new Map<string, Set<string>>();
  for (const c of conds) if (c.type === "text" && !texts.has(c.value)) texts.set(c.value, textMatches(workspaceId, c.value));
  // Page property values, by property.
  const values = new Map<string, Map<string, unknown>>();
  const valuesOf = (def: PagePropertyDef) => {
    if (!values.has(def.id))
      values.set(
        def.id,
        new Map(
          all<{ page_id: string; value: string }>("SELECT page_id,value FROM page_property_values WHERE property_id=?", def.id).map((v) => {
            let value: unknown = null;
            try {
              value = JSON.parse(v.value);
            } catch {}
            return [v.page_id, value];
          }),
        ),
      );
    return values.get(def.id)!;
  };
  const isMe = (value: string) => /^(me|ich|moi)$/i.test(value.trim());
  const personMatches = (uid: string | null, value: string) => {
    if (!uid) return false;
    if (isMe(value)) return uid === user.id;
    return fold(people(uid) ?? "").includes(fold(value.trim()));
  };
  const ranges = new Map<string, ReturnType<typeof dateRange>>();
  const rangeOf = (value: string) => {
    if (!ranges.has(value)) ranges.set(value, dateRange(value, now, timeZone));
    return ranges.get(value)!;
  };
  const spaceMatches = (spaceId: string, value: string) => spaceId === value || foldName(spaceName.get(spaceId) ?? "") === foldName(value);
  const propMatches = (item: Item, c: Cond): boolean | null => {
    const name = foldName(c.name ?? "");
    // A record's own property of that name first.
    const field = item.fields?.find((f) => foldName(f.name) === name);
    if (field && item.cells) {
      const type = field.type as string;
      const value =
        type === "created_at" ? item.createdAt : type === "updated_at" ? item.updatedAt : type === "created_by" ? item.createdBy : type === "updated_by" ? item.updatedBy : item.cells[field.id];
      return valueMatches({ type: (type as PagePropertyType) ?? "text" }, value, c);
    }
    const def = defIn((item.page as Page).space_id, name);
    if (!def) return defByName.has(name) ? false : null;
    let value: unknown;
    if (isComputedProperty(def.type)) {
      // A record has its database's (as before #86).
      const page = item.page as Page & { created?: string | null };
      const of = item.rowId
        ? { created_at: page.created ?? null, updated_at: page.updated_at, created_by: page.created_by ?? null, updated_by: editors.get(page.id) ?? page.created_by ?? null }
        : { created_at: item.createdAt, updated_at: item.updatedAt, created_by: item.createdBy, updated_by: item.updatedBy };
      value = of[def.type as keyof typeof of];
    } else value = valuesOf(def).get(item.pageId);
    return valueMatches(def, value, c);
  };
  const valueMatches = (def: Pick<PagePropertyDef, "type">, value: unknown, c: Cond) => {
    const dateLike = def.type === "date" || def.type === "created_at" || def.type === "updated_at";
    if (dateLike && isRelativeDate(c.value) && !["*", "-", ""].includes(c.value)) {
      const range = rangeOf(c.value);
      return !!range && typeof value === "string" && inDateRange(value, range, timeZone);
    }
    const known = (["text", "number", "date", "select", "multiselect", "checkbox", "person", "url", "email", "phone", "created_at", "updated_at", "created_by", "updated_by"] as string[]).includes(def.type);
    const type = (known ? def.type : "text") as PagePropertyType;
    const filter = propertyFilter("", type, c.value.trim(), !!c.quoted);
    if (!filter) return false;
    const plain = type === "text" && value !== null && typeof value === "object" && !Array.isArray(value) ? cellText(value) : value;
    return matchesPropertyFilter({ type }, plain, filter, people, user.id);
  };
  const test = (item: Item, n: QueryNode): boolean => {
    let result: boolean;
    if (isGroup(n)) result = n.type === "and" ? n.items.every((x) => test(item, x)) : n.items.some((x) => test(item, x));
    else
      switch (n.type) {
        case "text":
          result = !!texts.get(n.value)?.has(item.key);
          break;
        case "title":
          result = fold(item.title).includes(fold(n.value.trim()));
          break;
        case "tag": {
          const tagIds = tagsByName.get(foldName(n.value));
          if (!tagIds) {
            // An unknown tag is searched as a word, as before.
            result = textMatchesNow(`#${n.value}`, item.key);
            break;
          }
          // Records also carry their database's tags (#79).
          result = tagIds.some((tagId) => item.tags.includes(tagId) || (!!item.rowId && !!pageTags.get(item.pageId)?.includes(tagId)));
          break;
        }
        case "prop": {
          const m = propMatches(item, n);
          result = m === null ? textMatchesNow(`${n.name}:${n.value}`, item.key) : m;
          break;
        }
        case "creator":
          result = personMatches(item.createdBy, n.value);
          break;
        case "editor":
          result = personMatches(item.updatedBy, n.value);
          break;
        case "created":
        case "updated": {
          const range = rangeOf(n.value);
          result = !!range && inDateRange(n.type === "created" ? item.createdAt : item.updatedAt, range, timeZone);
          break;
        }
        case "type":
          result = typeMatches(item.type, itemTypeOf(n.value));
          break;
        case "in":
          result = spaceMatches(item.spaceId, n.value.trim());
          break;
        default:
          result = false;
      }
    return n.not ? !result : result;
  };
  const textMatchesNow = (phrase: string, key: string) => {
    if (!texts.has(phrase)) texts.set(phrase, textMatches(workspaceId, phrase));
    return texts.get(phrase)!.has(key);
  };
  const matched = node ? items.filter((item) => test(item, node)) : items;
  matched.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return {
    items: matched.slice(0, limit).map(
      (i): CollectionItem => ({
        pageId: i.pageId,
        ...(i.rowId ? { rowId: i.rowId } : {}),
        type: i.type,
        title: i.title,
        icon: i.icon,
        spaceId: i.spaceId,
        ...(i.database !== undefined ? { database: i.database } : {}),
        tags: i.tags,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        createdBy: i.createdBy,
        creatorName: i.creatorName,
        ...(i.journalDate ? { journalDate: i.journalDate } : {}),
      }),
    ),
    total: matched.length,
    truncated: matched.length > limit,
    encryptedLeftOut,
  };
}

// GET /api/collections/{id}: a collection with its current results.
export function runCollection(user: Identity, collectionId: string, options: EvalOptions = {}) {
  const collection = getCollection(user, collectionId);
  const c = one<Row>("SELECT * FROM collections WHERE id=?", collectionId)!;
  return { collection, ...evaluateQuery(user, c.workspace_id, collection.query, options) };
}
// The results of a query not saved yet (the editor's preview).
export function previewQuery(user: Identity, workspaceId: string, query: string, options: EvalOptions = {}) {
  requireMember(user, workspaceId);
  return { query: normalizeQuery(query.slice(0, 1000)), ...evaluateQuery(user, workspaceId, query.slice(0, 1000), { ...options, limit: Math.min(options.limit ?? 50, 50) }) };
}
