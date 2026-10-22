import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-plugins-"));
process.env.PLUGIN_ALLOWED_ORIGINS = "https://plugins.example.org, http://insecure.example.org";
const { id, one, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, database } = await import("../lib/api");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const plugins = await import("../lib/plugins");
const protocol = await import("../lib/plugin-protocol");
const { envPluginOrigins, pluginFrameOrigins } = await import("../lib/plugin-origins");
const { cleanHtml } = await import("../lib/document-server");
const { htmlState, stateHtml } = await import("../lib/document-server");
const Y = await import("yjs");
// HTML → stored document state → HTML, as saving a document does.
const roundTrip = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
const { htmlToMarkdown } = await import("../lib/markdown");
const { documentText } = await import("../lib/search-index");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
async function fails(fn: () => unknown, status: number) {
  await assert.rejects(async () => fn(), (error: { status?: number }) => error.status === status);
}
const owner = person("plugin-owner"),
  editor = person("plugin-editor"),
  viewer = person("plugin-viewer"),
  stranger = person("plugin-stranger");
const wid = createWorkspace(owner.id, "Plugins");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const otherWorkspace = createWorkspace(stranger.id, "Fremd");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const create = (title: string, kind = "document", ws = wid, sp = space, who = owner) =>
  (command(who, { action: "page.create", workspaceId: ws, spaceId: sp, title, kind }) as { id: string }).id;
const doc = create("Seite mit Block");
const db = create("Aufgaben", "database");
const foreignDb = create(
  "Fremde Datenbank",
  "database",
  otherWorkspace,
  one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", otherWorkspace)!.id,
  stranger,
);
const example = JSON.parse(readFileSync("examples/plugin-hello/flowplan-plugin.json", "utf8"));

// The network: manifests by address.
const served = new Map<string, { status?: number; body: unknown; url?: string }>();
plugins.setPluginFetcher(async (url) => {
  const entry = served.get(url);
  if (!entry) return { url, status: 404, body: "" };
  return { url: entry.url || url, status: entry.status || 200, body: typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body) };
});

test("manifests: the example is valid, broken ones are refused", () => {
  const manifest = plugins.parseManifest(example);
  assert.equal(manifest.name, "Hello Flowplan");
  assert.deepEqual(manifest.blocks.map((b) => b.type), ["counter", "poll"]);
  assert.equal(manifest.entry, "index.html");
  assert.deepEqual(manifest.size, { height: 160, maxHeight: 600 });
  const bad = (patch: Record<string, unknown>) => assert.throws(() => plugins.parseManifest({ ...example, ...patch }), /Manifest ist ungültig/);
  bad({ version: "eins" });
  bad({ name: "" });
  bad({ blocks: [] });
  bad({ blocks: [{ type: "Counter", label: "x" }] });
  bad({ blocks: [{ type: "a", label: "x" }, { type: "a", label: "y" }] });
  bad({ entry: "https://evil.example/x.html" });
  bad({ entry: "//evil.example/x.html" });
  bad({ entry: "../outside.html" });
  bad({ permissions: ["read:everything"] });
  bad({ permissions: ["read:user"] });
  bad({ size: { height: 10 } });
  bad({ size: { height: 200, maxHeight: 5000 } });
  // Permissions are normalised and deduplicated.
  const dbPermission = `read:database:${db.toUpperCase()}`;
  const normal = plugins.parseManifest({ ...example, permissions: ["write:block", "write:block", dbPermission] });
  assert.deepEqual(normal.permissions, ["write:block", `read:database:${db}`]);
  // Settings are checked against their schema.
  assert.deepEqual(protocol.validatePluginSettings(manifest, {}), { step: 1 });
  assert.deepEqual(protocol.validatePluginSettings(manifest, { step: 5, unknown: "x" }), { step: 5 });
  assert.throws(() => protocol.validatePluginSettings(manifest, { step: "fünf" }));
});

test("manifest addresses: HTTPS only, the file name is added to a base address", () => {
  assert.equal(plugins.manifestUrl("https://plugins.example.org/hello").href, "https://plugins.example.org/hello/flowplan-plugin.json");
  assert.equal(plugins.manifestUrl("https://plugins.example.org/hello/").href, "https://plugins.example.org/hello/flowplan-plugin.json");
  assert.equal(plugins.manifestUrl("https://plugins.example.org/x/manifest.json#a").href, "https://plugins.example.org/x/manifest.json");
  assert.throws(() => plugins.manifestUrl("http://plugins.example.org/hello"), /HTTPS/);
  assert.throws(() => plugins.manifestUrl("https://user:pw@plugins.example.org/"), /HTTPS/);
  assert.throws(() => plugins.manifestUrl("javascript:alert(1)"));
  // Only HTTPS origins count on the allow-list.
  assert.deepEqual(envPluginOrigins(), ["https://plugins.example.org"]);
});

let pluginId = "";
test("registration: owners only, allowed origins only, no redirects elsewhere", async () => {
  served.set("https://plugins.example.org/hello/flowplan-plugin.json", { body: example });
  served.set("https://other.example.net/hello/flowplan-plugin.json", { body: example });
  served.set("https://plugins.example.org/moved/flowplan-plugin.json", { body: example, url: "https://evil.example.net/flowplan-plugin.json" });
  served.set("https://plugins.example.org/broken/flowplan-plugin.json", { body: "{nope" });
  const input = { workspaceId: wid, url: "https://plugins.example.org/hello/" };
  await fails(() => plugins.registerPlugin(editor, input), 403);
  await fails(() => plugins.registerPlugin(viewer, input), 403);
  await fails(() => plugins.registerPlugin(stranger, input), 403);
  await fails(() => plugins.registerPlugin({ ...owner, apiScope: "write" }, input), 403);
  await fails(() => plugins.registerPlugin(owner, { workspaceId: wid, url: "https://other.example.net/hello/" }), 403);
  await fails(() => plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/moved/" }), 400);
  await fails(() => plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/broken/" }), 400);
  await fails(() => plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/missing/" }), 400);
  const registered = await plugins.registerPlugin(owner, input);
  pluginId = registered.id;
  assert.equal(registered.origin, "https://plugins.example.org");
  assert.equal(registered.blocks[0].entry, "https://plugins.example.org/hello/index.html");
  assert.deepEqual(registered.permissions, ["read:page", "write:block"]);
  assert.equal(registered.public, false);
  // Registering again refreshes, it does not duplicate.
  const again = await plugins.registerPlugin(owner, input);
  assert.equal(again.id, pluginId);
  // Any origin once the administration allows it.
  saveInstanceSettings({ pluginsAnyOrigin: true });
  const other = await plugins.registerPlugin(owner, { workspaceId: wid, url: "https://other.example.net/hello/" });
  assert.equal(other.origin, "https://other.example.net");
  saveInstanceSettings({ pluginsAnyOrigin: false });
  assert.ok(pluginFrameOrigins().includes("https://other.example.net"));
  command(owner, { action: "plugin.delete", pluginId: other.id });
  assert.ok(!pluginFrameOrigins().includes("https://other.example.net"));
  // Members see enabled plugins; the editor menu gets them by page.
  assert.equal(plugins.listPlugins(viewer, wid).plugins.length, 1);
  assert.equal(plugins.listPlugins(viewer, wid).canManage, false);
  assert.equal(plugins.pluginsForPage(editor, doc).plugins[0].id, pluginId);
  assert.throws(() => plugins.listPlugins(stranger, wid), (e: { status?: number }) => e.status === 403);
  // Only owners change or remove a plugin.
  assert.throws(() => command(editor, { action: "plugin.update", pluginId, public: true }), (e: { status?: number }) => e.status === 403);
  assert.throws(() => command(editor, { action: "plugin.delete", pluginId }), (e: { status?: number }) => e.status === 403);
  command(owner, { action: "plugin.update", pluginId, enabled: false });
  assert.equal(plugins.pluginsForPage(editor, doc).plugins.length, 0);
  assert.equal(plugins.listPlugins(owner, wid).plugins.length, 1);
  command(owner, { action: "plugin.update", pluginId, enabled: true, settings: { step: 3 } });
  assert.deepEqual(plugins.pluginsForPage(editor, doc).plugins[0].settings, { step: 3 });
});

test("database permissions: only databases of the workspace, granted by an owner", async () => {
  served.set("https://plugins.example.org/foreign/flowplan-plugin.json", {
    body: { ...example, permissions: [`read:database:${foreignDb}`] },
  });
  await fails(() => plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/foreign/" }), 400);
  served.set("https://plugins.example.org/any/flowplan-plugin.json", { body: { ...example, permissions: ["read:database"] } });
  const any = await plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/any/", databases: [db] });
  assert.deepEqual(any.permissions, [`read:database:${db}`]);
  assert.throws(
    () => command(owner, { action: "plugin.update", pluginId: any.id, databases: [foreignDb] }),
    (e: { status?: number }) => e.status === 400,
  );
  // Without "read:database" no database can be granted.
  assert.throws(
    () => command(owner, { action: "plugin.update", pluginId, databases: [db] }),
    (e: { status?: number }) => e.status === 400,
  );
  command(owner, { action: "plugin.delete", pluginId: any.id });
});

test("the protocol: shape, nonce and source are checked", () => {
  const nonce = protocol.createNonce();
  assert.match(nonce, protocol.NONCE_PATTERN);
  const base = { protocol: protocol.PROTOCOL, nonce };
  assert.deepEqual(protocol.parsePluginMessage({ ...base, type: "ready" }, nonce), { ...base, type: "ready" });
  assert.equal(protocol.parsePluginMessage({ ...base, type: "ready" }, protocol.createNonce()), null);
  assert.equal(protocol.parsePluginMessage({ ...base, protocol: "other/1", type: "ready" }, nonce), null);
  assert.equal(protocol.parsePluginMessage({ ...base, type: "getData" }, nonce), null, "requests need an id");
  assert.equal(protocol.parsePluginMessage({ ...base, type: "ready", extra: 1 }, nonce), null, "unknown keys");
  assert.equal(protocol.parsePluginMessage({ ...base, type: "navigate", id: "1" }, nonce), null);
  assert.equal(protocol.parsePluginMessage({ ...base, type: "query", id: "1", databaseId: "x" }, nonce), null);
  assert.equal(protocol.parsePluginMessage({ ...base, type: "query", id: "1", databaseId: db, limit: 5000 }, nonce), null);
  assert.equal(protocol.parsePluginMessage("not an object", nonce), null);
  assert.ok(protocol.parsePluginMessage({ ...base, type: "setData", id: "1", data: { a: 1 }, text: "Hallo" }, nonce));
  const frame = {};
  assert.equal(protocol.trustedSource({ origin: "null", source: frame }, frame), true);
  assert.equal(protocol.trustedSource({ origin: "https://plugins.example.org", source: frame }, frame), false);
  assert.equal(protocol.trustedSource({ origin: "null", source: {} }, frame), false);
  assert.equal(protocol.trustedSource({ origin: "null", source: null }, null), false);
});

test("data caps: 64 KB of JSON, bounded heights and search text", () => {
  assert.equal(protocol.encodeBlockData({ count: 1 }), '{"count":1}');
  assert.throws(() => protocol.encodeBlockData({ big: "x".repeat(protocol.MAX_BLOCK_DATA) }), /64 KB/);
  // Multi-byte characters count by their bytes.
  assert.throws(() => protocol.encodeBlockData("ä".repeat(protocol.MAX_BLOCK_DATA / 2)), /64 KB/);
  assert.throws(() => protocol.encodeBlockData(() => 1));
  assert.equal(protocol.storedBlockData("x".repeat(protocol.MAX_BLOCK_DATA + 1)), "null");
  assert.equal(protocol.storedBlockData("{broken"), "null");
  assert.equal(protocol.storedBlockData('{"a":1}'), '{"a":1}');
  assert.equal(protocol.clampFrameHeight(5), protocol.MIN_FRAME_HEIGHT);
  assert.equal(protocol.clampFrameHeight(99999, 600), 600);
  assert.equal(protocol.clampFrameHeight(99999, 99999), protocol.MAX_FRAME_HEIGHT);
  assert.equal(protocol.clampFrameHeight(Number.NaN), protocol.DEFAULT_FRAME_HEIGHT);
  assert.equal(protocol.blockText("a".repeat(5000)).length, protocol.MAX_BLOCK_TEXT);
  assert.equal(protocol.blockText({ not: "text" }), "");
  // Stored documents keep the block, with oversized data dropped.
  const html = `<div data-plugin="${pluginId}" data-plugin-type="poll" data-plugin-label="Umfrage" data-plugin-data='{"question":"Pizza?"}'>Pizza? Ja (3)</div>`;
  const saved = roundTrip(html);
  assert.match(saved, /data-plugin-data="\{&quot;question&quot;:&quot;Pizza\?&quot;\}"/);
  assert.match(saved, /Pizza\? Ja \(3\)/);
  const huge = roundTrip(html.replace('{"question":"Pizza?"}', JSON.stringify({ q: "x".repeat(70_000) })));
  assert.match(huge, /data-plugin-data="null"/);
  // Search reads the plugin's text; Markdown gets a placeholder link.
  assert.match(documentText(saved), /Pizza\? Ja \(3\)/);
  const context = { url: (u: string) => u, linked: () => null };
  const linked = htmlToMarkdown(saved, {
    ...context,
    plugin: (pid: string) => (pid === pluginId ? { name: "Hello Flowplan", url: "https://plugins.example.org/hello/" } : null),
  });
  assert.match(linked, /\[(Erweiterung|Extension): Umfrage\]\(<https:\/\/plugins\.example\.org\/hello\/>\)/);
  assert.match(linked, /Pizza\? Ja \\?\(3\\?\)/);
  assert.match(htmlToMarkdown(saved, context), /^\*(Erweiterung|Extension): Umfrage\*/m);
});

test("permission checks inside a frame", () => {
  const nonce = protocol.createNonce();
  const message = (extra: Record<string, unknown>) => protocol.parsePluginMessage({ protocol: protocol.PROTOCOL, nonce, id: "1", ...extra }, nonce)!;
  const set = message({ type: "setData", data: 1 });
  const query = message({ type: "query", databaseId: db });
  const editing = { readOnly: false, public: false, permissions: ["write:block", `read:database:${db}`] };
  assert.equal(protocol.permissionError(set, editing), null);
  assert.equal(protocol.permissionError(set, { ...editing, readOnly: true }), "read-only");
  assert.equal(protocol.permissionError(set, { ...editing, permissions: [] }), "permission:write:block");
  assert.equal(protocol.permissionError(query, editing), null);
  // Viewers may read with their own rights; published pages never query.
  assert.equal(protocol.permissionError(query, { ...editing, readOnly: true }), null);
  assert.equal(protocol.permissionError(query, { ...editing, public: true }), "public");
  assert.equal(protocol.permissionError(query, { ...editing, permissions: ["write:block"] }), `permission:read:database:${db}`);
  // Context: never who reads; title and selection only with permission.
  const input = { title: "Geheim", theme: "dark" as const, locale: "de", selection: "markiert", readOnly: false, blockType: "poll" };
  const bare = protocol.pluginContext(input, []);
  assert.deepEqual(bare, { theme: "dark", locale: "de", readOnly: false, blockType: "poll" });
  const full = protocol.pluginContext(input, ["read:page", "read:selection"]);
  assert.deepEqual(full.page, { title: "Geheim" });
  assert.equal(full.selection, "markiert");
  assert.ok(!JSON.stringify(full).includes("@"));
});

test("query: granted databases only, with the reader's own rights", async () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "secret", name: "Geheim", type: "text", access: { read: "owners", write: "owners" } },
  ];
  command(owner, { action: "database.update", pageId: db, version: database(db).version, fields, views: database(db).views });
  const shared = (command(owner, { action: "row.create", pageId: db, cells: { title: "Offen", secret: "xyz-geheim" } }) as { id: string }).id;
  const hidden = (command(owner, { action: "row.create", pageId: db, cells: { title: "Privat" } }) as { id: string }).id;
  command(owner, { action: "row.access", pageId: db, rowId: hidden, access: "private", grants: [] });
  const ask = (who: Identity, databaseId = db, pid = pluginId) =>
    plugins.queryPluginDatabase(who, { pluginId: pid, pageId: doc, databaseId });
  // Not granted yet.
  assert.throws(() => ask(owner), (e: { status?: number }) => e.status === 403);
  served.set("https://plugins.example.org/reader/flowplan-plugin.json", {
    body: { ...example, permissions: ["write:block", `read:database:${db}`] },
  });
  const reader = await plugins.registerPlugin(owner, { workspaceId: wid, url: "https://plugins.example.org/reader/" });
  const all = ask(owner, db, reader.id);
  assert.deepEqual(all.rows.map((r) => r.id).sort(), [shared, hidden].sort());
  assert.equal(all.rows.find((r) => r.id === shared)!.cells.secret, "xyz-geheim");
  const limited = ask(viewer, db, reader.id);
  assert.deepEqual(limited.rows.map((r) => r.id), [shared]);
  assert.equal(limited.rows[0].cells.secret, undefined);
  assert.deepEqual(limited.fields.map((f) => f.id), ["title"]);
  assert.ok(!JSON.stringify(limited).includes("xyz-geheim"));
  // Other databases, other workspaces and outsiders get nothing.
  assert.throws(() => ask(owner, foreignDb, reader.id), (e: { status?: number }) => e.status === 403);
  assert.throws(() => ask(stranger, db, reader.id), (e: { status?: number }) => e.status === 403);
  // A switched-off plugin answers nothing.
  command(owner, { action: "plugin.update", pluginId: reader.id, enabled: false });
  assert.throws(() => ask(owner, db, reader.id), (e: { status?: number }) => e.status === 404);
});

test("published pages show a plugin only when its owner allowed it", () => {
  command(owner, { action: "page.publish", pageId: doc, enabled: true });
  const token = one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", doc)!.public_token;
  assert.throws(() => plugins.publicPlugin(token, pluginId), (e: { status?: number }) => e.status === 404);
  command(owner, { action: "plugin.update", pluginId, public: true });
  const shown = plugins.publicPlugin(token, pluginId);
  assert.equal(shown.id, pluginId);
  assert.ok(!shown.permissions.some((p) => p.startsWith("read:database")));
  assert.ok(plugins.publicPluginIds(wid).has(pluginId));
});
