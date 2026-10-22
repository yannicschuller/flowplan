// Block extensions ("Block-Erweiterungen"): workspace owners register a
// plugin by the address of its manifest (flowplan-plugin.json, see
// lib/plugin-protocol.ts). Its blocks render in sandboxed frames
// (components/plugin-block.ts); the only door back into Flowplan is the
// postMessage protocol, and the only data it can ask the server for is a
// database query with the reader's own rights, for databases an owner
// granted. Addresses must be HTTPS and on the instance's allow-list
// (PLUGIN_ALLOWED_ORIGINS) unless an admin allows any origin.
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage } from "./permissions";
import { safeFetch } from "./safe-fetch";
import { instanceSettings } from "./instance-settings";
import { envPluginOrigins } from "./plugin-origins";
import { visibleRows } from "./row-access";
import { visibleFields } from "./field-access";
import { publicTree } from "./publication";
import {
  MANIFEST_FILE,
  MAX_QUERY_ROWS,
  databasePermission,
  grantedDatabases,
  pluginManifestSchema,
  validatePluginSettings,
  type PluginManifest,
} from "./plugin-protocol";
import type { Field, Identity, Page } from "./types";

const uuid = z.uuid();
type PluginRow = {
  id: string;
  workspace_id: string;
  url: string;
  origin: string;
  manifest: string;
  permissions: string;
  settings: string;
  enabled: number;
  public: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};
export type PluginFetcher = (url: string) => Promise<{ url: string; status: number; body: string }>;
const defaultFetcher: PluginFetcher = (url) =>
  safeFetch(url, { maxBytes: 64 * 1024, timeout: 8000, accept: "application/json" });
let fetcher: PluginFetcher = defaultFetcher;
// Tests replace the network.
export function setPluginFetcher(next: PluginFetcher | null) {
  fetcher = next || defaultFetcher;
}

// The manifest address: given directly (…/flowplan-plugin.json or any
// .json) or as the plugin's base address.
export function manifestUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new HttpError(400, "Block-Erweiterungen werden nur über HTTPS geladen.");
  url.hash = "";
  if (!url.pathname.endsWith(".json")) url.pathname = url.pathname.replace(/\/?$/, "/") + MANIFEST_FILE;
  return url;
}
export function originAllowed(origin: string) {
  if (!/^https:\/\//.test(origin)) return false;
  return envPluginOrigins().includes(origin) || instanceSettings().pluginsAnyOrigin;
}
export function parseManifest(json: unknown): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Das Manifest ist ungültig: ${[...(issue?.path || [])].join(".") || "manifest"}`);
  }
  return parsed.data;
}
export async function fetchManifest(raw: string) {
  const url = manifestUrl(raw);
  if (!originAllowed(url.origin))
    throw new HttpError(403, "Diese Adresse ist für Block-Erweiterungen nicht freigegeben.");
  const response = await fetcher(url.href);
  let final: URL | null = null;
  try {
    final = new URL(response.url || url.href);
  } catch {}
  if (!final || final.origin !== url.origin)
    throw new HttpError(400, "Das Manifest leitet auf eine andere Adresse um.");
  if (response.status !== 200) throw new HttpError(400, "Das Manifest konnte nicht geladen werden.");
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new HttpError(400, "Das Manifest ist kein gültiges JSON.");
  }
  return { url: url.href, origin: url.origin, manifest: parseManifest(json) };
}

const manifestOf = (row: PluginRow) => pluginManifestSchema.parse(JSON.parse(row.manifest));
const permissionsOf = (row: PluginRow) => z.array(z.string()).catch([]).parse(JSON.parse(row.permissions));
const settingsOf = (row: PluginRow) => z.record(z.string(), z.unknown()).catch({}).parse(JSON.parse(row.settings));
// What the browser needs: absolute frame addresses, granted permissions.
export function pluginView(row: PluginRow, withSettings = true) {
  const manifest = manifestOf(row);
  const entry = (path: string) => new URL(path, row.url).href;
  return {
    id: row.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || "",
    url: row.url,
    origin: row.origin,
    blocks: manifest.blocks.map((b) => ({
      type: b.type,
      label: b.label,
      icon: b.icon || "",
      description: b.description || "",
      entry: entry(b.entry || manifest.entry),
    })),
    permissions: permissionsOf(row),
    requested: manifest.permissions,
    size: manifest.size,
    settingsSchema: manifest.settings,
    settings: withSettings ? settingsOf(row) : {},
    enabled: !!row.enabled,
    public: !!row.public,
  };
}
export type PluginView = ReturnType<typeof pluginView>;
function requirePlugin(pluginId: unknown) {
  const row = one<PluginRow>("SELECT * FROM plugins WHERE id=?", uuid.parse(pluginId));
  if (!row) throw new HttpError(404, "Block-Erweiterung nicht gefunden.");
  return row;
}
// A database an owner grants: in the same workspace and readable by them.
function checkGrantable(user: Identity, workspaceId: string, databaseId: string) {
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", databaseId);
  if (!page || page.workspace_id !== workspaceId || page.kind !== "database")
    throw new HttpError(400, "Die Datenbank gehört nicht zu diesem Arbeitsbereich.");
  requirePage(user, databaseId);
}
// The permissions an owner may grant from a manifest: everything it asks
// for, databases only when named or (with "read:database") chosen.
function grantPermissions(user: Identity, workspaceId: string, manifest: PluginManifest, chosen: string[] | undefined) {
  const named = grantedDatabases(manifest.permissions);
  const any = manifest.permissions.includes("read:database");
  const databases = chosen ?? named;
  for (const db of databases) {
    if (!named.includes(db) && !any)
      throw new HttpError(400, "Diese Erweiterung hat keinen Zugriff auf Datenbanken angefragt.");
    checkGrantable(user, workspaceId, db);
  }
  const plain = manifest.permissions.filter((p) => !p.startsWith("read:database"));
  return [...plain, ...[...new Set(databases)].map(databasePermission)];
}

export async function registerPlugin(user: Identity, input: unknown) {
  const b = z
    .object({ workspaceId: uuid, url: z.string().trim().min(8).max(2000), databases: z.array(uuid).max(20).optional() })
    .parse(input);
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  requireMember(user, b.workspaceId, "owner");
  const fetched = await fetchManifest(b.url);
  // Rights may have changed while the manifest loaded.
  requireMember(user, b.workspaceId, "owner");
  const permissions = grantPermissions(user, b.workspaceId, fetched.manifest, b.databases?.map((d) => d.toLowerCase()));
  const existing = one<PluginRow>("SELECT * FROM plugins WHERE workspace_id=? AND url=?", b.workspaceId, fetched.url);
  const now = Date.now();
  const settings = validatePluginSettings(fetched.manifest, existing ? settingsOf(existing) : {});
  if (existing)
    run(
      "UPDATE plugins SET manifest=?,permissions=?,settings=?,origin=?,updated_at=? WHERE id=?",
      JSON.stringify(fetched.manifest),
      JSON.stringify(permissions),
      JSON.stringify(settings),
      fetched.origin,
      now,
      existing.id,
    );
  else {
    if ((one<{ n: number }>("SELECT count(*) n FROM plugins WHERE workspace_id=?", b.workspaceId)?.n || 0) >= 50)
      throw new HttpError(409, "Höchstens 50 Block-Erweiterungen je Arbeitsbereich.");
    run(
      "INSERT INTO plugins(id,workspace_id,url,origin,manifest,permissions,settings,enabled,public,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,0,?,?,?)",
      id(),
      b.workspaceId,
      fetched.url,
      fetched.origin,
      JSON.stringify(fetched.manifest),
      JSON.stringify(permissions),
      JSON.stringify(settings),
      user.id,
      now,
      now,
    );
  }
  const row = one<PluginRow>("SELECT * FROM plugins WHERE workspace_id=? AND url=?", b.workspaceId, fetched.url)!;
  audit(user.id, "plugin.register", row.id, `${fetched.manifest.name} ${fetched.manifest.version} ${fetched.url}`);
  return pluginView(row);
}

// Every member sees the enabled plugins (to render their blocks); owners
// also the switched-off ones.
export function listPlugins(user: Identity, workspaceId: string) {
  const role = requireMember(user, uuid.parse(workspaceId));
  const rows = all<PluginRow>(
    `SELECT * FROM plugins WHERE workspace_id=? ${role === "owner" ? "" : "AND enabled=1"} ORDER BY created_at`,
    workspaceId,
  );
  return { plugins: rows.map((row) => pluginView(row)), canManage: role === "owner" && !user.apiScope };
}
export function pluginsForPage(user: Identity, pageId: string) {
  const page = requirePage(user, uuid.parse(pageId));
  return {
    plugins: all<PluginRow>("SELECT * FROM plugins WHERE workspace_id=? AND enabled=1 ORDER BY created_at", page.workspace_id).map((row) =>
      pluginView(row),
    ),
  };
}

export function updatePlugin(user: Identity, input: Record<string, unknown>) {
  const row = requirePlugin(input.pluginId);
  requireMember(user, row.workspace_id, "owner");
  const b = z
    .object({
      enabled: z.boolean().optional(),
      public: z.boolean().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      databases: z.array(uuid).max(20).optional(),
    })
    .parse(input);
  const manifest = manifestOf(row);
  if (b.enabled !== undefined) run("UPDATE plugins SET enabled=? WHERE id=?", b.enabled ? 1 : 0, row.id);
  if (b.public !== undefined) run("UPDATE plugins SET public=? WHERE id=?", b.public ? 1 : 0, row.id);
  if (b.settings !== undefined)
    run("UPDATE plugins SET settings=? WHERE id=?", JSON.stringify(validatePluginSettings(manifest, b.settings)), row.id);
  if (b.databases !== undefined)
    run(
      "UPDATE plugins SET permissions=? WHERE id=?",
      JSON.stringify(grantPermissions(user, row.workspace_id, manifest, b.databases.map((d) => d.toLowerCase()))),
      row.id,
    );
  run("UPDATE plugins SET updated_at=? WHERE id=?", Date.now(), row.id);
  audit(user.id, "plugin.update", row.id, JSON.stringify({ enabled: b.enabled, public: b.public }));
  return pluginView(requirePlugin(row.id));
}
export function deletePlugin(user: Identity, input: Record<string, unknown>) {
  const row = requirePlugin(input.pluginId);
  requireMember(user, row.workspace_id, "owner");
  run("DELETE FROM plugins WHERE id=?", row.id);
  audit(user.id, "plugin.delete", row.id, manifestOf(row).name);
  return { ok: true };
}

// A plugin as a published page shows it: only when its owner allowed
// published pages, for the publication's own workspace.
export function publicPlugin(token: string, pluginId: string) {
  const { root } = publicTree(token);
  const row = requirePlugin(pluginId);
  if (row.workspace_id !== root.workspace_id || !row.enabled || !row.public)
    throw new HttpError(404, "Block-Erweiterung nicht gefunden.");
  const view = pluginView(row);
  // Published frames never query databases.
  return { ...view, permissions: view.permissions.filter((p) => !p.startsWith("read:database")) };
}
// Whether published pages may show a plugin's blocks (lib/publication.ts).
export function publicPluginIds(workspaceId: string) {
  return new Set(
    all<{ id: string }>("SELECT id FROM plugins WHERE workspace_id=? AND enabled=1 AND public=1", workspaceId).map((r) => r.id),
  );
}

// The "query" request of a frame: records of a granted database, with the
// reader's own rights – hidden records and properties stay hidden.
export function queryPluginDatabase(user: Identity, input: Record<string, unknown>) {
  const b = z
    .object({ pluginId: uuid, pageId: uuid, databaseId: uuid, limit: z.coerce.number().int().min(1).max(MAX_QUERY_ROWS).optional() })
    .parse(input);
  const row = requirePlugin(b.pluginId);
  if (!row.enabled) throw new HttpError(404, "Block-Erweiterung nicht gefunden.");
  const page = requirePage(user, b.pageId);
  if (page.workspace_id !== row.workspace_id) throw new HttpError(404, "Block-Erweiterung nicht gefunden.");
  if (!permissionsOf(row).includes(databasePermission(b.databaseId)))
    throw new HttpError(403, "Diese Erweiterung darf die Datenbank nicht lesen.");
  const source = requirePage(user, b.databaseId);
  if (source.kind !== "database" || source.workspace_id !== row.workspace_id)
    throw new HttpError(404, "Datenbank nicht gefunden.");
  const stored = JSON.parse(String(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", source.id)?.fields || "[]")) as Field[];
  const fields = visibleFields(user, source, stored);
  const shown = new Set(fields.map((f) => f.id));
  const records = visibleRows(
    user,
    source,
    all<{ id: string; access: string; created_by: string | null; cells: string }>(
      "SELECT id,access,created_by,cells FROM rows WHERE page_id=? ORDER BY position",
      source.id,
    ).map((r) => ({ ...r, cells: JSON.parse(r.cells) as Record<string, unknown> })),
  ).slice(0, b.limit || 50);
  return {
    database: { id: source.id, title: source.title },
    fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
    rows: records.map((r) => ({
      id: r.id,
      cells: Object.fromEntries(Object.entries(r.cells as Record<string, unknown>).filter(([key]) => shown.has(key))),
    })),
  };
}
