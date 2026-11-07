// db-dialect-scan: sqlite-only file – reads AFFiNE's own SQLite files.
// Reads an AFFiNE workspace export into a plain model (no Yjs types left)
// that lib/importers/affine.ts turns into pages. Two exports exist:
//
// 1. The workspace file ".affine" (desktop app: "Export workspace"). It is
//    a SQLite database (verified in AFFiNE's source, packages/frontend/
//    native/schema and apps/electron/src/helper/dialog/dialog.ts, which
//    VACUUMs the workspace database into the chosen file):
//    - version 2 (nbstore, current): tables meta(space_id), snapshots(doc_id,
//      data, created_at, updated_at), updates(doc_id, created_at, data),
//      clocks, blobs(key, data, mime, size, created_at, deleted_at), …
//      A document is its snapshot plus its updates in order of created_at;
//      the workspace's root document has the space id as doc_id.
//    - version 1 (older desktop apps): updates(id, data, timestamp, doc_id),
//      blobs(key, data, timestamp), version_info, …; the root document has
//      no doc_id, the others their sub-document guid.
//    Every "data" is a Yjs update (encoding v1).
// 2. The BlockSuite snapshot ZIP ("Export → Snapshot", ZipTransformer in
//    blocksuite/affine/widgets/linked-doc/src/transformers/zip.ts): one
//    "<title>-<id>.snapshot.json" per document ({type: "page", meta, blocks})
//    and the files as "assets/<blob id>.<ext>" (a blob id with "/" makes a
//    sub-folder). Versions before January 2025 add an info.json with the
//    workspace's tags ({properties: {tags: {options}}}) and keep the tag ids
//    in meta.tags; since then BlockSuite's Transformer writes "tags: []" and
//    no info.json (framework/store/src/transformer/transformer.ts
//    _exportDocMeta). Folders, collections, journals, properties and icons
//    are never part of it (#82).
//
// The Yjs documents (verified against the BlockSuite / AFFiNE sources):
// - root document: map "meta" {name, pages: [{id, title, createDate,
//   updatedDate, tags: [tag id], trash}], properties: {tags: {options:
//   [{id, value, color}]}}}; map "setting" {collections: [{id, name, rules:
//   {filters: [{type, key, method, value}]}, allowList: [doc id]}]} (older:
//   filterList instead of rules); map "affine:workspace-properties"
//   {pageProperties: {<doc id>: {system: {journal: {value}}}}} (legacy
//   journal dates); map "spaces" {<doc id>: sub document} (older versions).
// - a document (doc_id = its id): map "blocks" {<block id>: Y.Map with
//   "sys:id", "sys:flavour", "sys:children" (Y.Array of ids) and "prop:<name>"
//   per property; texts are Y.Text with Quill deltas, objects Y.Map, arrays
//   Y.Array, "Boxed" values a Y.Map {type: "$blocksuite:internal:native$",
//   value}. Blocks with flat data (affine:table) store nested properties as
//   "prop:cells.<row>:<column>.text".
// - workspace database (AFFiNE's ORM on Yjs, one document per table):
//   "db$folders" (folders and the links in them: {id, parentId, type:
//   folder|doc|tag|collection, data: name or target id, index}),
//   "db$docProperties" ({id, journal: "YYYY-MM-DD", primaryMode,
//   isTemplate: boolean (a template, #116), …, "custom:<property id>": value
//   as text}), "db$docCustomPropertyInfo"
//   (the properties: {id, name, type: text|number|checkbox|date|…,
//   isDeleted}), "db$explorerIcon" ({id: "doc|folder|collection|tag:<id>",
//   icon: {type: "emoji", unicode} | {type: "affine-icon", name, color}});
//   every row is a top-level map named by its key, deleted rows carry
//   "$$DELETED". Favourites: "userdata$<user>$favorite" ({key: "doc:<id>"}).
//   Older workspaces keep properties in the root document's map
//   "affine:workspace-properties": schema.pageProperties.custom {<id>: {name,
//   type}} and pageProperties {<doc id>: {custom: {<id>: {value}}}}
//   (packages/frontend/core/src/modules/db/schema/schema.ts,
//   doc/stores/doc-properties.ts, explorer-icon/store/explorer-icon.ts).
//
// Everything here is untrusted: sizes, counts and nesting are bounded, a
// document that cannot be read is skipped with a warning, and object keys
// that could reach a prototype are dropped.
//
// Large workspace files (#76, #82): a file on disk (the upload, streamed
// there) is opened in place; a document is read from it when it is
// converted and its files (blobs) when the import writes them – memory holds
// one document and one file at a time, plus the converted pages.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { HttpError } from "../auth";
import { mimeOf } from "./html";
import { maxImportFiles, tooManyFiles } from "./types";

// How many documents and files an import may bring is set per instance
// (lib/importers/types.ts maxImportPages, maxImportFiles).
export const AFFINE_LIMITS = {
  docBytes: 32 * 1024 * 1024,
  totalDocBytes: 256 * 1024 * 1024,
  blocks: 20000,
  depth: 60,
  blobBytes: 100 * 1024 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
  textLength: 200_000,
  // Rows of the workspace file read for its documents (snapshots and
  // updates); a crafted file with more is refused.
  parts: 5_000_000,
  // Entries of the document list; far above any import limit.
  metas: 1_000_000,
};
const MB = 1024 * 1024;
// The limits for a workspace file of this size: documents (held in memory
// while they are converted) may grow with the file up to 1 GB, files
// (read one at a time) with the file itself. The base values stay the floor.
export function affineLimitsFor(fileBytes: number) {
  return {
    totalDocBytes: Math.max(AFFINE_LIMITS.totalDocBytes, Math.min(fileBytes, 1024 * MB)),
    blobBytes: Math.max(AFFINE_LIMITS.blobBytes, fileBytes),
  };
}
const TEXT_ID = "$blocksuite:internal:text$";
const NATIVE_ID = "$blocksuite:internal:native$";
const SURFACE_TEXT_ID = "affine:surface:text";
const SURFACE_YMAP_ID = "affine:surface:ymap";
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type DeltaOp = { insert: unknown; attributes?: Record<string, unknown> };
// A text (Y.Text or its JSON form) as its Quill delta.
export class AText {
  constructor(readonly delta: DeltaOp[]) {}
  get plain() {
    return this.delta.map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
  }
}
export type ABlock = { id: string; flavour: string; props: Record<string, unknown>; children: ABlock[] };
export type ADocMeta = {
  id: string;
  title: string;
  created?: number;
  updated?: number;
  tags: string[];
  trash: boolean;
};
// A document: its meta data, the blocks read when it is converted (null:
// not readable) – never all documents' blocks at once.
export type ADoc = ADocMeta & { load: () => ABlock | null };
// A property of documents (AFFiNE's "custom" doc properties).
export type AProperty = { name: string; type: string };
export type AFolderNode = { id: string; parentId: string | null; type: string; data: string; index: string };
export type AFilter = { type: string; key: string; method: string; value?: string };
export type ACollection = { id: string; name: string; filters: AFilter[]; allowList: string[] };
// A file of the workspace: its size, the first bytes (to recognise the type)
// and the content, read when needed (from the open workspace file).
export type ABlob = { size: number; mime: string; head: Buffer; read: () => Buffer };
export const memoryBlob = (data: Buffer, mime: string): ABlob => ({ size: data.length, mime, head: data.subarray(0, 16), read: () => data });
export type AffineFormat = "sqlite-v2" | "sqlite-v1" | "snapshot";
export type AWorkspace = {
  format: AffineFormat;
  name: string;
  docs: ADoc[];
  tags: Map<string, { name: string; color?: string }>;
  folders: AFolderNode[];
  collections: ACollection[];
  // Per document: journal date, primary mode (page/edgeless), …
  docProps: Map<string, Record<string, unknown>>;
  // Property definitions by id; values are docProps["custom:<id>"].
  properties: Map<string, AProperty>;
  // Icons by "doc:<id>", "folder:<id>", "collection:<id>": an emoji, or
  // "affine-icon" for one of AFFiNE's own symbols (not taken over).
  icons: Map<string, string>;
  favorites: Set<string>;
  blobs: Map<string, ABlob>;
  warnings: string[];
  // Closes the workspace file once the import no longer reads files from it.
  close?: () => void;
};

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
export const isSqlite = (bytes: Buffer) => bytes.length >= 100 && bytes.subarray(0, 16).equals(SQLITE_HEADER);
export const isSnapshotZip = (entries: Map<string, Buffer>) => [...entries.keys()].some((name) => /\.snapshot\.json$/i.test(name));

/* ---------- plain values from Yjs and from snapshot JSON ---------- */

const record = () => Object.create(null) as Record<string, unknown>;
function setPath(target: Record<string, unknown>, path: string[], value: unknown) {
  let node = target;
  for (const [i, part] of path.entries()) {
    if (UNSAFE_KEYS.has(part)) return;
    if (i === path.length - 1) node[part] = value;
    else {
      const next = node[part];
      if (!next || typeof next !== "object" || next instanceof AText || Array.isArray(next)) node[part] = record();
      node = node[part] as Record<string, unknown>;
    }
  }
}
const clipDelta = (delta: unknown): DeltaOp[] => {
  if (!Array.isArray(delta)) return [];
  let left = AFFINE_LIMITS.textLength;
  const out: DeltaOp[] = [];
  for (const op of delta.slice(0, 20000)) {
    if (!op || typeof op !== "object" || left <= 0) continue;
    const { insert, attributes } = op as DeltaOp;
    const text = typeof insert === "string" ? insert.slice(0, left) : insert;
    if (typeof text === "string") left -= text.length;
    out.push({ insert: text, ...(attributes && typeof attributes === "object" ? { attributes: plainJson(attributes, 0) as Record<string, unknown> } : {}) });
  }
  return out;
};
// Plain JSON values (already decoded); keys that could reach a prototype go.
function plainJson(value: unknown, depth: number): unknown {
  if (depth > AFFINE_LIMITS.depth) return undefined;
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (value instanceof AText) return value;
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100000).map((item) => plainJson(item, depth + 1));
  const out = record();
  for (const [key, item] of Object.entries(value)) if (!UNSAFE_KEYS.has(key)) out[key] = plainJson(item, depth + 1);
  return out;
}
// A Yjs value as plain data; texts become AText, boxed values their content.
export function fromY(value: unknown, depth = 0): unknown {
  if (depth > AFFINE_LIMITS.depth) return undefined;
  if (value instanceof Y.Text) return new AText(clipDelta(value.toDelta()));
  if (value instanceof Y.Map) {
    if (value.get("type") === NATIVE_ID && value.has("value")) return fromY(value.get("value"), depth + 1);
    const out = record();
    for (const [key, item] of value.entries()) if (!UNSAFE_KEYS.has(key)) out[key] = fromY(item, depth + 1);
    return out;
  }
  if (value instanceof Y.Array) return value.toArray().slice(0, 100000).map((item) => fromY(item, depth + 1));
  if (value instanceof Y.AbstractType || value instanceof Y.Doc) return undefined;
  return plainJson(value, depth);
}
// The same for a snapshot's JSON (markers instead of Yjs types).
export function fromSnapshotJson(value: unknown, depth = 0): unknown {
  if (depth > AFFINE_LIMITS.depth) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100000).map((item) => fromSnapshotJson(item, depth + 1));
  const object = value as Record<string, unknown>;
  if (object[TEXT_ID] === true || object[SURFACE_TEXT_ID] === true) return new AText(clipDelta(object.delta));
  if (object[NATIVE_ID] === true) return fromSnapshotJson(object.value, depth + 1);
  if (object[SURFACE_YMAP_ID] === true) return fromSnapshotJson(object.json, depth + 1);
  const out = record();
  for (const [key, item] of Object.entries(object)) if (!UNSAFE_KEYS.has(key)) out[key] = fromSnapshotJson(item, depth + 1);
  return out;
}

/* ---------- blocks ---------- */

function blockTree(nodes: Map<string, { flavour: string; props: Record<string, unknown>; children: string[] }>, rootId: string) {
  const seen = new Set<string>();
  const build = (id: string, depth: number): ABlock | null => {
    const node = nodes.get(id);
    if (!node || seen.has(id) || depth > AFFINE_LIMITS.depth) return null;
    seen.add(id);
    return {
      id,
      flavour: node.flavour,
      props: node.props,
      children: node.children.map((child) => build(child, depth + 1)).filter((b): b is ABlock => !!b),
    };
  };
  return build(rootId, 0);
}
// The block tree of a document's Y.Doc (map "blocks").
export function readDocBlocks(doc: Y.Doc): ABlock | null {
  const blocks = doc.getMap<unknown>("blocks");
  if (blocks.size > AFFINE_LIMITS.blocks) throw new Error("too many blocks");
  const nodes = new Map<string, { flavour: string; props: Record<string, unknown>; children: string[] }>();
  let rootId: string | null = null;
  for (const [id, value] of blocks.entries()) {
    if (!(value instanceof Y.Map)) continue;
    const flavour = value.get("sys:flavour");
    if (typeof flavour !== "string") continue;
    const children = value.get("sys:children");
    const props = record();
    for (const [key, item] of value.entries())
      if (key.startsWith("prop:")) setPath(props, key.slice(5).split(".").slice(0, 8), fromY(item));
    nodes.set(id, {
      flavour,
      props,
      children: children instanceof Y.Array ? children.toArray().filter((c): c is string => typeof c === "string") : [],
    });
    if (flavour === "affine:page" && !rootId) rootId = id;
  }
  return rootId ? blockTree(nodes, rootId) : null;
}
// The block tree of a snapshot ({type: "block", id, flavour, props, children}).
export function readSnapshotBlocks(raw: unknown): ABlock | null {
  const nodes = new Map<string, { flavour: string; props: Record<string, unknown>; children: string[] }>();
  let count = 0;
  const visit = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== "object" || depth > AFFINE_LIMITS.depth || ++count > AFFINE_LIMITS.blocks) return null;
    const block = node as { id?: unknown; flavour?: unknown; props?: unknown; children?: unknown };
    if (typeof block.id !== "string" || typeof block.flavour !== "string" || nodes.has(block.id)) return null;
    const entry = { flavour: block.flavour, props: (fromSnapshotJson(block.props) as Record<string, unknown>) || record(), children: [] as string[] };
    nodes.set(block.id, entry);
    if (Array.isArray(block.children))
      for (const child of block.children) {
        const id = visit(child, depth + 1);
        if (id) entry.children.push(id);
      }
    return block.id;
  };
  const rootId = visit(raw, 0);
  return rootId ? blockTree(nodes, rootId) : null;
}

/* ---------- workspace parts in the root document ---------- */

const str = (value: unknown, max = 1000) => (typeof value === "string" ? value.slice(0, max) : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
function docMetas(pages: unknown): ADocMeta[] {
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
    .slice(0, AFFINE_LIMITS.metas)
    .map((p) => ({
      id: str(p.id, 200),
      title: str(p.title, 500),
      created: num(p.createDate),
      updated: num(p.updatedDate),
      tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string").slice(0, 200) : [],
      trash: p.trash === true,
    }));
}
function tagOptions(properties: unknown) {
  const tags = new Map<string, { name: string; color?: string }>();
  const options = (properties as { tags?: { options?: unknown } } | undefined)?.tags?.options;
  if (Array.isArray(options))
    for (const option of options.slice(0, 2000))
      if (option && typeof option === "object" && typeof option.id === "string" && typeof option.value === "string" && option.value.trim())
        tags.set(option.id, { name: option.value.trim().slice(0, 100), ...(typeof option.color === "string" ? { color: option.color } : {}) });
  return tags;
}
// Collections in the current form ({rules: {filters}}) or the older one
// ({filterList: [{left: {name}, funcName, args}]}).
function collections(raw: unknown): ACollection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string")
    .slice(0, 500)
    .map((c) => {
      const rules = c.rules as { filters?: unknown } | undefined;
      const filters: AFilter[] = [];
      if (Array.isArray(rules?.filters))
        for (const f of rules.filters.slice(0, 50))
          if (f && typeof f === "object")
            filters.push({ type: str(f.type, 50), key: str(f.key, 200), method: str(f.method, 50), ...(f.value !== undefined ? { value: String(f.value).slice(0, 2000) } : {}) });
      if (!rules && Array.isArray(c.filterList))
        for (const f of c.filterList.slice(0, 50)) {
          const left = str((f as { left?: { name?: unknown } })?.left?.name, 100);
          const method = str((f as { funcName?: unknown })?.funcName, 50);
          const args = Array.isArray((f as { args?: unknown }).args)
            ? ((f as { args: unknown[] }).args as { value?: unknown }[]).map((a) => a?.value).filter((v) => v !== undefined && v !== null)
            : [];
          filters.push(legacyFilter(left, method, args));
        }
      return {
        id: str(c.id, 200),
        name: str(c.name, 200) || "?",
        filters,
        allowList: Array.isArray(c.allowList) ? c.allowList.filter((d): d is string => typeof d === "string").slice(0, 5000) : [],
      };
    });
}
// An old filter as AFFiNE migrates it (CollectionStore.migrateFilterList).
function legacyFilter(left: string, method: string, args: unknown[]): AFilter {
  const arg = args[0];
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if ((left === "Created" || left === "Updated") && typeof arg === "number") {
    const key = left === "Created" ? "createdAt" : "updatedAt";
    if (method === "after" || method === "before") return { type: "system", key, method, value: day(arg) };
    if (method === "last") return { type: "system", key, method: "after", value: day(Date.now() - arg * 86400e3) };
  }
  if (left === "Is Favourited" && method === "is") return { type: "system", key: "favorite", method: "is", value: arg ? "true" : "false" };
  if (left === "Is Public" && method === "is") return { type: "system", key: "shared", method: "is", value: arg ? "true" : "false" };
  if (left === "Tags") {
    const list = Array.isArray(arg) ? arg.filter((t) => typeof t === "string").join(",") : "";
    const tagMethods: Record<string, string> = {
      "is not empty": "is-not-empty",
      "is empty": "is-empty",
      "contains all": "include-all",
      "contains one of": "include-any-of",
      "does not contains all": "not-include-all",
      "does not contains one of": "not-include-any-of",
    };
    if (tagMethods[method]) return { type: "system", key: "tags", method: tagMethods[method], ...(list ? { value: list } : {}) };
  }
  return { type: "unknown", key: left || "?", method: method || "?" };
}
// The rows of one table of AFFiNE's Yjs ORM.
function tableRows(doc: Y.Doc) {
  const rows: Record<string, unknown>[] = [];
  for (const key of [...doc.share.keys()].slice(0, 20000)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const row = fromY(doc.getMap(key)) as Record<string, unknown>;
    if (!row || row.$$DELETED === true || !Object.keys(row).length) continue;
    rows.push(row);
  }
  return rows;
}

// Icons of the navigation (table "explorerIcon"): emojis, AFFiNE's own
// symbols only as a marker.
function explorerIcons(rows: Record<string, unknown>[]) {
  const icons = new Map<string, string>();
  for (const row of rows.slice(0, 50000)) {
    const icon = row.icon as { type?: unknown; unicode?: unknown } | undefined;
    if (typeof row.id !== "string" || !/^(doc|folder|collection|tag):/.test(row.id) || !icon || typeof icon !== "object") continue;
    if (icon.type === "emoji" && typeof icon.unicode === "string" && icon.unicode.trim()) icons.set(row.id.slice(0, 220), icon.unicode.trim().slice(0, 32));
    else if (icon.type === "affine-icon" || icon.type === "blob") icons.set(row.id.slice(0, 220), "affine-icon");
  }
  return icons;
}
// The value of a property as Flowplan takes it, or undefined. AFFiNE stores
// every value as text (checkbox "true"/"false", date "YYYY-MM-DD").
export function propertyValue(type: string, raw: unknown): string | number | boolean | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const text = typeof raw === "string" ? raw.trim().slice(0, 10000) : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";
  if (!text) return undefined;
  switch (type) {
    case "number":
    case "progress": {
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    }
    case "checkbox":
      return text === "true";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
    case "text":
      return text;
    default:
      // Tags, journal, mode, people, dates of creation: imported elsewhere
      // or not meaningful outside AFFiNE.
      return undefined;
  }
}

/* ---------- the workspace file (SQLite) ---------- */


// The documents of the workspace file: their keys, and their Yjs updates
// (snapshot first, then the updates in order) read when asked for.
type Sqlite = {
  format: "sqlite-v1" | "sqlite-v2";
  spaceId: string | null;
  keys: string[];
  updates: (key: string) => Uint8Array[] | null;
  blobs: Map<string, ABlob>;
  skippedBlobs: number;
  close: () => void;
};
// The workspace file: a path (opened in place, documents and files read
// when needed until close) or its bytes (copied to a private temp folder,
// everything read at once – the bytes are in memory anyway).
function readSqlite(input: Buffer | string): Sqlite {
  let dir: string | null = null;
  let path: string;
  let db: DatabaseSync | undefined;
  const close = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  };
  try {
    if (typeof input === "string") path = input;
    else {
      // node:sqlite opens files only.
      dir = mkdtempSync(join(tmpdir(), "flowplan-affine-"));
      path = join(dir, "workspace.affine");
      writeFileSync(path, input, { mode: 0o600 });
    }
    const lazy = typeof input === "string";
    const limits = affineLimitsFor(lazy ? statSync(path).size : input.length);
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA query_only=1; PRAGMA trusted_schema=0;");
    } catch {
      throw new HttpError(400, "Die AFFiNE-Datei kann nicht gelesen werden.");
    }
    const open = db;
    const tables = new Map<string, Set<string>>();
    try {
      // Only real tables count: views or triggers in a crafted file never run.
      for (const { name } of open.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(name)) continue;
        const columns = new Set((open.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name));
        tables.set(name, columns);
      }
    } catch {
      throw new HttpError(400, "Die AFFiNE-Datei kann nicht gelesen werden.");
    }
    const has = (table: string, ...columns: string[]) => columns.every((c) => tables.get(table)?.has(c));
    const v2 = has("snapshots", "doc_id", "data") && has("updates", "doc_id", "data", "created_at") && has("blobs", "key", "data", "mime");
    const v1 = !v2 && has("updates", "id", "data", "doc_id") && has("blobs", "key", "data");
    if (!v1 && !v2) throw new HttpError(400, "Die Datei ist keine AFFiNE-Arbeitsbereichsdatei.");
    // Sizes first, so a huge document is never read into memory.
    const tooLarge = new Set<string>();
    const sizes = v2
      ? `SELECT doc_id, SUM(n) n FROM (SELECT doc_id, length(data) n FROM snapshots UNION ALL SELECT doc_id, length(data) n FROM updates) GROUP BY doc_id`
      : `SELECT doc_id, SUM(length(data)) n FROM updates GROUP BY doc_id`;
    let total = 0;
    for (const row of open.prepare(sizes).all() as { doc_id: string | null; n: number }[]) {
      if (Number(row.n) > AFFINE_LIMITS.docBytes) tooLarge.add(row.doc_id ?? "");
      else total += Number(row.n) || 0;
    }
    // In memory, all documents together stay within the limit; read from
    // disk one at a time, a document only within its own.
    if (!lazy && total > limits.totalDocBytes) throw new HttpError(413, "Der AFFiNE-Arbeitsbereich ist zu groß.");
    let spaceId: string | null = null;
    if (v2 && has("meta", "space_id")) spaceId = (open.prepare("SELECT space_id FROM meta LIMIT 1").get() as { space_id?: string } | undefined)?.space_id ?? null;
    // Where each document's rows are (row ids only, never the data).
    type Part = [table: 0 | 1, row: number];
    const parts = new Map<string, Part[]>();
    let count = 0;
    const note = (docId: string | null, table: 0 | 1, row: number) => {
      const key = docId === null ? "" : String(docId);
      if (tooLarge.has(key)) return;
      if (++count > AFFINE_LIMITS.parts) throw new HttpError(413, "Der AFFiNE-Arbeitsbereich ist zu groß.");
      const list = parts.get(key);
      if (list) list.push([table, Number(row)]);
      else parts.set(key, [[table, Number(row)]]);
    };
    if (v2) {
      for (const row of open.prepare("SELECT rowid r, doc_id FROM snapshots").iterate() as Iterable<{ r: number; doc_id: string }>) note(row.doc_id, 0, row.r);
      for (const row of open.prepare("SELECT rowid r, doc_id FROM updates ORDER BY doc_id, created_at").iterate() as Iterable<{ r: number; doc_id: string }>) note(row.doc_id, 1, row.r);
    } else for (const row of open.prepare("SELECT rowid r, doc_id FROM updates ORDER BY id").iterate() as Iterable<{ r: number; doc_id: string | null }>) note(row.doc_id, 1, row.r);
    const data = [v2 ? open.prepare("SELECT data FROM snapshots WHERE rowid=?") : null, open.prepare("SELECT data FROM updates WHERE rowid=?")];
    const readDoc = (key: string) => {
      const list = parts.get(key);
      if (!list || !db) return null;
      const out: Uint8Array[] = [];
      for (const [table, row] of list) {
        const value = (data[table]?.get(row) as { data?: unknown } | undefined)?.data;
        if (value instanceof Uint8Array) out.push(value);
      }
      return out;
    };
    // Bytes in memory: everything now.
    const loaded = lazy ? null : new Map([...parts.keys()].map((key) => [key, readDoc(key) || []]));
    // Files: size, type and first bytes now; the content when it is used.
    const blobs = new Map<string, ABlob>();
    let blobBytes = 0,
      skippedBlobs = 0;
    const maxFiles = maxImportFiles();
    const content = open.prepare(`SELECT data FROM blobs WHERE rowid=?`);
    const blobQuery = v2
      ? "SELECT rowid id, key, length(data) size, substr(data, 1, 16) head, mime FROM blobs WHERE deleted_at IS NULL"
      : "SELECT rowid id, key, length(data) size, substr(data, 1, 16) head FROM blobs";
    for (const row of open.prepare(blobQuery).iterate() as Iterable<{ id: number; key: string; size: number; head: Uint8Array; mime?: string }>) {
      if (!(row.head instanceof Uint8Array) || typeof row.key !== "string") continue;
      if (blobs.size >= maxFiles) {
        skippedBlobs++;
        continue;
      }
      const size = Number(row.size);
      if (blobBytes + size > limits.blobBytes) continue;
      blobBytes += size;
      const mime = typeof row.mime === "string" ? row.mime.slice(0, 100) : "";
      const read = () => {
        if (!db) throw new HttpError(500, "Die AFFiNE-Datei ist schon geschlossen.");
        const value = (content.get(row.id) as { data?: unknown } | undefined)?.data;
        return value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.alloc(0);
      };
      blobs.set(row.key.slice(0, 200), lazy ? { size, mime, head: Buffer.from(row.head), read } : memoryBlob(read(), mime));
    }
    if (!lazy) close();
    return {
      format: v2 ? "sqlite-v2" : "sqlite-v1",
      spaceId,
      keys: [...parts.keys()],
      updates: (key) => (loaded ? (loaded.get(key) ?? null) : readDoc(key)),
      blobs,
      skippedBlobs,
      close,
    };
  } catch (error) {
    close();
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Die AFFiNE-Datei kann nicht gelesen werden.");
  }
}

function yDoc(updates: Uint8Array[]) {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

// The workspace file as its bytes or (large uploads) its path on disk; with
// a path, call close() on the result once the import is written.
export function readAffineFile(input: Buffer | string, fallbackName: string): AWorkspace {
  const sqlite = readSqlite(input);
  let done = false;
  const warnings: string[] = [];
  if (sqlite.skippedBlobs) warnings.push(tooManyFiles(sqlite.skippedBlobs));
  const keys = new Set(sqlite.keys);
  // Opened documents of the workspace (root, tables); destroyed at the end.
  const opened: Y.Doc[] = [];
  const open = (key: string) => {
    const updates = sqlite.updates(key);
    if (!updates) return null;
    try {
      return yDoc(updates);
    } catch {
      warnings.push("Ein Dokument konnte nicht gelesen werden.");
      return null;
    }
  };
  const keep = (doc: Y.Doc | null) => {
    if (doc) opened.push(doc);
    return doc;
  };
  try {
    // The root document: the space id (v2), no id (v1), else the one with
    // the list of documents.
    let root: Y.Doc | null = null;
    if (sqlite.spaceId && keys.has(sqlite.spaceId)) root = keep(open(sqlite.spaceId));
    else if (sqlite.format === "sqlite-v1" && keys.has("")) root = keep(open(""));
    else
      for (const key of keys) {
        if (/^(db|userdata)\$/.test(key)) continue;
        const doc = open(key);
        if (doc?.getMap("meta").has("pages")) {
          root = keep(doc);
          break;
        }
        doc?.destroy();
      }
    if (!root) throw new HttpError(400, "Die AFFiNE-Datei enthält keinen Arbeitsbereich.");
    const meta = fromY(root.getMap("meta")) as Record<string, unknown>;
    const metas = docMetas(meta.pages);
    // Older versions keep each document as a sub-document with its own guid.
    const guids = new Map<string, string>();
    for (const [id, sub] of root.getMap<unknown>("spaces").entries()) if (sub instanceof Y.Doc) guids.set(id, sub.guid);
    // A document is read when it is converted, then let go.
    const docs: ADoc[] = metas.map((m) => {
      const key = [m.id, guids.get(m.id), `space:${m.id}`].find((k): k is string => !!k && keys.has(k));
      return {
        ...m,
        load: () => {
          const doc = key !== undefined ? open(key) : null;
          if (!doc) return null;
          try {
            return readDocBlocks(doc);
          } catch {
            warnings.push("Ein Dokument konnte nicht gelesen werden.");
            return null;
          } finally {
            doc.destroy();
          }
        },
      };
    });
    // The workspace database: one document per table.
    const table = (name: string) => {
      const key = [...keys].find((k) => k === `db$${name}` || new RegExp(`^db\\$[^$]+\\$${name}$`).test(k));
      const doc = key ? keep(open(key)) : null;
      return doc ? tableRows(doc) : [];
    };
    const folders = table("folders")
      .filter((r) => typeof r.id === "string" && typeof r.type === "string" && typeof r.data === "string")
      .slice(0, 20000)
      .map((r) => ({
        id: str(r.id, 200),
        parentId: typeof r.parentId === "string" ? r.parentId : null,
        type: str(r.type, 30),
        data: str(r.data, 500),
        index: str(r.index, 200),
      }));
    const docProps = new Map<string, Record<string, unknown>>();
    const properties = new Map<string, AProperty>();
    // Legacy properties in the root document first, the tables override.
    const legacy = fromY(root.getMap("affine:workspace-properties")) as Record<string, unknown>;
    type LegacyValues = Record<string, { value?: unknown }>;
    const pageProperties = legacy?.pageProperties as Record<string, { system?: LegacyValues; custom?: LegacyValues }> | undefined;
    if (pageProperties && typeof pageProperties === "object")
      for (const [id, props] of Object.entries(pageProperties).slice(0, AFFINE_LIMITS.metas)) {
        const out = record();
        for (const [key, info] of Object.entries(props?.system || {})) if (info?.value != null && !UNSAFE_KEYS.has(key)) out[key] = String(info.value);
        for (const [key, info] of Object.entries(props?.custom || {})) if (info?.value != null && !UNSAFE_KEYS.has(key)) out[`custom:${key}`] = String(info.value);
        docProps.set(id, out);
      }
    const legacyDefs = (legacy?.schema as { pageProperties?: { custom?: Record<string, { name?: unknown; type?: unknown }> } } | undefined)?.pageProperties?.custom;
    if (legacyDefs && typeof legacyDefs === "object")
      for (const [id, def] of Object.entries(legacyDefs).slice(0, 500))
        if (def && typeof def.type === "string") properties.set(id, { name: str(def.name, 200), type: str(def.type, 40) });
    for (const row of table("docProperties"))
      if (typeof row.id === "string") {
        const out = docProps.get(row.id) || record();
        for (const [key, value] of Object.entries(row)) if (value != null) out[key] = value;
        docProps.set(row.id, out);
      }
    for (const row of table("docCustomPropertyInfo").slice(0, 500))
      if (typeof row.id === "string" && typeof row.type === "string") {
        if (row.isDeleted === true) properties.delete(row.id);
        else properties.set(row.id, { name: str(row.name, 200) || properties.get(row.id)?.name || "", type: str(row.type, 40) });
      }
    const favorites = new Set<string>();
    for (const key of keys)
      if (/^userdata\$[^$]+\$favorite$/.test(key)) {
        const doc = keep(open(key));
        for (const row of doc ? tableRows(doc) : []) if (typeof row.key === "string" && row.key.startsWith("doc:")) favorites.add(row.key.slice(4));
      }
    const setting = fromY(root.getMap("setting")) as Record<string, unknown>;
    const workspace: AWorkspace = {
      format: sqlite.format,
      name: str(meta.name, 200).trim() || fallbackName,
      docs,
      tags: tagOptions(meta.properties),
      folders,
      collections: collections(setting.collections),
      docProps,
      properties,
      icons: explorerIcons(table("explorerIcon")),
      favorites,
      blobs: sqlite.blobs,
      warnings,
      close: sqlite.close,
    };
    done = true;
    return workspace;
  } finally {
    for (const doc of opened) doc.destroy();
    if (!done) sqlite.close();
  }
}

/* ---------- the snapshot ZIP ---------- */

export function readSnapshotZip(entries: Map<string, Buffer>, fallbackName: string): AWorkspace {
  const warnings: string[] = [];
  const docs: ADoc[] = [];
  let tags = new Map<string, { name: string; color?: string }>();
  let info = false;
  const blobs = new Map<string, ABlob>();
  const maxFiles = maxImportFiles();
  let skippedBlobs = 0;
  for (const [name, data] of entries) {
    const base = posix.basename(name);
    if (name.includes("__MACOSX") || base.startsWith(".")) continue;
    // "assets/<blob id>.<ext>"; a blob id with "/" is a sub-folder.
    const asset = /(?:^|\/)assets\/(.+)$/.exec(name);
    if (asset) {
      if (blobs.size >= maxFiles) skippedBlobs++;
      else blobs.set(asset[1].replace(/\.[^./]*$/, "").slice(0, 200), memoryBlob(data, mimeOf(base)));
      continue;
    }
    if (base === "info.json") {
      try {
        tags = tagOptions((fromSnapshotJson(JSON.parse(data.toString("utf8"))) as { properties?: unknown })?.properties);
        info = true;
      } catch {
        /* without tag names */
      }
      continue;
    }
    if (!/\.snapshot\.json$/i.test(base) || docs.length >= AFFINE_LIMITS.metas) continue;
    if (data.length > AFFINE_LIMITS.snapshotBytes) {
      warnings.push("Ein Dokument ist zu groß und wurde übersprungen.");
      continue;
    }
    let snapshot: { type?: unknown; meta?: Record<string, unknown>; blocks?: unknown };
    try {
      snapshot = JSON.parse(data.toString("utf8"));
    } catch {
      warnings.push("Ein Dokument konnte nicht gelesen werden.");
      continue;
    }
    if (!snapshot || snapshot.type !== "page" || !snapshot.meta || typeof snapshot.meta.id !== "string") continue;
    const [meta] = docMetas([snapshot.meta]);
    // The blocks are read again when the document is converted.
    docs.push({ ...meta, load: () => readSnapshotBlocks((JSON.parse(data.toString("utf8")) as { blocks?: unknown }).blocks) });
  }
  if (skippedBlobs) warnings.push(tooManyFiles(skippedBlobs));
  // What only the workspace file carries (#82): since 2025 AFFiNE's
  // snapshots have no tags either.
  warnings.push(
    info
      ? "Ordner, Sammlungen, Journale, Eigenschaften und Symbole von Dokumenten enthält nur die Arbeitsbereichsdatei (.affine)."
      : "Tags, Ordner, Sammlungen, Journale, Eigenschaften und Symbole von Dokumenten enthält nur die Arbeitsbereichsdatei (.affine); AFFiNE schreibt sie nicht in Snapshots.",
  );
  // Nor whether a document is a template (#116): the snapshot's meta is
  // {id, title, createDate, tags} only.
  warnings.push("Ob ein Dokument eine Vorlage ist, steht nur in der Arbeitsbereichsdatei (.affine); aus einem Snapshot werden Vorlagen gewöhnliche Seiten.");
  return {
    format: "snapshot",
    name: fallbackName,
    docs,
    tags,
    folders: [],
    collections: [],
    docProps: new Map(),
    properties: new Map(),
    icons: new Map(),
    favorites: new Set(),
    blobs,
    warnings,
  };
}
