import { all, one } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { formulaReferences } from "./formula";
import type { Field, Identity, Page, Role } from "./types";

// Field-level permissions: a property may be readable or writable only for
// some people. Rules, per property (`Field.access`):
//
//   read  (default "all")     who sees the property and its values
//   write (default "editors") who changes its values
//
//   "all"      everyone with access to the database page
//   "editors"  editors and owners of the page
//   "owners"   owners of the page
//   {groups}   members of one of these workspace groups (and owners)
//
// Page owners always read and write every property (they manage the schema).
// Field rules only narrow the page and record permissions: writing still
// needs edit rights on the page and the record, and a property that cannot be
// read cannot be written. The title property (the first one) is always
// visible.
//
// Derived properties: a formula, rollup, AI property, progress or time
// property is treated as unavailable (hidden) for everyone who may not read
// one of the properties it reads, so its result never leaks a hidden value.
// A formula with a computed prop() argument depends on every property.
//
// Public readers (publications, share links, forms, webhooks, calendar
// subscriptions without a person) only ever see properties without a read
// rule; share links with edit rights change only properties without a write
// rule narrower than "editors".
import type { AccessRule, FieldAccess } from "./field-access-rules";
export type { AccessRule, FieldAccess } from "./field-access-rules";
export type FieldViewer = {
  role: Role | null;
  groups: ReadonlySet<string>;
  // Readers without an account (publications, share links, forms, webhooks).
  public?: boolean;
};
export const publicViewer: FieldViewer = {
  role: "viewer",
  groups: new Set(),
  public: true,
};
export function fieldViewer(
  user: Identity,
  page: Page,
  role: Role | null = pageRole(user, page),
): FieldViewer {
  return {
    role,
    groups: new Set([
      ...(user.groups || []),
      ...all<{ group_id: string }>(
        "SELECT group_id FROM group_members WHERE user_id=?",
        user.id,
      ).map((g) => g.group_id),
    ]),
  };
}
const open = (rule?: AccessRule) => !rule || rule === "all";
export function ruleAllows(rule: AccessRule | undefined, viewer: FieldViewer) {
  if (open(rule)) return !!viewer.role;
  if (viewer.public || !viewer.role) return false;
  if (viewer.role === "owner") return true;
  if (rule === "editors") return viewer.role === "editor";
  if (rule === "owners") return false;
  return typeof rule === "object" && rule.groups.some((g) => viewer.groups.has(g));
}
// Whether a property carries a read or write rule at all.
export const readRestricted = (f: Pick<Field, "access">) => !open(f.access?.read);
export const writeRestricted = (f: Pick<Field, "access">) =>
  !open(f.access?.write) && f.access?.write !== "editors";
export const hasFieldAccess = (fields: Pick<Field, "access">[]) =>
  fields.some((f) => readRestricted(f) || writeRestricted(f));

// Properties a derived property reads in its own database.
function dependencies(field: Field, fields: Field[]): Field[] | "all" {
  const byRef = (ref: string) =>
    fields.find((f) => f.id === ref) || fields.findLast((f) => f.name === ref);
  const refs: (Field | undefined)[] = [];
  if (field.type === "formula") {
    const parsed = formulaReferences(field.formula || "");
    if (parsed?.dynamic) return "all";
    for (const name of parsed?.names || []) refs.push(byRef(name));
  }
  if (field.type === "rollup" && field.relationField)
    refs.push(fields.find((f) => f.id === field.relationField));
  if (field.type === "progress")
    refs.push(
      fields.find((f) => f.id === field.parentField),
      fields.find((f) => f.id === field.doneField),
    );
  if (field.type === "time")
    refs.push(fields.find((f) => f.id === field.estimateField));
  if (field.ai)
    for (const m of field.ai.prompt.matchAll(/\{([^{}\n]{1,100})\}/g))
      refs.push(byRef(m[1].trim()));
  return refs.filter((f): f is Field => !!f && f.id !== field.id);
}
// Ids of the properties a reader sees. `remote` answers for the property a
// rollup reads in the related database (unknown: hidden).
export function readableFieldIds(
  viewer: FieldViewer,
  fields: Field[],
  remote: (field: Field) => boolean = () => !viewer.public,
) {
  const result = new Map<string, boolean>();
  const visit = (field: Field, trail: Set<string>): boolean => {
    if (result.has(field.id)) return result.get(field.id)!;
    let ok = field.id === fields[0]?.id || ruleAllows(field.access?.read, viewer);
    if (ok && trail.has(field.id)) return true;
    if (ok) {
      const deps = dependencies(field, fields);
      const next = new Set(trail).add(field.id);
      ok =
        deps === "all"
          ? fields.every((f) => f.id === field.id || next.has(f.id) || visit(f, next))
          : deps.every((f) => next.has(f.id) || visit(f, next));
      if (ok && field.type === "rollup" && field.rollupField) ok = remote(field);
    }
    result.set(field.id, ok);
    return ok;
  };
  return new Set(fields.filter((f) => visit(f, new Set())).map((f) => f.id));
}
export function hiddenFieldIds(
  viewer: FieldViewer,
  fields: Field[],
  remote?: (field: Field) => boolean,
) {
  if (!fields.some((f) => readRestricted(f) || f.type === "rollup"))
    return new Set<string>();
  const readable = readableFieldIds(viewer, fields, remote);
  return new Set(fields.filter((f) => !readable.has(f.id)).map((f) => f.id));
}
export function canWriteField(viewer: FieldViewer, field: Field, readable: Set<string>) {
  if (!readable.has(field.id)) return false;
  if (viewer.public) return !writeRestricted(field) && !readRestricted(field);
  const rule = field.access?.write;
  return open(rule) || ruleAllows(rule, viewer);
}

const storedFields = (pageId: string): Field[] =>
  JSON.parse(
    String(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]"),
  );
// Rollups read a property of another database: visible when the person may
// read that page and that property there (nested rollups a few levels deep).
function remoteResolver(user: Identity, fields: Field[], depth = 0) {
  const cache = new Map<string, Set<string> | null>();
  return (field: Field) => {
    const pageId = fields.find((r) => r.id === field.relationField)?.relationPage;
    if (!pageId || !field.rollupField) return true;
    if (depth > 3) return false;
    if (!cache.has(pageId)) {
      const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
      const role = page ? pageRole(user, page) : null;
      const target = page ? storedFields(pageId) : [];
      cache.set(
        pageId,
        page && role
          ? readableFieldIds(fieldViewer(user, page, role), target, remoteResolver(user, target, depth + 1))
          : null,
      );
    }
    return !!cache.get(pageId)?.has(field.rollupField);
  };
}
const needsCheck = (fields: Field[]) =>
  fields.some((f) => readRestricted(f) || (f.type === "rollup" && !!f.rollupField));
// Hidden property ids for a person in a database (by its stored schema
// unless `fields` is given).
export function hiddenFieldsFor(
  user: Identity,
  page: Page,
  fields: Field[] = storedFields(page.id),
  role?: Role | null,
): Set<string> {
  if (!needsCheck(fields)) return new Set();
  return hiddenFieldIds(
    fieldViewer(user, page, role === undefined ? pageRole(user, page) : role),
    fields,
    remoteResolver(user, fields),
  );
}
// The properties a person sees, in order.
export function visibleFields(user: Identity, page: Page, fields: Field[]) {
  const hidden = hiddenFieldsFor(user, page, fields);
  return hidden.size ? fields.filter((f) => !hidden.has(f.id)) : fields;
}
export function readableDatabase<D extends { fields: Field[] }>(user: Identity, page: Page, d: D): D {
  return { ...d, fields: visibleFields(user, page, d.fields) };
}
export function stripCells<T>(cells: T, hidden: Set<string>): T {
  if (!hidden.size || !cells) return cells;
  if (typeof cells === "string") {
    const parsed = JSON.parse(cells) as Record<string, unknown>;
    for (const key of hidden) delete parsed[key];
    return JSON.stringify(parsed) as T;
  }
  const copy = { ...(cells as Record<string, unknown>) };
  for (const key of hidden) delete copy[key];
  return copy as T;
}
// Records without the cells a person may not read (cells stored as JSON
// text or as an object).
export function stripHiddenCells<T extends { cells?: unknown }>(
  user: Identity,
  page: Page,
  rows: T[],
  fields?: Field[],
): T[] {
  if (!rows.length) return rows;
  const hidden = hiddenFieldsFor(user, page, fields || storedFields(page.id));
  return hidden.size ? rows.map((r) => ({ ...r, cells: stripCells(r.cells, hidden) })) : rows;
}
// Cells as an unauthenticated reader may see them.
export function publicCells<T>(cells: T, fields: Field[]): T {
  return stripCells(cells, hiddenFieldIds(publicViewer, fields));
}
export function publicHiddenFieldIds(fields: Field[]) {
  return hiddenFieldIds(publicViewer, fields);
}
// Visible properties a person may not change (shown read-only).
export function readOnlyFieldIds(user: Identity, page: Page, fields: Field[]) {
  if (!fields.some((f) => writeRestricted(f) || readRestricted(f))) return [];
  const viewer = fieldViewer(user, page);
  const readable = readableFieldIds(viewer, fields, remoteResolver(user, fields));
  return fields.filter((f) => readable.has(f.id) && !canWriteField(viewer, f, readable)).map((f) => f.id);
}
export function fieldWriteMessage(field: Pick<Field, "name">) {
  return `„${field.name}“ ist nur für bestimmte Personen bearbeitbar.`;
}
// Refuses a change to properties the person may not write (403).
export function assertFieldsWritable(
  user: Identity,
  page: Page,
  fields: Field[],
  keys: Iterable<string>,
  viewer: FieldViewer = fieldViewer(user, page),
) {
  const list = [...keys];
  if (!list.length) return;
  const touched = fields.filter((f) => list.includes(f.id));
  if (!touched.some((f) => readRestricted(f) || writeRestricted(f)) && !needsCheck(fields)) return;
  const readable = readableFieldIds(viewer, fields, remoteResolver(user, fields));
  for (const f of touched)
    if (!canWriteField(viewer, f, readable)) throw new HttpError(403, fieldWriteMessage(f));
}
// Public writers (share links with edit rights, forms).
export function publicWritable(field: Field, fields: Field[]) {
  return canWriteField(publicViewer, field, readableFieldIds(publicViewer, fields));
}

// Rules as stored: groups must exist in the workspace, the title property
// stays open, and only page owners change rules.
export function validateFieldAccess(
  user: Identity,
  page: Page,
  next: Field[],
  previous: Field[],
) {
  const same = (a?: FieldAccess, b?: FieldAccess) =>
    JSON.stringify(normalAccess(a) || null) === JSON.stringify(normalAccess(b) || null);
  const owner = pageRole(user, page) === "owner";
  if (!owner) {
    const viewer = fieldViewer(user, page);
    const readable = readableFieldIds(viewer, previous, remoteResolver(user, previous));
    for (const old of previous)
      if (!next.some((f) => f.id === old.id) && readable.has(old.id) && !canWriteField(viewer, old, readable))
        throw new HttpError(403, fieldWriteMessage(old));
  }
  for (const f of next) {
    f.access = normalAccess(f.access);
    if (!f.access) delete f.access;
    const old = previous.find((p) => p.id === f.id);
    if (!same(f.access, old?.access) && !owner)
      throw new HttpError(403, "Nur Besitzer der Datenbank ändern die Sichtbarkeit von Eigenschaften.");
    if (f === next[0] && f.access && readRestricted(f))
      throw new HttpError(400, "Die erste Eigenschaft (Titel) ist immer sichtbar.");
    for (const rule of [f.access?.read, f.access?.write])
      if (rule && typeof rule === "object")
        for (const gid of rule.groups)
          if (
            !one("SELECT 1 FROM groups WHERE id=? AND workspace_id=?", gid, page.workspace_id) &&
            !(old?.access && JSON.stringify(old.access).includes(JSON.stringify(gid)))
          )
            throw new HttpError(400, "Gruppe fehlt.");
  }
}
function normalAccess(access?: FieldAccess): FieldAccess | undefined {
  if (!access) return undefined;
  const out: FieldAccess = {};
  if (access.read && access.read !== "all") out.read = access.read;
  if (access.write && access.write !== "editors" && access.write !== "all") out.write = access.write;
  return out.read || out.write ? out : undefined;
}
// Merges the schema an editor sends with the properties hidden from them:
// those stay where they were, unchanged.
export function mergeHiddenFields(
  user: Identity,
  page: Page,
  next: Field[],
  previous: Field[],
) {
  const hidden = hiddenFieldsFor(user, page, previous);
  if (!hidden.size) return next;
  const merged = next.filter((f) => !hidden.has(f.id));
  previous.forEach((f, index) => {
    if (hidden.has(f.id)) merged.splice(Math.min(index, merged.length), 0, f);
  });
  return merged;
}
