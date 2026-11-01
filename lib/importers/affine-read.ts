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
//    and the files as "assets/<blob id>.<ext>"; older versions add an
//    info.json with the tag names. Folders, collections and journals are not
//    part of it.
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
//   "db$docProperties" ({id, journal: "YYYY-MM-DD", primaryMode, …});
//   every row is a top-level map named by its key, deleted rows carry
//   "$$DELETED". Favourites: "userdata$<user>$favorite" ({key: "doc:<id>"}).
//
// Everything here is untrusted: sizes, counts and nesting are bounded, a
// document that cannot be read is skipped with a warning, and object keys
// that could reach a prototype are dropped.
//
// Large workspace files (#76): a file on disk (the upload, streamed there)
// is opened in place, and its files (blobs) are only read one at a time
// when the import writes them – memory holds the documents, not the files.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { HttpError } from "../auth";
import { mimeOf } from "./html";

export const AFFINE_LIMITS = {
  docs: 3000,
  docBytes: 32 * 1024 * 1024,
  totalDocBytes: 256 * 1024 * 1024,
  blocks: 20000,
  depth: 60,
  blobs: 5000,
  blobBytes: 100 * 1024 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
  textLength: 200_000,
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
export type ADoc = {
  id: string;
  title: string;
  created?: number;
  updated?: number;
  tags: string[];
  trash: boolean;
  root: ABlock | null;
  unreadable?: boolean;
};
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
function docMetas(pages: unknown): Omit<ADoc, "root">[] {
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
    .slice(0, AFFINE_LIMITS.docs)
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

/* ---------- the workspace file (SQLite) ---------- */

type Sqlite = { format: "sqlite-v1" | "sqlite-v2"; spaceId: string | null; docs: Map<string, Uint8Array[]>; blobs: Map<string, ABlob>; close: () => void };
// The workspace file: a path (opened in place, files read lazily until
// close) or its bytes (copied to a private temp folder, files read at once).
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
    const limits = affineLimitsFor(typeof input === "string" ? statSync(path).size : input.length);
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
    const docs = new Map<string, Uint8Array[]>();
    let total = 0;
    const add = (docId: string | null, data: unknown) => {
      if (!(data instanceof Uint8Array)) return;
      const key = docId ?? "";
      if (!docs.has(key) && docs.size >= AFFINE_LIMITS.docs * 2 + 20) return;
      total += data.length;
      if (total > limits.totalDocBytes) throw new HttpError(413, "Der AFFiNE-Arbeitsbereich ist zu groß.");
      const list = docs.get(key) || [];
      list.push(data);
      docs.set(key, list);
    };
    // Sizes first, so a huge document is never read into memory.
    const tooLarge = new Set<string>();
    const sizes = v2
      ? `SELECT doc_id, SUM(n) n FROM (SELECT doc_id, length(data) n FROM snapshots UNION ALL SELECT doc_id, length(data) n FROM updates) GROUP BY doc_id`
      : `SELECT doc_id, SUM(length(data)) n FROM updates GROUP BY doc_id`;
    for (const row of open.prepare(sizes).all() as { doc_id: string | null; n: number }[])
      if (Number(row.n) > AFFINE_LIMITS.docBytes) tooLarge.add(row.doc_id ?? "");
    let spaceId: string | null = null;
    if (v2) {
      if (has("meta", "space_id")) spaceId = (open.prepare("SELECT space_id FROM meta LIMIT 1").get() as { space_id?: string } | undefined)?.space_id ?? null;
      for (const row of open.prepare("SELECT doc_id, data FROM snapshots").iterate() as Iterable<{ doc_id: string; data: Uint8Array }>)
        if (!tooLarge.has(row.doc_id)) add(String(row.doc_id), row.data);
      for (const row of open.prepare("SELECT doc_id, data FROM updates ORDER BY doc_id, created_at").iterate() as Iterable<{ doc_id: string; data: Uint8Array }>)
        if (!tooLarge.has(row.doc_id)) add(String(row.doc_id), row.data);
    } else
      for (const row of open.prepare("SELECT doc_id, data FROM updates ORDER BY id").iterate() as Iterable<{ doc_id: string | null; data: Uint8Array }>)
        if (!tooLarge.has(row.doc_id ?? "")) add(row.doc_id === null ? null : String(row.doc_id), row.data);
    // Files: size, type and first bytes now; the content when it is used.
    const blobs = new Map<string, ABlob>();
    let blobBytes = 0;
    const lazy = typeof input === "string";
    const content = open.prepare(`SELECT data FROM blobs WHERE rowid=?`);
    const blobQuery = v2
      ? "SELECT rowid id, key, length(data) size, substr(data, 1, 16) head, mime FROM blobs WHERE deleted_at IS NULL"
      : "SELECT rowid id, key, length(data) size, substr(data, 1, 16) head FROM blobs";
    for (const row of open.prepare(blobQuery).iterate() as Iterable<{ id: number; key: string; size: number; head: Uint8Array; mime?: string }>) {
      if (blobs.size >= AFFINE_LIMITS.blobs || !(row.head instanceof Uint8Array) || typeof row.key !== "string") continue;
      const size = Number(row.size);
      if (blobBytes + size > limits.blobBytes) continue;
      blobBytes += size;
      const mime = typeof row.mime === "string" ? row.mime.slice(0, 100) : "";
      const read = () => {
        if (!db) throw new HttpError(500, "Die AFFiNE-Datei ist schon geschlossen.");
        const data = (content.get(row.id) as { data?: unknown } | undefined)?.data;
        return data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.alloc(0);
      };
      blobs.set(row.key.slice(0, 200), lazy ? { size, mime, head: Buffer.from(row.head), read } : memoryBlob(read(), mime));
    }
    if (!lazy) close();
    return { format: v2 ? "sqlite-v2" : "sqlite-v1", spaceId, docs, blobs, close };
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
  const opened = new Map<string, Y.Doc>();
  const open = (key: string) => {
    if (opened.has(key)) return opened.get(key)!;
    const updates = sqlite.docs.get(key);
    if (!updates) return null;
    try {
      const doc = yDoc(updates);
      opened.set(key, doc);
      return doc;
    } catch {
      warnings.push("Ein Dokument konnte nicht gelesen werden.");
      return null;
    }
  };
  try {
    // The root document: the space id (v2), no id (v1), else the one with
    // the list of documents.
    const rootKey =
      (sqlite.spaceId && sqlite.docs.has(sqlite.spaceId) ? sqlite.spaceId : null) ??
      (sqlite.format === "sqlite-v1" && sqlite.docs.has("") ? "" : null) ??
      [...sqlite.docs.keys()].find((key) => !/^(db|userdata)\$/.test(key) && open(key)?.getMap("meta").has("pages")) ??
      null;
    const root = rootKey !== null ? open(rootKey) : null;
    if (!root) throw new HttpError(400, "Die AFFiNE-Datei enthält keinen Arbeitsbereich.");
    const meta = fromY(root.getMap("meta")) as Record<string, unknown>;
    const metas = docMetas(meta.pages);
    // Older versions keep each document as a sub-document with its own guid.
    const guids = new Map<string, string>();
    for (const [id, sub] of root.getMap<unknown>("spaces").entries()) if (sub instanceof Y.Doc) guids.set(id, sub.guid);
    const docs: ADoc[] = metas.map((m) => {
      const key = [m.id, guids.get(m.id), `space:${m.id}`].find((k): k is string => !!k && sqlite.docs.has(k));
      const doc = key !== undefined ? open(key) : null;
      let blocks: ABlock | null = null;
      try {
        blocks = doc ? readDocBlocks(doc) : null;
      } catch {
        warnings.push("Ein Dokument konnte nicht gelesen werden.");
      }
      return { ...m, root: blocks, unreadable: !blocks };
    });
    // The workspace database: one document per table.
    const table = (name: string) => {
      const key = [...sqlite.docs.keys()].find((k) => k === `db$${name}` || new RegExp(`^db\\$[^$]+\\$${name}$`).test(k));
      const doc = key ? open(key) : null;
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
    // Legacy properties in the root document first, the table overrides.
    const legacy = fromY(root.getMap("affine:workspace-properties")) as Record<string, unknown>;
    const pageProperties = legacy?.pageProperties as Record<string, { system?: Record<string, { value?: unknown }> }> | undefined;
    if (pageProperties && typeof pageProperties === "object")
      for (const [id, props] of Object.entries(pageProperties).slice(0, AFFINE_LIMITS.docs)) {
        const out = record();
        for (const [key, info] of Object.entries(props?.system || {})) if (info?.value != null && !UNSAFE_KEYS.has(key)) out[key] = String(info.value);
        docProps.set(id, out);
      }
    for (const row of table("docProperties"))
      if (typeof row.id === "string") {
        const out = docProps.get(row.id) || record();
        for (const [key, value] of Object.entries(row)) if (value != null) out[key] = value;
        docProps.set(row.id, out);
      }
    const favorites = new Set<string>();
    for (const key of sqlite.docs.keys())
      if (/^userdata\$[^$]+\$favorite$/.test(key)) {
        const doc = open(key);
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
      favorites,
      blobs: sqlite.blobs,
      warnings,
      close: sqlite.close,
    };
    done = true;
    return workspace;
  } finally {
    for (const doc of opened.values()) doc.destroy();
    if (!done) sqlite.close();
  }
}

/* ---------- the snapshot ZIP ---------- */

export function readSnapshotZip(entries: Map<string, Buffer>, fallbackName: string): AWorkspace {
  const warnings: string[] = [];
  const docs: ADoc[] = [];
  let tags = new Map<string, { name: string; color?: string }>();
  const blobs = new Map<string, ABlob>();
  for (const [name, data] of entries) {
    const base = posix.basename(name);
    if (name.includes("__MACOSX") || base.startsWith(".")) continue;
    if (/(^|\/)assets\/[^/]+$/.test(name)) {
      if (blobs.size < AFFINE_LIMITS.blobs) blobs.set(base.replace(/\.[^.]*$/, ""), memoryBlob(data, mimeOf(base)));
      continue;
    }
    if (base === "info.json") {
      try {
        tags = tagOptions((fromSnapshotJson(JSON.parse(data.toString("utf8"))) as { properties?: unknown })?.properties);
      } catch {
        /* without tag names */
      }
      continue;
    }
    if (!/\.snapshot\.json$/i.test(base) || docs.length >= AFFINE_LIMITS.docs) continue;
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
    const root = readSnapshotBlocks(snapshot.blocks);
    docs.push({ ...meta, root, unreadable: !root });
  }
  return {
    format: "snapshot",
    name: fallbackName,
    docs,
    tags,
    folders: [],
    collections: [],
    docProps: new Map(),
    favorites: new Set(),
    blobs,
    warnings,
  };
}
