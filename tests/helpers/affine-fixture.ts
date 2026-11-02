// Builds AFFiNE workspace exports for the tests the way AFFiNE writes them
// (see lib/importers/affine-read.ts for the format and where it is
// verified): Y.Docs with a "blocks" map ("sys:*" / "prop:*" keys, Y.Text
// with deltas, boxed surface elements), a root document with "meta" and
// "setting", the ORM tables as "db$folders" / "db$docProperties" /
// "db$docCustomPropertyInfo" / "db$explorerIcon", packed
// into the SQLite workspace file (version 2 or 1) or a snapshot ZIP.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";

const NATIVE = "$blocksuite:internal:native$";
export type Delta = { insert: string; attributes?: Record<string, unknown> }[];
// Markers for values that are not plain Y.Maps.
export const text = (delta: Delta | string) => ({ $text: typeof delta === "string" ? [{ insert: delta }] : delta });
export const boxed = (value: unknown) => ({ $boxed: value });
export const raw = (value: unknown) => ({ $raw: value });

function setValue(map: Y.Map<unknown>, key: string, value: unknown) {
  if (value && typeof value === "object" && "$text" in value) {
    const t = new Y.Text();
    map.set(key, t);
    t.applyDelta((value as { $text: Delta }).$text);
  } else if (value && typeof value === "object" && "$raw" in value) map.set(key, (value as { $raw: unknown }).$raw);
  else if (value && typeof value === "object" && "$boxed" in value) {
    const box = new Y.Map<unknown>();
    map.set(key, box);
    box.set("type", NATIVE);
    setValue(box, "value", (value as { $boxed: unknown }).$boxed);
  } else if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    map.set(key, array);
    for (const item of value) pushValue(array, item);
  } else if (value && typeof value === "object") {
    const child = new Y.Map<unknown>();
    map.set(key, child);
    for (const [k, v] of Object.entries(value)) setValue(child, k, v);
  } else map.set(key, value);
}
function pushValue(array: Y.Array<unknown>, value: unknown) {
  if (value && typeof value === "object" && "$raw" in value) array.push([(value as { $raw: unknown }).$raw]);
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = new Y.Map<unknown>();
    array.push([child]);
    for (const [k, v] of Object.entries(value)) setValue(child, k, v);
  } else array.push([value]);
}

export type BlockSpec = { id: string; flavour: string; props?: Record<string, unknown>; children?: BlockSpec[]; flat?: boolean };
// A document's Y.Doc from a block tree (affine:page at the top).
export function docOf(id: string, root: BlockSpec) {
  const doc = new Y.Doc({ guid: id });
  const blocks = doc.getMap<Y.Map<unknown>>("blocks");
  const add = (spec: BlockSpec) => {
    const block = new Y.Map<unknown>();
    blocks.set(spec.id, block);
    block.set("sys:id", spec.id);
    block.set("sys:flavour", spec.flavour);
    block.set("sys:version", 1);
    block.set("sys:children", Y.Array.from((spec.children || []).map((c) => c.id)));
    // Flat data (affine:table): nested properties as dotted keys.
    const flatten = (value: unknown, path: string) => {
      if (value && typeof value === "object" && !Array.isArray(value) && !("$text" in value))
        for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k);
      else setValue(block, `prop:${path}`, value);
    };
    for (const [key, value] of Object.entries(spec.props || {}))
      if (spec.flat) flatten(value, key);
      else setValue(block, `prop:${key}`, value);
    for (const child of spec.children || []) add(child);
  };
  add(root);
  return doc;
}
// The document with the given notes (and surface) as AFFiNE creates it.
export function page(id: string, title: string, notes: BlockSpec[], surface?: { elements?: Record<string, unknown>; children?: BlockSpec[] }) {
  return docOf(id, {
    id: `${id}-page`,
    flavour: "affine:page",
    props: { title: text(title) },
    children: [
      { id: `${id}-surface`, flavour: "affine:surface", props: { elements: boxed(surface?.elements || {}) }, children: surface?.children || [] },
      ...notes,
    ],
  });
}
let counter = 0;
export const uid = (prefix = "b") => `${prefix}${++counter}`;
export const note = (children: BlockSpec[], props: Record<string, unknown> = {}): BlockSpec => ({
  id: uid("note"),
  flavour: "affine:note",
  props: { xywh: "[0,0,800,400]", background: "--affine-note-background-white", index: "a0", displayMode: "both", ...props },
  children,
});
export const para = (delta: Delta | string, type = "text", children: BlockSpec[] = []): BlockSpec => ({ id: uid("p"), flavour: "affine:paragraph", props: { type, text: text(delta) }, children });
export const list = (type: string, delta: Delta | string, extra: Record<string, unknown> = {}, children: BlockSpec[] = []): BlockSpec => ({
  id: uid("l"),
  flavour: "affine:list",
  props: { type, text: text(delta), checked: false, ...extra },
  children,
});

export type Workspace = {
  id: string;
  name: string;
  docs: { id: string; title: string; doc: Y.Doc; tags?: string[]; trash?: boolean; createDate?: number }[];
  tags?: { id: string; value: string; color?: string }[];
  collections?: unknown[];
  folders?: { id: string; parentId: string | null; type: string; data: string; index: string }[];
  docProperties?: Record<string, Record<string, unknown>>;
  // Property definitions (table docCustomPropertyInfo) by id.
  propertyInfo?: Record<string, Record<string, unknown>>;
  // Icons (table explorerIcon) by "doc:<id>", "folder:<id>", "collection:<id>".
  icons?: Record<string, Record<string, unknown>>;
  // Older workspaces: map "affine:workspace-properties" of the root document.
  legacyProperties?: Record<string, unknown>;
  favorites?: string[];
  blobs?: { key: string; data: Buffer; mime: string }[];
  // Extra documents by doc_id (for broken data in tests).
  extra?: Record<string, Uint8Array>;
};
export function rootDoc(ws: Workspace) {
  const doc = new Y.Doc({ guid: ws.id });
  const meta = doc.getMap<unknown>("meta");
  setValue(meta, "name", ws.name);
  setValue(
    meta,
    "pages",
    ws.docs.map((d) => ({ id: d.id, title: d.title, createDate: d.createDate ?? Date.UTC(2026, 0, 2), tags: d.tags || [], ...(d.trash ? { trash: true } : {}) })),
  );
  setValue(meta, "properties", { tags: { options: (ws.tags || []).map((t) => ({ ...t, createDate: 1, updateDate: 1 })) } });
  // Collections are pushed as plain objects (CollectionStore.createCollection).
  const collections = new Y.Array<unknown>();
  doc.getMap("setting").set("collections", collections);
  for (const c of ws.collections || []) collections.push([c]);
  if (ws.legacyProperties) {
    const legacy = doc.getMap<unknown>("affine:workspace-properties");
    for (const [key, value] of Object.entries(ws.legacyProperties)) setValue(legacy, key, value);
  }
  return doc;
}
function table(rows: Record<string, Record<string, unknown>>) {
  const doc = new Y.Doc();
  for (const [key, row] of Object.entries(rows)) {
    const map = doc.getMap<unknown>(key);
    for (const [field, value] of Object.entries(row)) map.set(field, value);
  }
  return doc;
}
// Every document of the workspace by its doc_id, as Yjs updates.
export function workspaceUpdates(ws: Workspace) {
  const out = new Map<string | null, Uint8Array>();
  out.set(ws.id, Y.encodeStateAsUpdate(rootDoc(ws)));
  for (const d of ws.docs) out.set(d.id, Y.encodeStateAsUpdate(d.doc));
  if (ws.folders) out.set("db$folders", Y.encodeStateAsUpdate(table(Object.fromEntries(ws.folders.map((f) => [f.id, f])))));
  if (ws.docProperties)
    out.set("db$docProperties", Y.encodeStateAsUpdate(table(Object.fromEntries(Object.entries(ws.docProperties).map(([id, p]) => [id, { id, ...p }])))));
  if (ws.propertyInfo)
    out.set("db$docCustomPropertyInfo", Y.encodeStateAsUpdate(table(Object.fromEntries(Object.entries(ws.propertyInfo).map(([id, p]) => [id, { id, ...p }])))));
  // JSON fields (the icon) are stored as plain values of the row.
  if (ws.icons) out.set("db$explorerIcon", Y.encodeStateAsUpdate(table(Object.fromEntries(Object.entries(ws.icons).map(([id, icon]) => [id, { id, icon }])))));
  if (ws.favorites)
    out.set("userdata$__local__$favorite", Y.encodeStateAsUpdate(table(Object.fromEntries(ws.favorites.map((id, i) => [`doc:${id}`, { key: `doc:${id}`, index: `a${i}` }])))));
  for (const [id, data] of Object.entries(ws.extra || {})) out.set(id, data);
  return out;
}

// AFFiNE's current schema (packages/frontend/native/schema/src/lib.rs).
const V2_SCHEMA = `
CREATE TABLE "meta" (space_id VARCHAR PRIMARY KEY NOT NULL);
CREATE TABLE "snapshots" (doc_id VARCHAR PRIMARY KEY NOT NULL, data BLOB NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL);
CREATE TABLE "updates" (doc_id VARCHAR NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, data BLOB NOT NULL, PRIMARY KEY (doc_id, created_at));
CREATE TABLE "clocks" (doc_id VARCHAR PRIMARY KEY NOT NULL, timestamp TIMESTAMP NOT NULL);
CREATE TABLE "blobs" (key VARCHAR PRIMARY KEY NOT NULL, data BLOB NOT NULL, mime VARCHAR NOT NULL, size INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, deleted_at TIMESTAMP);
CREATE TABLE "peer_clocks" (peer VARCHAR NOT NULL, doc_id VARCHAR NOT NULL, remote_clock TIMESTAMP NOT NULL DEFAULT 0, pulled_remote_clock TIMESTAMP NOT NULL DEFAULT 0, pushed_clock TIMESTAMP NOT NULL DEFAULT 0, PRIMARY KEY (peer, doc_id));
CREATE INDEX peer_clocks_doc_id ON peer_clocks (doc_id);
`;
// The older desktop schema (packages/frontend/native/schema/src/v1.rs).
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS "updates" (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL, doc_id TEXT);
CREATE TABLE IF NOT EXISTS "blobs" (key TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS "version_info" (version NUMBER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS "server_clock" (key TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS "sync_metadata" (key TEXT PRIMARY KEY NOT NULL, data BLOB NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

function sqliteFile(fill: (db: DatabaseSync) => void, schema: string) {
  const dir = mkdtempSync(join(tmpdir(), "affine-fixture-"));
  const path = join(dir, "workspace.affine");
  try {
    const db = new DatabaseSync(path);
    db.exec(schema);
    fill(db);
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// The workspace file as AFFiNE's desktop app saves it (version 2). `later`
// adds updates after the snapshot (documents are snapshot + updates).
export function affineFileV2(ws: Workspace, later: Record<string, Uint8Array[]> = {}) {
  return sqliteFile((db) => {
    db.prepare("INSERT INTO meta(space_id) VALUES(?)").run(ws.id);
    const snap = db.prepare("INSERT INTO snapshots(doc_id,data,updated_at) VALUES(?,?,?)");
    for (const [id, data] of workspaceUpdates(ws)) snap.run(id, data, "2026-10-01 10:00:00");
    const upd = db.prepare("INSERT INTO updates(doc_id,created_at,data) VALUES(?,?,?)");
    for (const [id, list] of Object.entries(later)) list.forEach((data, i) => upd.run(id, `2026-10-01 11:00:0${i}`, data));
    const blob = db.prepare("INSERT INTO blobs(key,data,mime,size) VALUES(?,?,?,?)");
    for (const b of ws.blobs || []) blob.run(b.key, b.data, b.mime, b.data.length);
  }, V2_SCHEMA);
}
// The older format: the root document without doc_id; `guids` stores a
// document under its sub-document guid (root map "spaces").
export function affineFileV1(ws: Workspace, guids: Record<string, string> = {}) {
  const updates = workspaceUpdates(ws);
  const root = new Y.Doc();
  Y.applyUpdate(root, updates.get(ws.id)!);
  for (const [docId, guid] of Object.entries(guids)) root.getMap("spaces").set(docId, new Y.Doc({ guid }));
  updates.set(ws.id, Y.encodeStateAsUpdate(root));
  return sqliteFile((db) => {
    db.prepare("INSERT INTO version_info(version) VALUES(1)").run();
    const upd = db.prepare("INSERT INTO updates(data,doc_id) VALUES(?,?)");
    for (const [id, data] of updates) upd.run(data, id === ws.id ? null : guids[id!] || id);
    const blob = db.prepare("INSERT INTO blobs(key,data) VALUES(?,?)");
    for (const b of ws.blobs || []) blob.run(b.key, b.data);
  }, V1_SCHEMA);
}
export const sqlite = (schema: string, fill: (db: DatabaseSync) => void = () => {}) => sqliteFile(fill, schema);

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const MP3 = Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000", "latin1"), Buffer.alloc(64, 0)]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(64, 0)]);
