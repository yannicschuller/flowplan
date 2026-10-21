// Markdown files with YAML frontmatter into the records of a database (as
// Obsidian keeps notes): the title from "title:", the first heading or the
// file name, properties from the frontmatter by name, the rest as the
// record document. Missing properties can be created with a guessed type.
import { assertFieldsWritable } from "./field-access";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { all, id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { readZip } from "./archive";
import { htmlState } from "./document-server";
import { markdownToHtml } from "./markdown-import";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import { cellText } from "./cell-text";
import { autoDatabaseSnapshot } from "./database-operations";
import { rowCreated } from "./automations";
import { assertRowAccess } from "./row-access";
import { replaceRowDocument, snapshotRow } from "./row-documents";
import { splitFrontmatter, type FrontmatterValue } from "./frontmatter";
import { aliasField, aliasList, frontmatterAliases } from "./aliases";
import { computedTypes } from "./markdown-export";
import { exportTitle, importDate } from "./zip-import";
import type { Field, Identity, Page } from "./types";

export const MAX_MARKDOWN_RECORDS = 5000;
const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
};

// The files of an upload: one Markdown file or a ZIP with several.
export async function markdownEntries(name: string, bytes: Buffer) {
  if (/\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b))
    return readZip(bytes, { foreign: true, maxEntries: 12000 });
  return new Map([[posix.basename(name.replaceAll("\\", "/")) || "import.md", bytes]]);
}

const ALIASES_KEY = "aliases",
  ALIAS_KEYS = ["aliases", "alias"];
type Parsed = { path: string; title: string; values: Map<string, FrontmatterValue>; body: string; flowplanId?: string };
const lower = (text: string) => text.trim().toLocaleLowerCase("de");
const isList = (value: FrontmatterValue): value is FrontmatterValue[] => Array.isArray(value);
const asText = (value: FrontmatterValue): string =>
  value === null ? "" : isList(value) ? value.map(asText).filter(Boolean).join(", ") : typeof value === "object" ? "" : String(value);
// "[[Note]]" and "[Note](note.md)" in a list of relations mean the title.
const linkTitle = (text: string) =>
  text
    .replace(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/, "$1")
    .replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1")
    .trim();

function parse(path: string, text: string, titleNames: string[]): Parsed {
  const { data, body } = splitFrontmatter(text);
  const values = new Map<string, FrontmatterValue>();
  let title = "";
  // The id of a record exported from Flowplan (below "flowplan:").
  const meta = Object.entries(data).find(([key]) => lower(key) === "flowplan")?.[1];
  const flowplanId =
    meta && typeof meta === "object" && !Array.isArray(meta) && typeof meta.id === "string" && /^[0-9a-f-]{36}$/i.test(meta.id)
      ? meta.id
      : undefined;
  // Obsidian's "aliases:" and "alias:" fill the aliases property together.
  const aliases = frontmatterAliases(data);
  if (aliases.length) values.set(ALIASES_KEY, aliases);
  for (const [key, value] of Object.entries(data)) {
    if (lower(key) === "flowplan" || value === null || ALIAS_KEYS.includes(lower(key))) continue;
    if (!title && titleNames.includes(lower(key)) && !isList(value) && typeof value !== "object") title = asText(value);
    else values.set(key, value);
  }
  let rest = body.replace(/^\s*\n/, "");
  const heading = /^#\s+([^\n]+)\n?/.exec(rest);
  if (heading && (!title || lower(heading[1]) === lower(title))) {
    title ||= heading[1].trim();
    rest = rest.slice(heading[0].length);
  }
  title ||= exportTitle(posix.basename(path));
  return { path, title: title.slice(0, 1000), values, body: rest.trim(), flowplanId };
}

// The type a new property gets from the values of all files.
export function guessType(values: FrontmatterValue[]): Pick<Field, "type" | "options"> {
  const filled = values.filter((v) => v !== null && v !== "" && !(isList(v) && !v.length));
  if (filled.some(isList)) {
    const options = [...new Set(filled.flatMap((v) => (isList(v) ? v : [v])).map(asText).filter(Boolean))];
    return { type: "multiselect", options: options.slice(0, 200) };
  }
  if (filled.length && filled.every((v) => typeof v === "boolean")) return { type: "checkbox" };
  if (filled.length && filled.every((v) => typeof v === "number")) return { type: "number" };
  const texts = filled.map(asText);
  if (texts.length && texts.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && importDate(v))) return { type: "date" };
  if (texts.length && texts.every((v) => /^https?:\/\/\S+$/i.test(v))) return { type: "url" };
  const distinct = [...new Set(texts)];
  if (distinct.length && distinct.length <= 12 && texts.length >= distinct.length * 2 && distinct.every((v) => v.length <= 60))
    return { type: "select", options: distinct };
  return { type: "text" };
}

export type MarkdownImportPlan = {
  records: number;
  matched: string[];
  missing: { name: string; type: Field["type"] }[];
  skipped: string[];
  // Files exported from this database whose record still exists.
  existing: number;
};

export type MarkdownImportResult = MarkdownImportPlan & { created?: number; updated?: number; fieldsCreated?: string[]; files?: number };
export function importMarkdownRecords(
  user: Identity,
  pageId: string,
  entries: Map<string, Buffer>,
  options: { dryRun?: boolean; createMissing?: boolean; updateExisting?: boolean } = {},
): MarkdownImportResult {
  const page = requirePage(user, pageId, true);
  requireUnlocked(user, page);
  if (page.kind !== "database") throw new HttpError(400, "Nur in eine Datenbank.");
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  let paths = [...entries.keys()].filter((p) => /\.(md|markdown)$/i.test(p) && !p.split("/").some((part) => part.startsWith(".")));
  // A Flowplan export: the records are in records/, index.md is the table.
  if (paths.some((p) => p.startsWith("records/"))) paths = paths.filter((p) => p.startsWith("records/"));
  if (!paths.length) throw new HttpError(400, "Keine Markdown-Dateien gefunden.");
  if (paths.length > MAX_MARKDOWN_RECORDS) throw new HttpError(413, `Maximal ${MAX_MARKDOWN_RECORDS} Einträge je Import.`);
  const raw = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!;
  const fields = JSON.parse(raw.fields) as Field[];
  const titleField = fields[0];
  const parsed = paths
    .sort((a, b) => a.localeCompare(b, "de"))
    .map((path) => parse(path, entries.get(path)!.toString("utf8"), ["title", lower(titleField?.name || "title")]));
  // Frontmatter keys to properties, by name and case-insensitive; aliases
  // go to the aliases property, whatever its name.
  const byName = new Map(fields.map((f) => [lower(f.name), f]));
  let current = fields;
  const aliasTarget = () => aliasField(current);
  const fieldFor = (key: string) => (lower(key) === ALIASES_KEY ? aliasTarget() || byName.get(key) : byName.get(lower(key)));
  const keys = new Map<string, { name: string; values: FrontmatterValue[] }>();
  for (const file of parsed)
    for (const [key, value] of file.values) {
      const entry = keys.get(lower(key)) || { name: key.slice(0, 200), values: [] };
      entry.values.push(value);
      keys.set(lower(key), entry);
    }
  // Records of this database the files came from (round trip), as far as
  // the person may change them.
  const existing = new Map<string, { id: string; access: string; created_by: string }>();
  for (const file of parsed) {
    if (!file.flowplanId) continue;
    const row = one<{ id: string; access: string; created_by: string }>(
      "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
      file.flowplanId,
      page.id,
    );
    if (!row) continue;
    try {
      assertRowAccess(user, page, row, true);
      existing.set(file.path, row);
    } catch {}
  }
  const plan: MarkdownImportPlan = { records: parsed.length, matched: [], missing: [], skipped: [], existing: existing.size };
  for (const [key, entry] of keys) {
    const field = fieldFor(key);
    if (!field) plan.missing.push(key === ALIASES_KEY ? { name: "Aliases", type: "aliases" } : { name: entry.name, type: guessType(entry.values).type });
    else if (computedTypes.includes(field.type) || field.type === "sprint" || field === titleField) plan.skipped.push(field.name);
    else plan.matched.push(field.name);
  }
  if (options.dryRun) return plan;

  return transaction(() => {
    autoDatabaseSnapshot(user, page);
    const next = structuredClone(fields);
    current = next;
    byName.clear();
    for (const field of next) byName.set(lower(field.name), field);
    const titleField = next[0];
    if (options.createMissing)
      for (const missing of plan.missing.slice(0, 80)) {
        const field: Field =
          missing.type === "aliases"
            ? { id: `f${id().slice(0, 8)}`, name: missing.name, type: "aliases" }
            : { id: `f${id().slice(0, 8)}`, name: missing.name, ...guessType(keys.get(lower(missing.name))!.values) };
        next.push(field);
        if (!byName.has(lower(field.name))) byName.set(lower(field.name), field);
      }
    // Records of related databases, by title, as far as the person may read them.
    const related = new Map<string, Map<string, string>>();
    const relatedTitles = (target: string) => {
      if (!related.has(target)) {
        const map = new Map<string, string>();
        const targetPage = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", target);
        if (targetPage && pageRole(user, targetPage)) {
          const targetFields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", target)?.fields || "[]") as Field[];
          for (const row of all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? ORDER BY position", target)) {
            const name = lower(cellText((JSON.parse(row.cells) as Record<string, unknown>)[targetFields[0]?.id || "title"]));
            if (name && !map.has(name)) map.set(name, row.id);
          }
        }
        related.set(target, map);
      }
      return related.get(target)!;
    };
    const members = all<{ id: string; name: string; email: string }>(
      "SELECT u.id,u.name,u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=?",
      page.workspace_id,
    );
    const member = (text: string) => members.find((m) => lower(m.name) === lower(text) || lower(m.email) === lower(text))?.id;
    // Unknown choices become new options.
    const option = (field: Field, text: string) => {
      const value = text.slice(0, 200);
      if (!value) return null;
      const known = field.options?.find((o) => lower(o) === lower(value));
      if (known) return known;
      if ((field.options?.length || 0) >= 200) return null;
      field.options = [...(field.options || []), value];
      return value;
    };
    const cellOf = (field: Field, value: FrontmatterValue): unknown => {
      const list = (isList(value) ? value : [value]).map(asText).map((v) => v.trim()).filter(Boolean);
      const text = asText(value).trim();
      switch (field.type) {
        case "number": {
          const n = typeof value === "number" ? value : Number(text.replace(",", "."));
          return text && Number.isFinite(n) ? n : undefined;
        }
        case "checkbox":
          return typeof value === "boolean" ? value : /^(true|yes|ja|1|x)$/i.test(text);
        case "date":
          return importDate(text) ?? undefined;
        case "select":
          return option(field, list[0] || "") ?? undefined;
        case "multiselect":
          return [...new Set(list.flatMap((v) => (isList(value) ? [v] : v.split(",").map((x) => x.trim()))).map((v) => option(field, v)).filter((v): v is string => !!v))];
        case "person": {
          const ids = list.map(member).filter((v): v is string => !!v);
          return ids[0];
        }
        case "relation": {
          if (!field.relationPage) return undefined;
          const titles = relatedTitles(field.relationPage);
          const ids = [...new Set(list.map((v) => titles.get(lower(linkTitle(v)))).filter((v): v is string => !!v))];
          return field.parent ? ids.slice(0, 1) : ids.slice(0, 500);
        }
        case "aliases":
          return aliasList(isList(value) ? list : text.split(","));
        case "checklist":
          return list.slice(0, 100).map((v) => {
            const done = /^\[[xX]\]\s*/.test(v);
            return { text: v.replace(/^\[[ xX]?\]\s*/, "").slice(0, 500), done };
          });
        case "files":
          return undefined;
        case "text":
        case "url":
        case "email":
        case "phone":
          return text.slice(0, 10000) || undefined;
        default:
          return undefined;
      }
    };
    // Record ids first, so links between the imported files point to records.
    const update = (file: Parsed) => (options.updateExisting ? existing.get(file.path) : undefined);
    const rowIds = new Map(parsed.map((file) => [file.path, update(file)?.id || id()]));
    const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
    const uploaded = new Map<string, string>();
    let bytesAdded = 0;
    const resolver = (from: string) => (href: string, kind: "link" | "image") => {
      if (/^(https?:|mailto:)/i.test(href)) return href;
      if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
      let target: string;
      try {
        target = posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(href.split("#")[0])));
      } catch {
        return null;
      }
      const record = rowIds.get(target) || rowIds.get(`${target}.md`);
      if (record && kind === "link") return `/#page=${page.id}&row=${record}`;
      const data = entries.get(target);
      if (!data || /\.(md|markdown)$/i.test(target)) return null;
      if (uploaded.has(target)) return uploaded.get(target)!;
      const fid = id(),
        ext = target.split(".").pop()!.toLowerCase();
      bytesAdded += data.length;
      enforceQuota(page.workspace_id, bytesAdded);
      enforceUserStorage(user, bytesAdded);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, fid), data);
      onTransactionRollback(() => unlinkSync(resolve(dir, fid)));
      run(
        "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
        fid,
        page.id,
        posix.basename(target).slice(0, 200),
        mimeTypes[ext] || "application/octet-stream",
        data.length,
        user.id,
      );
      const url = `/api/files/${fid}`;
      uploaded.set(target, url);
      return url;
    };
    const start = Date.now();
    const created: string[] = [];
    const rows = parsed.map((file) => {
      const cells: Record<string, unknown> = { [titleField?.id || "title"]: file.title };
      for (const [key, value] of file.values) {
        const field = fieldFor(key);
        if (!field || field === titleField || computedTypes.includes(field.type) || field.type === "sprint") continue;
        const cell = cellOf(field, value);
        if (cell !== undefined && !(Array.isArray(cell) && !cell.length && field.type !== "multiselect")) cells[field.id] = cell;
      }
      return { file, cells };
    });
    // Properties this person may not change (lib/field-access.ts).
    assertFieldsWritable(user, page, next, new Set(rows.flatMap((r) => Object.keys(r.cells))));
    if (JSON.stringify(next) !== raw.fields)
      run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(next), page.id);
    let updated = 0;
    rows.forEach(({ file, cells }, i) => {
      const rid = rowIds.get(file.path)!;
      const html = file.body ? markdownToHtml(file.body, resolver(file.path)) : "";
      // Round trip: the exported record gets the file's values and text.
      if (update(file)) {
        const before = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells) as Record<string, unknown>;
        const merged = JSON.stringify({ ...before, ...cells });
        if (merged.length > 200000) throw new HttpError(413, `${file.path}: Datensatz zu groß.`);
        run("UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP,updated_by=? WHERE id=?", merged, user.id, rid);
        snapshotRow(user, page.id, rid);
        replaceRowDocument(rid, html, user.id);
        updated++;
        return;
      }
      const serialized = JSON.stringify(cells);
      if (serialized.length > 200000) throw new HttpError(413, `${file.path}: Datensatz zu groß.`);
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content) VALUES(?,?,?,?,?,?,?)",
        rid,
        page.id,
        serialized,
        start + i,
        user.id,
        user.id,
        html,
      );
      if (html) run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rid, htmlState(html), html, id());
      created.push(rid);
    });
    run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", page.id);
    for (const rid of created) rowCreated(user, page, rid);
    return {
      ...plan,
      created: created.length,
      updated,
      fieldsCreated: options.createMissing ? plan.missing.slice(0, 80).map((m) => m.name) : [],
      files: uploaded.size,
    };
  }, user);
}
