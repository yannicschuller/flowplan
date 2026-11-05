// Applying a record template with its placeholders (lib/record-placeholders.ts):
// to a new record (row.create, capture, scheduled rules), to an existing one
// by hand (row.template.apply) or by an automation ("apply template").
// An existing record's text is never overwritten: the template fills an
// empty document or is appended below it, and fills only empty properties.
import { escapeInline, isFormattedText, toPlain } from "./inline-markdown";
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { computedCells } from "./database";
import { contentLocale } from "./content-locale";
import { localeTag } from "./i18n";
import { browserZone, Temporal, validZone } from "./date-values";
import { cellText } from "./cell-text";
import { isEmptyValue } from "./empty-value";
import { readRestricted } from "./field-access";
import { ensureRowDocument, replaceRowDocument, requireRow, type RowTemplate } from "./row-documents";
import {
  mapHtmlPlaceholders,
  mapPlaceholders,
  mapTextCells,
  placeholderDate,
  placeholderTarget,
  placeholderValue,
  showKey,
  storeKey,
  type PlaceholderFormat,
} from "./record-placeholders";
import type { Field, Identity, Page, Row } from "./types";

type Cells = Record<string, unknown>;
export type ApplyMode = "empty" | "append";
export const applyModeSchema = z.enum(["empty", "append"]).default("empty");

const fieldsOf = (pageId: string) =>
  JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]") as Field[];

// Properties a template cannot carry: computed or kept by the system.
const COMPUTED = new Set(["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "time"]);

/* ---------- Storing and editing templates ---------- */

// Editing: the stored ids as the current names again.
export function showTemplatePlaceholders(html: string, cells: Cells, fields: Field[]) {
  return {
    html: mapHtmlPlaceholders(html, (key) => showKey(key, fields)),
    cells: mapTextCells(cells, fields, (text) => mapPlaceholders(text, (key) => showKey(key, fields))),
  };
}

// A template as a draft record to edit (row.create with rawTemplate).
export function rawTemplate(template: RowTemplate, fields: Field[]) {
  const shown = showTemplatePlaceholders(template.html, JSON.parse(template.cells) as Cells, fields);
  return { html: shown.html, cells: JSON.stringify(shown.cells) };
}

// Names in the stored templates of a database as ids (before a rename,
// with the properties as they were).
export function storeTemplateNames(pageId: string, fields: Field[]) {
  const store = (key: string) => storeKey(key, fields);
  for (const t of all<{ id: string; cells: string; html: string }>("SELECT id,cells,html FROM row_templates WHERE page_id=?", pageId)) {
    if (!t.html.includes("{{") && !t.cells.includes("{{")) continue;
    const html = mapHtmlPlaceholders(t.html, store);
    const cells = JSON.stringify(mapTextCells(JSON.parse(t.cells) as Cells, fields, (text) => mapPlaceholders(text, store)));
    if (html !== t.html || cells !== t.cells) run("UPDATE row_templates SET html=?,cells=? WHERE id=?", html, cells, t.id);
  }
}

/* ---------- Values of a record ---------- */

const names = (ids: string[]) =>
  ids.length
    ? new Map(
        all<{ id: string; name: string }>(
          `SELECT id,name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();

function formatFor(actor: Identity | null, zone: string): PlaceholderFormat {
  const people = new Map<string, string>();
  return {
    tag: localeTag(contentLocale()),
    zone,
    person: (uid) => {
      if (!people.has(uid)) people.set(uid, names([uid]).get(uid) || "");
      return people.get(uid)!;
    },
    // Titles of the related records the person may see.
    relation: (field, ids) => {
      if (!field.relationPage || !ids.length) return [];
      const target = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", field.relationPage);
      if (!target || (actor && !pageRole(actor, target))) return [];
      const hidden = actor ? hiddenRowIds(actor, target) : new Set<string>();
      const titleId = fieldsOf(target.id)[0]?.id || "title";
      const rows = new Map(
        all<{ id: string; cells: string }>(
          `SELECT id,cells FROM rows WHERE page_id=? AND id IN (${ids.map(() => "?").join(",")})`,
          target.id,
          ...ids,
        ).map((r) => [r.id, cellText(JSON.parse(r.cells)[titleId])]),
      );
      return ids.filter((rid) => rows.has(rid) && !hidden.has(rid)).map((rid) => rows.get(rid)!);
    },
    file: (url) => {
      const fid = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url)?.[1];
      return (fid && one<{ name: string }>("SELECT name FROM files WHERE id=?", fid)?.name) || url.split("/").pop() || url;
    },
  };
}

export type PlaceholderRecord = Pick<Row, "id" | "page_id" | "created_by" | "created_at" | "updated_at" | "updated_by"> & {
  number?: number | null;
  cells: Cells;
};

// The text each placeholder becomes for one record. Properties only some
// people may read stay empty: the text is seen by everyone who sees the
// record.
export function placeholderResolver(page: Page, fields: Field[], record: PlaceholderRecord, actor: Identity | null, zone?: string) {
  const tz = zone && validZone(zone) ? zone : browserZone();
  const fmt = formatFor(actor, tz);
  const row = { ...record, number: record.number ?? null } as Row;
  const values = computedCells(row, fields);
  const now = Temporal.Now.plainDateTimeISO(tz);
  return (key: string): string | undefined => {
    const target = placeholderTarget(key, fields);
    if (!target) return undefined;
    if ("gone" in target) return "";
    // Formatted text (#126) as plain text: documents, titles and messages
    // take it as text (fillCells escapes it again for formatted text).
    if ("field" in target)
      return readRestricted(target.field)
        ? ""
        : placeholderValue(target.field, isFormattedText(target.field, fields) ? toPlain(values[target.field.id]) : values[target.field.id], fmt);
    switch (target.builtin) {
      case "title":
        return fields[0] ? placeholderValue(fields[0], values[fields[0].id], fmt) : "";
      case "today":
        return placeholderDate(now.toPlainDate().toString(), fmt);
      case "now":
        return placeholderDate(now.toString({ smallestUnit: "minute" }), fmt);
      case "creator":
        return record.created_by ? fmt.person!(record.created_by) : "";
      case "me":
        return actor?.name || "";
      case "database":
        return page.title || "";
    }
  };
}

// Text properties from a template with their placeholders filled.
function fillCells(cells: Cells, keys: Set<string>, fields: Field[], resolve: (key: string) => string | undefined) {
  const next = { ...cells };
  for (const f of fields)
    if (keys.has(f.id) && f.type === "text" && typeof next[f.id] === "string")
      next[f.id] = mapPlaceholders(
        next[f.id] as string,
        isFormattedText(f, fields)
          ? (key) => {
              const value = resolve(key);
              return value === undefined ? undefined : escapeInline(value);
            }
          : resolve,
      );
  return next;
}

/* ---------- A new record from a template ---------- */

// After a record was stored with a template's cells and before its
// document: fills the placeholders in the cells that came from the
// template (unchanged) and returns the template's text for the document.
export function fillNewRecord(input: { page: Page; rowId: string; template: RowTemplate; actor: Identity | null; zone?: string }) {
  const fields = fieldsOf(input.page.id);
  const raw = one<Row & { cells: string }>("SELECT * FROM rows WHERE id=?", input.rowId);
  if (!raw) return input.template.html;
  const cells = JSON.parse(raw.cells) as Cells;
  const fromTemplate = JSON.parse(input.template.cells) as Cells;
  const keys = new Set(Object.keys(fromTemplate).filter((k) => cells[k] === fromTemplate[k]));
  const record = { ...raw, cells };
  const filled = fillCells(cells, keys, fields, placeholderResolver(input.page, fields, record, input.actor, input.zone));
  if (JSON.stringify(filled) !== JSON.stringify(cells))
    run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify(filled), input.rowId);
  return mapHtmlPlaceholders(input.template.html, placeholderResolver(input.page, fields, { ...record, cells: filled }, input.actor, input.zone));
}

// The template's cells for a record that is not stored yet (pages turned
// into records): text cells with placeholders filled from these cells.
export function fillTemplateCells(page: Page, cells: Cells, keys: Iterable<string>, actor: Identity | null) {
  const fields = fieldsOf(page.id);
  const record: PlaceholderRecord = {
    id: "",
    page_id: page.id,
    created_by: actor?.id || "",
    updated_by: actor?.id || "",
    created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    cells,
  };
  return fillCells(cells, new Set(keys), fields, placeholderResolver(page, fields, record, actor));
}

/* ---------- An existing record ---------- */

// No text, no picture, no embed: what counts as an empty record document.
export function emptyDocument(html: string) {
  if (/<(img|iframe|video|audio|hr|svg|object|table)\b|data-(mermaid|drawing|url|src|file)=/i.test(html)) return false;
  return !html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
}

export type ApplyResult = {
  // "skipped": the record has text and the template only fills empty ones.
  document: "applied" | "appended" | "skipped";
  // Properties the template filled (were empty before).
  cells: Cells;
};

// The template on an existing record: empty properties get its values,
// the document its text (empty document) or the text below (append).
// `keep` decides which template properties may be written (permissions).
// The caller stores `cells`; the document is stored here, after a version
// of the previous text (`snapshotId`) when there was one.
export function applyTemplate(input: {
  page: Page;
  row: Row;
  template: RowTemplate;
  actor: Identity | null;
  mode: ApplyMode;
  zone?: string;
  keep?: (field: Field, value: unknown) => unknown | undefined;
  snapshotId?: string;
  strict?: boolean;
}): ApplyResult {
  const { page, row, template } = input;
  const fields = fieldsOf(page.id);
  const current = (typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells) as Cells;
  const fromTemplate = JSON.parse(template.cells) as Cells;
  let patch: Cells = {};
  for (const [key, value] of Object.entries(fromTemplate)) {
    const field = fields.find((f) => f.id === key);
    if (!field || COMPUTED.has(field.type) || isEmptyValue(value, field.type) || !isEmptyValue(current[key], field.type)) continue;
    const kept = input.keep ? input.keep(field, value) : value;
    if (kept !== undefined) patch[key] = kept;
  }
  const record = { ...row, cells: { ...current, ...patch } };
  patch = fillCells(patch, new Set(Object.keys(patch)), fields, placeholderResolver(page, fields, record, input.actor, input.zone));
  const d = ensureRowDocument(row);
  const empty = emptyDocument(d.html);
  if (!empty && input.mode === "empty") {
    if (input.strict)
      throw new HttpError(409, "Der Eintrag hat schon Inhalt. Wähle „Unten anhängen“, um die Vorlage darunter einzufügen.");
    return { document: "skipped", cells: patch };
  }
  const text = mapHtmlPlaceholders(
    template.html,
    placeholderResolver(page, fields, { ...record, cells: { ...current, ...patch } }, input.actor, input.zone),
  );
  if (input.snapshotId || !empty)
    run(
      "INSERT INTO row_snapshots(id,row_id,state,html,created_by,kind) VALUES(?,?,?,?,?,'auto')",
      input.snapshotId || id(),
      row.id,
      d.state,
      d.html,
      input.actor?.id || null,
    );
  replaceRowDocument(row.id, empty ? text : d.html + text, input.actor?.id || row.updated_by || row.created_by);
  return { document: empty ? "applied" : "appended", cells: patch };
}

// row.template.apply: by hand, for people who may edit the record.
export const applyCommandSchema = z.object({
  rowId: z.uuid(),
  templateId: z.uuid(),
  mode: applyModeSchema,
  timeZone: z.string().max(100).optional(),
  // The version of the previous text, so "Undo" can bring it back.
  snapshotId: z.uuid().optional(),
});
export function templateForApply(pageId: string, templateId: string) {
  const template = one<RowTemplate>("SELECT * FROM row_templates WHERE id=? AND page_id=?", templateId, pageId);
  if (!template) throw new HttpError(404, "Datensatzvorlage nicht gefunden.");
  return template;
}
export function prepareManualApply(user: Identity, pageId: string, body: unknown) {
  const input = applyCommandSchema.parse(body);
  if (input.snapshotId && one("SELECT 1 FROM row_snapshots WHERE id=?", input.snapshotId))
    throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
  const { page, row } = requireRow(user, pageId, input.rowId, true);
  return { input, page, row, template: templateForApply(page.id, input.templateId) };
}

// Recorded in the audit log with the template's name.
export function auditApply(actor: string, rowId: string, template: RowTemplate, how: string) {
  audit(actor, "row.template.applied", rowId, `${template.name} (${how})`.slice(0, 300));
}
