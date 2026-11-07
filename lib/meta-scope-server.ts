// Scopes of tags, page property definitions and saved templates (#136),
// server side (lib/meta-scope.ts has the shared part and the decisions):
//
// - Changing a scope ("tag.scope", "property.scope"): to the whole
//   workspace (promotion) or to one space. Only workspace owners. Before, a
//   person sees where it is used ("meta.usage"): pages and records outside
//   the target space keep their tags and values only by an explicit choice –
//   `resolve: "copy"` (a copy of the same name for each other space that
//   uses it), `resolve: "remove"` (taken off there) – otherwise the change is
//   refused (409). A promotion meets same-named items of other spaces:
//   refused unless `mergeSameName` folds them into the promoted one.
// - Moving pages ("page.move" with `meta`): what the pages and their
//   databases' records carry from the source space (or, into another
//   workspace, from the source workspace) is mapped, copied or removed per
//   item; "page.moveCheck" lists it first. Without a choice the move is
//   refused – never silently dropped.
// - Templates of a space used in another one ("template.dependencies",
//   `meta` of page.create/template.apply/template.copy): their space's tags
//   and definitions are mapped, copied or removed the same way.
import { z } from "zod";
import { HttpError } from "./auth";
import { all, audit, id, one, run } from "./db";
import { isEncryptedPage } from "./e2ee-server";
import { requireMember, spaceRole } from "./permissions";
import {
  asDef,
  asTag,
  canManageTaxonomy,
  cleanOptions,
  contextProperties,
  contextTags,
  convertValue,
  parsePropertyValue,
  scopeClash,
  scopeSpace,
  setPageValue,
  type DefRow,
  type MetaTable,
  type TagRow,
} from "./page-properties-server";
import { cleanName, cleanTagName, foldName, isTagField, MAX_OPTIONS, MAX_PROPERTY_NAME, MAX_TAG_NAME, type PortableMeta } from "./page-properties";
import { rewriteTagValues, syncTagFieldOptions } from "./tag-fields";
import { choiceFor, metaKey, type ForeignMeta, type MetaChoice, type MetaKind, type MetaPlan } from "./meta-scope";
import type { Field, Identity, Page, Space } from "./types";

const uuid = z.string().uuid();
const choiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map"), to: z.string().max(300) }),
  z.object({ action: z.literal("copy") }),
  z.object({ action: z.literal("remove") }),
]);
export const metaPlanSchema = z.object({
  tags: z.record(z.string().max(300), choiceSchema).optional(),
  properties: z.record(z.string().max(300), choiceSchema).optional(),
  default: z.enum(["auto", "copy", "remove"]).optional(),
});
// `meta` of a command: a plan, or "auto"/"copy"/"remove" for every item.
export function parseMetaPlan(raw: unknown): MetaPlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return { default: z.enum(["auto", "copy", "remove"]).parse(raw) };
  return metaPlanSchema.parse(raw);
}

const tableOf = (kind: MetaKind): MetaTable => (kind === "tag" ? "page_tags" : "page_property_defs");
const spaceName = (spaceId: string | null) => (spaceId ? (one<{ name: string }>("SELECT name FROM spaces WHERE id=?", spaceId)?.name ?? "") : "");
const json = (list: string[]) => JSON.stringify(list);

// A name free in the context of `spaceId`: the name itself, else with the
// source space's name, else numbered.
function freeName(kind: MetaKind, workspaceId: string, spaceId: string | null, name: string, hint: string) {
  const max = kind === "tag" ? MAX_TAG_NAME : MAX_PROPERTY_NAME;
  const tries = [name, hint ? `${name} (${hint})` : "", ...Array.from({ length: 50 }, (_, i) => `${name} (${i + 2})`)].filter(Boolean);
  for (const raw of tries) {
    const candidate = cleanName(raw, max);
    if (candidate && !scopeClash(tableOf(kind), workspaceId, spaceId, candidate)) return candidate;
  }
  throw new HttpError(409, "Kein freier Name für die Kopie.");
}
// A copy of a tag or definition in a scope (as part of a move, template or
// scope change the person may make; the rights are those of that command).
function createCopy(kind: MetaKind, source: TagRow | DefRow, workspaceId: string, spaceId: string | null, userId: string | null) {
  const name = freeName(kind, workspaceId, spaceId, source.name, spaceName(source.space_id));
  const newId = id();
  if (kind === "tag")
    run(
      "INSERT INTO page_tags(id,workspace_id,space_id,name,color,position,created_by,created_at) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_tags WHERE workspace_id=?),?,?)",
      newId,
      workspaceId,
      spaceId,
      name,
      (source as TagRow).color,
      workspaceId,
      userId,
      Date.now(),
    );
  else
    run(
      "INSERT INTO page_property_defs(id,workspace_id,space_id,name,type,options,position,created_by,created_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM page_property_defs WHERE workspace_id=?),?,?)",
      newId,
      workspaceId,
      spaceId,
      name,
      (source as DefRow).type,
      (source as DefRow).options,
      workspaceId,
      userId,
      Date.now(),
    );
  return { id: newId, name };
}

// ---- Relinking pages ----

// The pages' links of a tag → another tag (or none).
function relinkTag(pageIds: string[], from: string, to: string | null) {
  if (to)
    run(
      "INSERT INTO page_tag_links(page_id,tag_id,position) SELECT page_id,?,position FROM page_tag_links WHERE tag_id=? AND page_id IN (SELECT value FROM json_each(?)) ON CONFLICT DO NOTHING",
      to,
      from,
      json(pageIds),
    );
  run("DELETE FROM page_tag_links WHERE tag_id=? AND page_id IN (SELECT value FROM json_each(?))", from, json(pageIds));
}
// The pages' values of a definition → another (converted; options a value
// needs are added to a select there, so nothing is lost) or none.
function relinkValues(pageIds: string[], from: DefRow, to: DefRow | null) {
  const values = all<{ page_id: string; value: string }>(
    "SELECT page_id,value FROM page_property_values WHERE property_id=? AND page_id IN (SELECT value FROM json_each(?))",
    from.id,
    json(pageIds),
  );
  if (to && values.length) {
    let target = asDef(to);
    if (["select", "multiselect"].includes(target.type)) {
      const wanted = values.flatMap((v) => {
        const value = JSON.parse(v.value) as unknown;
        return (Array.isArray(value) ? value : [value]).filter((x): x is string => typeof x === "string");
      });
      const merged = cleanOptions([...target.options, ...wanted].slice(0, MAX_OPTIONS));
      if (merged.length !== target.options.length) {
        run("UPDATE page_property_defs SET options=? WHERE id=?", JSON.stringify(merged), target.id);
        target = { ...target, options: merged };
      }
    }
    const source = asDef(from);
    for (const v of values) {
      let value: unknown = null;
      try {
        value = parsePropertyValue(target, convertValue(source, target, JSON.parse(v.value)), to.workspace_id);
      } catch {
        value = null;
      }
      // A value the target cannot hold stays where it is: refused, not lost.
      if (value === null) throw new HttpError(409, `„${from.name}“: Ein Wert passt nicht zu „${to.name}“. Wähle eine Eigenschaft desselben Typs oder „Kopieren“.`);
      setPageValue(v.page_id, target.id, value);
    }
  }
  run("DELETE FROM page_property_values WHERE property_id=? AND page_id IN (SELECT value FROM json_each(?))", from.id, json(pageIds));
}

// ---- Tag names in databases (tag-backed properties, #79) ----

type TagDb = { page: Page; fields: Field[] };
function tagDatabasesOf(pageIds: string[]): TagDb[] {
  return all<Page & { db_fields: string }>(
    `SELECT p.*,d.fields db_fields FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.id IN (SELECT value FROM json_each(?)) AND instr(d.fields,'"tagOptions":true')>0`,
    json(pageIds),
  ).flatMap(({ db_fields, ...page }) => {
    const fields = (JSON.parse(db_fields) as Field[]).filter(isTagField);
    return fields.length ? [{ page: page as Page, fields }] : [];
  });
}
// Folded tag name → how many records of these databases carry it.
function recordTagNames(dbs: TagDb[]) {
  const counts = new Map<string, { name: string; records: number; spaceId: string; workspaceId: string }[]>();
  for (const db of dbs)
    for (const row of all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", db.page.id)) {
      const cells = JSON.parse(row.cells) as Record<string, unknown>;
      const names = new Set<string>();
      for (const f of db.fields) {
        const value = cells[f.id];
        if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && cleanTagName(v)) names.add(v);
      }
      for (const name of names) {
        const key = foldName(name);
        const list = counts.get(key) ?? [];
        const entry = list.find((e) => e.spaceId === db.page.space_id && e.workspaceId === db.page.workspace_id);
        if (entry) entry.records++;
        else list.push({ name, records: 1, spaceId: db.page.space_id, workspaceId: db.page.workspace_id });
        counts.set(key, list);
      }
    }
  return counts;
}

// ---- Moving pages ----

export type MoveTarget = { workspaceId: string; spaceId: string };
const candidatesFor = (kind: MetaKind, target: MoveTarget, type?: string) =>
  kind === "tag"
    ? contextTags(target.workspaceId, target.spaceId).map((t) => ({ id: t.id, name: t.name, spaceId: t.spaceId ?? null, color: t.color }))
    : contextProperties(target.workspaceId, target.spaceId)
        .filter((d) => d.type === type)
        .map((d) => ({ id: d.id, name: d.name, spaceId: d.spaceId ?? null, type: d.type }));

// What pages moving to `target` carry that is not at home there: tags and
// definitions of their (source) space – or, into another workspace, all.
export function moveForeignMeta(pageIds: string[], target: MoveTarget): ForeignMeta[] {
  const pages = all<Page>("SELECT * FROM pages WHERE id IN (SELECT value FROM json_each(?))", json(pageIds)).filter((p) => !isEncryptedPage(p));
  if (!pages.length || isEncryptedPage({ space_id: target.spaceId })) return [];
  const ids = pages.map((p) => p.id);
  const foreign = (item: { workspace_id: string; space_id: string | null }) =>
    item.workspace_id !== target.workspaceId || (!!item.space_id && item.space_id !== target.spaceId);
  const out: ForeignMeta[] = [];
  const tags = all<TagRow & { n: number }>(
    "SELECT t.*,COUNT(DISTINCT l.page_id) n FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id IN (SELECT value FROM json_each(?)) GROUP BY t.id ORDER BY t.position",
    json(ids),
  );
  // Names in tag-backed properties of the moved databases, as the tags of
  // each database's (source) context.
  const named = recordTagNames(tagDatabasesOf(ids));
  const byRecords = new Map<string, number>();
  for (const [key, list] of named)
    for (const entry of list) {
      const tag = one<TagRow>(
        "SELECT * FROM page_tags WHERE workspace_id=? AND (space_id IS NULL OR space_id=?) AND name=? COLLATE NOCASE ORDER BY space_id IS NOT NULL",
        entry.workspaceId,
        entry.spaceId,
        key,
      );
      if (tag) byRecords.set(tag.id, (byRecords.get(tag.id) ?? 0) + entry.records);
      if (tag && !tags.some((t) => t.id === tag.id)) tags.push({ ...tag, n: 0 });
    }
  for (const tag of tags) {
    if (!foreign(tag)) continue;
    const candidates = candidatesFor("tag", target);
    out.push({
      kind: "tag",
      id: tag.id,
      name: tag.name,
      color: asTag(tag).color,
      spaceId: tag.space_id,
      spaceName: spaceName(tag.space_id),
      pages: tag.n,
      records: byRecords.get(tag.id) ?? 0,
      sameName: candidates.find((c) => foldName(c.name) === foldName(tag.name))?.id ?? null,
      candidates,
    });
  }
  for (const def of all<DefRow & { n: number }>(
    "SELECT d.*,COUNT(DISTINCT v.page_id) n FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id IN (SELECT value FROM json_each(?)) GROUP BY d.id ORDER BY d.position",
    json(ids),
  )) {
    if (!foreign(def)) continue;
    const candidates = candidatesFor("property", target, def.type);
    out.push({
      kind: "property",
      id: def.id,
      name: def.name,
      type: asDef(def).type,
      spaceId: def.space_id,
      spaceName: spaceName(def.space_id),
      pages: def.n,
      records: 0,
      sameName: candidates.find((c) => foldName(c.name) === foldName(def.name))?.id ?? null,
      candidates,
    });
  }
  return out;
}

export function needsPlanMessage(items: ForeignMeta[]) {
  const names = items.map((i) => (i.kind === "tag" ? `#${i.name}` : i.name)).slice(0, 8);
  return `Die Seiten verwenden Tags oder Eigenschaften, die es am Ziel nicht gibt (${names.join(", ")}${items.length > names.length ? " …" : ""}). Wähle für jede: zuordnen, kopieren oder entfernen.`;
}

// After the pages moved (they are in `target` now): each foreign item is
// mapped, copied or removed on them and in their databases' records.
export function applyMovePlan(user: Identity, pageIds: string[], items: ForeignMeta[], plan: MetaPlan | undefined, target: MoveTarget) {
  if (!items.length) return;
  const choices = items.map((item) => ({ item, choice: choiceFor(item, plan) }));
  if (choices.some((c) => !c.choice)) throw new HttpError(409, needsPlanMessage(choices.filter((c) => !c.choice).map((c) => c.item)));
  const dbs = new Set(tagDatabasesOf(pageIds).map((db) => db.page.id));
  for (const { item, choice } of choices as { item: ForeignMeta; choice: MetaChoice }[]) {
    if (item.kind === "tag") {
      const source = one<TagRow>("SELECT * FROM page_tags WHERE id=?", item.id);
      if (!source) continue;
      let to: { id: string; name: string } | null = null;
      if (choice.action === "map") {
        const mapped = item.candidates.find((c) => c.id === choice.to);
        if (!mapped) throw new HttpError(400, `„${item.name}“: Dieses Ziel gibt es dort nicht.`);
        to = mapped;
      } else if (choice.action === "copy") to = createCopy("tag", source, target.workspaceId, target.spaceId, user.id);
      relinkTag(pageIds, source.id, to?.id ?? null);
      // Records keep tag names: renamed where the target has another name.
      if (dbs.size && (!to || foldName(to.name) !== foldName(source.name))) rewriteTagValues(user, target.workspaceId, source.name, to?.name ?? null, null, dbs);
    } else {
      const source = one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", item.id);
      if (!source) continue;
      let to: DefRow | null = null;
      if (choice.action === "map") {
        if (!item.candidates.some((c) => c.id === choice.to)) throw new HttpError(400, `„${item.name}“: Wähle eine Eigenschaft desselben Typs am Ziel.`);
        to = one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", choice.to)!;
      } else if (choice.action === "copy") to = one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", createCopy("property", source, target.workspaceId, target.spaceId, user.id).id)!;
      relinkValues(pageIds, source, to);
    }
  }
  syncTagFieldOptions(target.workspaceId);
  audit(user.id, "page.move.meta", pageIds[0], JSON.stringify(choices.map((c) => [c.item.kind, c.item.name, c.choice!.action])));
}

// ---- Changing a scope ----

type ScopeItem = (TagRow | DefRow) & { kind: MetaKind };
function scopeItem(kind: MetaKind, workspaceId: string, itemId: string): ScopeItem {
  const row = one<TagRow | DefRow>(`SELECT * FROM ${tableOf(kind)} WHERE id=? AND workspace_id=?`, itemId, workspaceId);
  if (!row) throw new HttpError(404, kind === "tag" ? "Schlagwort (Tag) nicht gefunden." : "Eigenschaft nicht gefunden.");
  return { ...row, kind };
}
export type ScopeUsage = { spaceId: string; spaceName: string; pages: number; records: number; titles: string[] };
// Where an item is used outside `target` (null: nowhere – the whole
// workspace sees it): pages with it, and for tags records of databases with
// the tags as options. Pages in the trash count too (restored, they keep it).
export function usageOutside(item: ScopeItem, target: string | null): ScopeUsage[] {
  if (!target) return [];
  const bySpace = new Map<string, ScopeUsage>();
  const entry = (spaceId: string) => {
    let usage = bySpace.get(spaceId);
    if (!usage) bySpace.set(spaceId, (usage = { spaceId, spaceName: spaceName(spaceId), pages: 0, records: 0, titles: [] }));
    return usage;
  };
  const pages = all<{ id: string; title: string; space_id: string }>(
    item.kind === "tag"
      ? "SELECT p.id,p.title,p.space_id FROM page_tag_links l JOIN pages p ON p.id=l.page_id WHERE l.tag_id=? AND p.space_id<>?"
      : "SELECT p.id,p.title,p.space_id FROM page_property_values v JOIN pages p ON p.id=v.page_id WHERE v.property_id=? AND p.space_id<>?",
    item.id,
    target,
  );
  for (const p of pages) {
    const usage = entry(p.space_id);
    usage.pages++;
    if (usage.titles.length < 5) usage.titles.push(p.title);
  }
  if (item.kind === "tag") {
    const dbs = all<{ id: string; space_id: string }>("SELECT id,space_id FROM pages WHERE workspace_id=? AND space_id<>?", item.workspace_id, target).map((p) => p.id);
    for (const list of recordTagNames(tagDatabasesOf(dbs)).get(foldName(item.name)) ?? [])
      if (!item.space_id || item.space_id === list.spaceId) entry(list.spaceId).records += list.records;
  }
  return [...bySpace.values()];
}
// Same-named items that would share a context with the item in `target`.
function clashesIn(item: ScopeItem, target: string | null) {
  return all<TagRow | DefRow>(
    `SELECT * FROM ${tableOf(item.kind)} WHERE workspace_id=? AND id<>? AND name=? COLLATE NOCASE${target ? " AND (space_id IS NULL OR space_id=?)" : ""}`,
    item.workspace_id,
    item.id,
    item.name,
    ...(target ? [target] : []),
  );
}

// "meta.usage": what changing the scope would meet.
export function metaUsage(user: Identity, input: Record<string, unknown>) {
  const b = z.object({ workspaceId: uuid, kind: z.enum(["tag", "property"]), id: uuid, spaceId: uuid.nullable() }).parse(input);
  requireMember(user, b.workspaceId);
  if (!canManageTaxonomy(user, b.workspaceId)) throw new HttpError(403, "Den Geltungsbereich ändern nur Eigentümer des Arbeitsbereichs.");
  const item = scopeItem(b.kind, b.workspaceId, b.id);
  return {
    usage: usageOutside(item, b.spaceId),
    clashes: clashesIn(item, b.spaceId).map((c) => ({ id: c.id, spaceId: c.space_id, spaceName: spaceName(c.space_id), type: (c as DefRow).type })),
  };
}

// "tag.scope" / "property.scope": { workspaceId, tagId | propertyId,
// spaceId (null: whole workspace), resolve?: "block" | "copy" | "remove",
// mergeSameName? }.
export function changeScope(user: Identity, kind: MetaKind, input: Record<string, unknown>) {
  const b = z
    .object({
      workspaceId: uuid,
      tagId: uuid.optional(),
      propertyId: uuid.optional(),
      spaceId: uuid.nullable(),
      resolve: z.enum(["block", "copy", "remove"]).default("block"),
      mergeSameName: z.boolean().default(false),
    })
    .parse(input);
  requireMember(user, b.workspaceId, "editor");
  if (!canManageTaxonomy(user, b.workspaceId)) throw new HttpError(403, "Den Geltungsbereich ändern nur Eigentümer des Arbeitsbereichs.");
  const item = scopeItem(kind, b.workspaceId, (kind === "tag" ? b.tagId : b.propertyId) ?? "");
  if ((item.space_id ?? null) === b.spaceId) return { ok: true, id: item.id };
  if (b.spaceId) scopeSpace(b.workspaceId, b.spaceId);
  // Same names where it goes: refused, or folded in on request.
  const clashes = clashesIn(item, b.spaceId);
  if (clashes.length && !b.mergeSameName) {
    const where = clashes.map((c) => (c.space_id ? `„${spaceName(c.space_id)}“` : "Arbeitsbereich")).join(", ");
    throw new HttpError(409, `Gleichnamige gibt es schon (${where}). Wähle „Gleichnamige zusammenführen“ oder benenne sie um.`);
  }
  if (kind === "property" && clashes.some((c) => (c as DefRow).type !== (item as DefRow).type))
    throw new HttpError(409, "Gleichnamige Eigenschaften eines anderen Typs lassen sich nicht zusammenführen.");
  // Uses outside the target space: copied for the other spaces, removed
  // there, or the change is refused.
  const usage = usageOutside(item, b.spaceId);
  if (usage.length && b.resolve === "block")
    throw new HttpError(
      409,
      `„${item.name}“ wird außerhalb des Zielbereichs verwendet (${usage.map((u) => `${u.spaceName}: ${u.pages + u.records}`).join(", ")}). Wähle „Für andere Bereiche kopieren“ oder „Dort entfernen“.`,
    );
  for (const clash of clashes) {
    const pageIds = all<{ id: string }>(
      kind === "tag" ? "SELECT page_id id FROM page_tag_links WHERE tag_id=?" : "SELECT page_id id FROM page_property_values WHERE property_id=?",
      clash.id,
    ).map((p) => p.id);
    if (kind === "tag") relinkTag(pageIds, clash.id, item.id);
    else relinkValues(pageIds, clash as DefRow, item as DefRow);
    // Records name the tag: the same name, now the promoted one.
    run(`DELETE FROM ${tableOf(kind)} WHERE id=?`, clash.id);
  }
  // The item takes its new scope first: copies for other spaces then have
  // its name free there.
  run(`UPDATE ${tableOf(kind)} SET space_id=? WHERE id=?`, b.spaceId, item.id);
  for (const use of usage) {
    const pageIds = all<{ id: string }>("SELECT id FROM pages WHERE space_id=?", use.spaceId).map((p) => p.id);
    const dbs = new Set(pageIds);
    if (b.resolve === "copy") {
      const copy = createCopy(kind, item, b.workspaceId, use.spaceId, user.id);
      if (kind === "tag") {
        relinkTag(pageIds, item.id, copy.id);
        if (foldName(copy.name) !== foldName(item.name)) rewriteTagValues(user, b.workspaceId, item.name, copy.name, use.spaceId, dbs);
      } else relinkValues(pageIds, item as DefRow, one<DefRow>("SELECT * FROM page_property_defs WHERE id=?", copy.id)!);
    } else if (kind === "tag") {
      relinkTag(pageIds, item.id, null);
      rewriteTagValues(user, b.workspaceId, item.name, null, use.spaceId, dbs);
    } else relinkValues(pageIds, item as DefRow, null);
  }
  if (kind === "tag") syncTagFieldOptions(b.workspaceId);
  audit(user.id, `${kind}.scope`, item.id, `${item.name}: ${item.space_id ?? "workspace"} → ${b.spaceId ?? "workspace"}`);
  return { ok: true, id: item.id };
}

// ---- Templates ----

type TemplatePayload = {
  meta?: PortableMeta;
  database?: { fields: Field[] };
  rows?: { cells: Record<string, unknown> }[];
  rowTemplates?: { cells: Record<string, unknown> }[];
};
// Every tag name a template carries in its records (tag-backed properties).
function payloadRecordTags(payload: TemplatePayload) {
  const fields = (payload.database?.fields ?? []).filter(isTagField);
  const counts = new Map<string, { name: string; records: number }>();
  for (const row of [...(payload.rows ?? []), ...(payload.rowTemplates ?? [])])
    for (const f of fields) {
      const value = row.cells?.[f.id];
      if (Array.isArray(value))
        for (const v of value)
          if (typeof v === "string" && cleanTagName(v)) {
            const key = foldName(v);
            const entry = counts.get(key) ?? { name: cleanTagName(v), records: 0 };
            entry.records++;
            counts.set(key, entry);
          }
    }
  return counts;
}
// What a template of another space brings that its target does not have:
// its space's tags and definitions (and names the target lacks). Nothing for
// templates of the whole workspace or of the target space itself.
export function templateDependencies(template: { space_id?: string | null; payload: string }, target: MoveTarget): ForeignMeta[] {
  if (!template.space_id || template.space_id === target.spaceId || isEncryptedPage({ space_id: target.spaceId })) return [];
  const payload = JSON.parse(template.payload) as TemplatePayload;
  const out: ForeignMeta[] = [];
  const from = { spaceId: template.space_id, spaceName: spaceName(template.space_id) };
  const tags = contextTags(target.workspaceId, target.spaceId);
  const records = payloadRecordTags(payload);
  const seen = new Set<string>();
  for (const tag of [...(payload.meta?.tags ?? []).map((t) => ({ ...t, records: 0 })), ...[...records.values()].map((r) => ({ name: r.name, space: false, color: undefined, records: r.records }))]) {
    const key = metaKey("tag", tag.name);
    const same = tags.find((t) => foldName(t.name) === foldName(tag.name));
    if (seen.has(key) || (!tag.space && same)) continue;
    seen.add(key);
    out.push({
      kind: "tag",
      id: key,
      name: cleanTagName(tag.name),
      ...(tag.color ? { color: asTag({ color: tag.color } as TagRow).color } : {}),
      ...from,
      pages: tag.records ? 0 : 1,
      records: records.get(foldName(tag.name))?.records ?? 0,
      sameName: same?.id ?? null,
      candidates: tags.map((t) => ({ id: t.id, name: t.name, spaceId: t.spaceId ?? null, color: t.color })),
    });
  }
  const defs = contextProperties(target.workspaceId, target.spaceId);
  for (const property of payload.meta?.properties ?? []) {
    const same = defs.find((d) => foldName(d.name) === foldName(property.name) && d.type === property.type);
    if (!property.space && same) continue;
    const candidates = defs.filter((d) => d.type === property.type).map((d) => ({ id: d.id, name: d.name, spaceId: d.spaceId ?? null, type: d.type }));
    out.push({ kind: "property", id: metaKey("property", property.name), name: property.name, type: property.type, ...from, pages: 1, records: 0, sameName: same?.id ?? null, candidates });
  }
  return out;
}
// A template's payload for `target` after the choices: mapped names
// replaced, removed ones dropped (also from its records), copies under a
// name free in the target (the same, else with the source space's name).
// `copies` lists what to create in the target space; `createProperties`
// the definitions applyPortableMeta creates there.
export type TemplateCopy = { kind: MetaKind; name: string; color?: string; type?: string; options?: string[] };
export function resolveTemplatePayload(payload: string, items: ForeignMeta[], plan: MetaPlan | undefined, target?: MoveTarget) {
  const copies: TemplateCopy[] = [];
  if (!items.length) return { payload, createProperties: new Set<string>(), copies };
  const data = JSON.parse(payload) as TemplatePayload;
  const createProperties = new Set<string>();
  const tagNames = new Map<string, string | null>();
  const copyName = (item: ForeignMeta) =>
    target && scopeClash(tableOf(item.kind), target.workspaceId, target.spaceId, item.name) ? freeName(item.kind, target.workspaceId, target.spaceId, item.name, item.spaceName ?? "") : item.name;
  for (const item of items) {
    const choice = choiceFor(item, plan ?? { default: "auto" })!;
    const mapped = choice.action === "map" ? item.candidates.find((c) => c.id === choice.to) : undefined;
    if (choice.action === "map" && !mapped) throw new HttpError(400, `„${item.name}“: Dieses Ziel gibt es dort nicht.`);
    const name = choice.action === "copy" ? copyName(item) : (mapped?.name ?? item.name);
    if (item.kind === "tag") {
      tagNames.set(foldName(item.name), choice.action === "remove" ? null : name);
      if (choice.action === "copy") copies.push({ kind: "tag", name, ...(item.color ? { color: item.color } : {}) });
    } else {
      const own = data.meta?.properties?.find((p) => foldName(p.name) === foldName(item.name));
      if (data.meta?.properties) {
        if (choice.action === "remove") data.meta.properties = data.meta.properties.filter((p) => p !== own);
        else data.meta.properties = data.meta.properties.map((p) => (p === own ? { ...p, name, space: mapped ? !!mapped.spaceId : true } : p));
      }
      if (choice.action === "copy") {
        createProperties.add(foldName(name));
        copies.push({ kind: "property", name, type: item.type, options: own?.options ?? [] });
      }
    }
  }
  const rename = (name: string) => (tagNames.has(foldName(name)) ? tagNames.get(foldName(name)) : name);
  if (data.meta?.tags)
    data.meta.tags = data.meta.tags.flatMap((t) => {
      const next = rename(t.name);
      return next ? [{ ...t, name: next }] : [];
    });
  const fields = (data.database?.fields ?? []).filter(isTagField);
  for (const row of [...(data.rows ?? []), ...(data.rowTemplates ?? [])])
    for (const f of fields) {
      const value = row.cells?.[f.id];
      if (Array.isArray(value)) row.cells[f.id] = value.flatMap((v) => (typeof v === "string" ? (rename(v) ?? []) : [v]));
    }
  return { payload: JSON.stringify(data), createProperties, copies };
}
// Creates the copies a resolved template brings in its target space (when
// a template is copied or moved there, so it finds them).
export function createTemplateCopies(userId: string, copies: TemplateCopy[], target: MoveTarget) {
  for (const copy of copies) {
    if (scopeClash(tableOf(copy.kind), target.workspaceId, target.spaceId, copy.name)) continue;
    if (copy.kind === "tag")
      createCopy("tag", { name: copy.name, color: copy.color ?? "gray", space_id: null } as TagRow, target.workspaceId, target.spaceId, userId);
    else
      createCopy(
        "property",
        { name: copy.name, type: copy.type ?? "text", options: JSON.stringify(copy.options ?? []), space_id: null } as DefRow,
        target.workspaceId,
        target.spaceId,
        userId,
      );
  }
}

// Reading a template of a space: only who may open that space.
export function canSeeScopedTemplate(user: Identity, template: { workspace_id: string; space_id?: string | null }) {
  if (!template.space_id) return true;
  if (canManageTaxonomy(user, template.workspace_id)) return true;
  const space = one<Space>("SELECT * FROM spaces WHERE id=?", template.space_id);
  return !!space && !space.deleted_at && !!spaceRole(user, space);
}
