// The Flowplan Marketplace on the server (lib/marketplace-package.ts,
// lib/marketplace-config.ts, lib/marketplace-handover.ts): packages of every
// kind are built permission-checked and read back, imports go through each
// kind's own import, malicious packages are refused, the hand-over messages
// are checked, and switching it off switches everything off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-marketplace-"));
delete process.env.FLOWPLAN_MARKETPLACE_URL;
const setup = await import("./helpers/workflow-setup");
const { owner, editor, viewer, guest, wid, space, node, chain, workflow, user, act } = setup;
const { one, all, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { readZip, writeZip } = await import("../lib/archive");
const pkgs = await import("../lib/marketplace-package");
const cfg = await import("../lib/marketplace-config");
const hand = await import("../lib/marketplace-handover");
const fonts = await import("../lib/workspace-fonts");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { saveWorkspaceLinkRules, workspaceLinkRules } = await import("../lib/auto-link-rules");
const { saveBoardTemplate, listBoardTemplates } = await import("../lib/whiteboard-user-templates");

const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;
const meta = (title: string, extra: Record<string, unknown> = {}) => ({ title, summary: { de: `${title} auf Deutsch.`, en: `${title} in English.` }, category: "projects", tags: ["test"], language: "multi", ...extra });
// The other instance: its own owner and workspace.
const other = await user("other-owner");
const target = await createWorkspace(other.id, "Ziel");
const targetSpace = (await bootstrap(other, target)).spaces[0].id;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

/* ---------- A ZIP writer that does what yazl refuses (bad names, false sizes) ---------- */
function rawZip(entries: { name: string; data: Buffer; deflate?: boolean }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
const manifestOf = (kind: string, payload: string, extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ format: "flowplan-marketplace-1", kind, title: "Böse", summary: { de: "x" }, category: "other", tags: [], minVersion: "0.9.4", language: "de", payload, ...extra }));

/* ---------- Configuration ---------- */

test("FLOWPLAN_MARKETPLACE_URL: default, own address, off, unusable", () => {
  assert.equal(cfg.marketplaceOrigin(undefined), "https://marketplace.flowplan.org");
  assert.equal(cfg.marketplaceOrigin(""), "https://marketplace.flowplan.org");
  assert.equal(cfg.marketplaceOrigin("https://market.example.org/some/path"), "https://market.example.org");
  assert.equal(cfg.marketplaceOrigin("http://localhost:3402"), "http://localhost:3402");
  for (const off of ["off", "OFF", "false", "0", "none"]) assert.equal(cfg.marketplaceOrigin(off), null, off);
  for (const bad of ["http://market.example.org", "javascript:alert(1)", "not a url", "https://user:pw@market.example.org"]) assert.equal(cfg.marketplaceOrigin(bad), null, bad);
  assert.equal(cfg.packageMinVersion("0.9.3"), "0.9.4", "never older than the first version that imports");
  assert.equal(cfg.packageMinVersion("1.2.0-beta.1"), "1.2.0");
  assert.equal(cfg.packageMinVersion(""), "0.9.4");
});

test("the admin switch and FLOWPLAN_MARKETPLACE_URL=off switch everything off", async () => {
  assert.equal((await bootstrap(owner, wid)).instance?.marketplace?.origin, "https://marketplace.flowplan.org");
  await saveInstanceSettings({ marketplace: false });
  try {
    assert.equal((await bootstrap(owner, wid)).instance?.marketplace, null, "no buttons");
    assert.equal(await cfg.marketplaceConfig(), null);
    await assert.rejects(() => cfg.requireMarketplace(), status(404), "the routes answer 404");
  } finally {
    await saveInstanceSettings({ marketplace: true });
  }
  process.env.FLOWPLAN_MARKETPLACE_URL = "off";
  try {
    assert.equal(await cfg.marketplaceConfig(), null);
  } finally {
    delete process.env.FLOWPLAN_MARKETPLACE_URL;
  }
  assert.ok(await cfg.marketplaceConfig());
});

test("no Cross-Origin-Opener-Policy on the pages: window.opener must survive", () => {
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const proxy = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
  assert.doesNotMatch(config + proxy, /Cross-Origin-Opener-Policy/i);
});

/* ---------- The hand-over messages (pure) ---------- */

test("receiver: only the configured origin and the opener, a valid message and a matching checksum", async () => {
  const opener = {};
  const origin = "https://marketplace.flowplan.org";
  assert.equal(hand.trustedSource({ origin, source: opener, data: null }, origin, opener), true);
  assert.equal(hand.trustedSource({ origin: "https://evil.example", source: opener, data: null }, origin, opener), false, "another origin");
  assert.equal(hand.trustedSource({ origin, source: {}, data: null }, origin, opener), false, "another window");
  assert.equal(hand.trustedSource({ origin, source: opener, data: null }, null, opener), false, "switched off");
  assert.equal(hand.trustedSource({ origin, source: null, data: null }, origin, null), false, "no opener");
  const bytes = new TextEncoder().encode("package").buffer as ArrayBuffer;
  const sha256 = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  const good = { type: "flowplan-marketplace-template", id: "t1", version: 2, bytes, sha256, title: "Retro", url: "javascript:alert(1)" };
  const parsed = hand.parseTemplateMessage(good);
  assert.ok(parsed);
  assert.equal(parsed.url, undefined, "only http(s) links");
  assert.equal(await hand.checksumMatches(parsed), true);
  assert.equal(await hand.checksumMatches({ ...parsed, sha256: "0".repeat(64) }), false);
  for (const bad of [
    null,
    "text",
    { ...good, type: "other" },
    { ...good, bytes: "not a buffer" },
    { ...good, bytes: new ArrayBuffer(0) },
    { ...good, bytes: new ArrayBuffer(hand.MAX_PACKAGE_BYTES + 1) },
    { ...good, sha256: "xyz" },
    { ...good, id: "" },
    { ...good, version: "2" },
    { ...good, version: 1.5 },
  ])
    assert.equal(hand.parseTemplateMessage(bad), null, JSON.stringify(bad && typeof bad === "object" ? { ...bad, bytes: undefined } : bad));
  assert.deepEqual(hand.instanceReady("0.9.4"), { type: "flowplan-instance-ready", version: "0.9.4" });
  assert.equal(hand.isSubmitReady({ type: "flowplan-marketplace-ready" }), true);
  assert.equal(hand.isSubmitReady({ type: "flowplan-marketplace-package" }), false);
  assert.equal(hand.isImportHash("#marketplace-import"), true);
  assert.equal(hand.isImportHash("#marketplace-importer"), false);
  assert.equal(hand.submitAddress("https://m.example"), "https://m.example/submit?handover=1");
  assert.equal(hand.uploadAddress("https://m.example"), "https://m.example/submit", "the file way: no hand-over, no warning about a lost window");
  assert.equal(hand.uploadAddress("https://m.example", "https://f.example"), "https://m.example/submit#from=https%3A%2F%2Ff.example");
  assert.ok(hand.READY_MS >= 5000 && hand.READY_MS <= 10_000);
  assert.equal(hand.packageFileName('Team / "Retro"'), "Team - -Retro-.flowplan-template");
});

/* ---------- Round trips per kind ---------- */

async function roundTrip(kind: string, id: string | null, as = owner) {
  const built = await pkgs.buildPackage(as, { kind: kind as never, workspaceId: wid, id }, meta(`Paket ${kind}`), [PNG]);
  assert.ok(built.name.endsWith(".flowplan-template"));
  const entries = await readZip(built.bytes, { foreign: true });
  const manifest = JSON.parse(entries.get("template.json")!.toString());
  assert.equal(manifest.format, "flowplan-marketplace-1");
  assert.equal(manifest.kind, kind);
  assert.equal(manifest.minVersion, "0.9.4");
  assert.ok(entries.has("preview/1.png"));
  const parsed = await pkgs.readPackage(built.bytes);
  const preview = pkgs.packagePreview(parsed);
  assert.equal(preview.kind, kind);
  assert.equal(preview.previews.length, 1);
  return { built, entries, parsed, preview };
}

test("marketplace links carry #from=<this instance> and respect the switch", async () => {
  const config = { origin: "https://marketplace.flowplan.org", version: "1.0.0" };
  const here = "https://flowplan.example.org:8443";
  assert.equal(hand.browseAddress(config, here), "https://marketplace.flowplan.org/#from=https%3A%2F%2Fflowplan.example.org%3A8443");
  assert.equal(hand.browseAddress(config, here, "/t/weekly"), "https://marketplace.flowplan.org/t/weekly#from=https%3A%2F%2Fflowplan.example.org%3A8443");
  assert.equal(hand.browseAddress(config, null), "https://marketplace.flowplan.org/", "while rendering on the server: no fragment");
  assert.equal(hand.browseAddress(null, here), null, "off: no link");
  assert.equal(hand.browseAddress(undefined, here), null);
  assert.equal(hand.submitAddress(config.origin, here), "https://marketplace.flowplan.org/submit?handover=1#from=https%3A%2F%2Fflowplan.example.org%3A8443");
  assert.equal(hand.withFrom("https://m.example/#browse", here), "https://m.example/#browse&from=https%3A%2F%2Fflowplan.example.org%3A8443");
  // A template's url: the fragment only on the configured marketplace.
  assert.equal(hand.marketplacePageAddress("https://marketplace.flowplan.org/t/weekly", config, here), "https://marketplace.flowplan.org/t/weekly#from=https%3A%2F%2Fflowplan.example.org%3A8443");
  assert.equal(hand.marketplacePageAddress("https://elsewhere.example/t/weekly", config, here), "https://elsewhere.example/t/weekly");
  assert.equal(hand.marketplacePageAddress("not a url", config, here), "not a url");
  // The switch: FLOWPLAN_MARKETPLACE_URL=off and the admin switch leave no config, so no link.
  process.env.FLOWPLAN_MARKETPLACE_URL = "off";
  try {
    assert.equal(hand.browseAddress(await cfg.marketplaceConfig(), here), null);
  } finally {
    delete process.env.FLOWPLAN_MARKETPLACE_URL;
  }
  await saveInstanceSettings({ marketplace: false });
  try {
    assert.equal(hand.browseAddress(await cfg.marketplaceConfig(), here), null);
  } finally {
    await saveInstanceSettings({ marketplace: true });
  }
  assert.ok(hand.browseAddress(await cfg.marketplaceConfig(), here)?.startsWith("https://marketplace.flowplan.org/#from="));
});

test("document and database templates: flowplan-template-1 inside, imported into another workspace", async () => {
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Protokoll" })).id;
  await run("UPDATE documents SET html=? WHERE page_id=?", "<h1>Agenda</h1><p>Punkte</p>", page);
  const doc = (await act({ action: "template.save", pageId: page, name: "Meeting-Protokoll" })).id;
  const { entries, parsed, preview } = await roundTrip("document", doc);
  assert.ok(entries.has("payload/template.zip"));
  assert.equal(preview.creates.name, "Meeting-Protokoll");
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  const stored = await one<{ name: string; kind: string; space_id: string }>("SELECT name,kind,space_id FROM templates WHERE id=?", result.templateId as string);
  assert.deepEqual(stored, { name: "Meeting-Protokoll", kind: "document", space_id: targetSpace });

  const db = await setup.makeDatabase("Aufgaben");
  const dbt = (await act({ action: "template.save", pageId: db, name: "Aufgabenliste" })).id;
  const d = await roundTrip("database", dbt);
  assert.ok((d.preview.creates.fields ?? 0) > 0);
  const imported = await pkgs.importPackage(other, d.parsed, { workspaceId: target, private: true });
  assert.equal((await one<{ kind: string; visibility: string }>("SELECT kind,visibility FROM templates WHERE id=?", imported.templateId as string))?.visibility, "private");
});

test("workflows: the export without instance, people or secrets; imported as a paused draft", async () => {
  const graph = chain(
    node("trigger.manual", {}, "Start"),
    node("http.request", { method: "GET", url: "https://api.example.com/v1/items", headers: [{ name: "X-Api-Key", value: "dummy-not-a-secret-4711" }] }, "Abrufen"),
    node("ai.summarize", { text: "{{Abrufen.body}}" }, "Zusammenfassen"),
  );
  const { pageId } = await workflow("Tägliche Zusammenfassung", graph, owner, false);
  // Readers may not publish, editors may.
  await assert.rejects(() => pkgs.buildPackage(viewer, { kind: "workflow", workspaceId: wid, id: pageId }, meta("x")), status(403));
  const { entries, parsed, preview } = await roundTrip("workflow", pageId, editor);
  const file = JSON.parse(entries.get("payload/workflow.json")!.toString());
  assert.equal(file.format, "flowplan.workflow");
  assert.equal(file.source, undefined, "no instance address, no workspace");
  assert.ok(!JSON.stringify(file).includes(wid));
  // The viewer's meta: exactly the node types used, catalogue texts and symbols only.
  const metaFile = JSON.parse(entries.get("payload/workflow-meta.json")!.toString());
  assert.equal(metaFile.format, "flowplan.workflow-meta");
  assert.deepEqual(Object.keys(metaFile.nodes), ["ai.summarize", "http.request", "trigger.manual"]);
  assert.deepEqual(metaFile.nodes["http.request"].name, { de: "HTTP-Anfrage", en: "HTTP request" });
  assert.equal(metaFile.nodes["http.request"].external, true);
  assert.equal(metaFile.nodes["ai.summarize"].ai, true);
  assert.match(metaFile.nodes["trigger.manual"].icon, /^M[0-9MmLlHhVvCcSsQqTtAaZz.,\s-]+$/);
  for (const secret of ["dummy-not-a-secret-4711", "api.example.com", wid, "Abrufen"]) assert.ok(!entries.get("payload/workflow-meta.json")!.toString().includes(secret), secret);
  const wf = preview.creates.workflow!;
  assert.deepEqual(wf.nodes.map((n) => n.label), ["Start", "Abrufen", "Zusammenfassen"]);
  assert.deepEqual(wf.hosts, ["api.example.com"]);
  assert.equal(wf.ai, true);
  assert.equal(wf.email, false);
  await assert.rejects(() => pkgs.importPackage(other, parsed, { workspaceId: target }), /Bereich/);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  const page = await one<{ kind: string; workspace_id: string; title: string }>("SELECT kind,workspace_id,title FROM pages WHERE id=?", result.pageId as string);
  assert.deepEqual(page, { kind: "workflow", workspace_id: target, title: "Tägliche Zusammenfassung" });
  const state = await one<{ status: string; active_version_id: string | null }>("SELECT status,active_version_id FROM workflows WHERE page_id=?", result.pageId as string);
  assert.equal(state?.active_version_id ?? null, null, "never active");
  assert.notEqual(state?.status, "active");
});

test("whiteboard templates: a portable export (pictures uploaded here and record cards stay), imported as an own template", async () => {
  const board = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "whiteboard", title: "Board" })).id;
  const saved = await saveBoardTemplate(owner, board, {
    name: "Retro",
    items: [
      { id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "Gut", pageId: board },
      { id: "s2", type: "text", x: 240, y: 0, w: 200, h: 40, text: "Titel" },
      { id: "i1", type: "image", x: 0, y: 300, w: 100, h: 100, src: "/api/files/abc" },
      { id: "i2", type: "image", x: 200, y: 300, w: 100, h: 100, src: "https://example.org/a.png" },
    ],
  });
  const draft = await pkgs.packageDraft(owner, { kind: "whiteboard", workspaceId: wid, id: saved.id });
  assert.deepEqual(draft.notes, [{ code: "images-dropped", count: 1 }]);
  const { entries, parsed, preview } = await roundTrip("whiteboard", saved.id);
  const file = JSON.parse(entries.get("payload/whiteboard.json")!.toString());
  assert.equal(file.format, "flowplan.whiteboard-template");
  assert.equal(file.version, 1);
  assert.equal(file.items.length, 3);
  assert.ok(!JSON.stringify(file).includes(board), "no page ids of this workspace");
  assert.equal(preview.creates.items, 3);
  // Guests and other editors may not publish someone else's template.
  await assert.rejects(() => pkgs.buildPackage(guest, { kind: "whiteboard", workspaceId: wid, id: saved.id }, meta("x")), status(403));
  await assert.rejects(() => pkgs.buildPackage(editor, { kind: "whiteboard", workspaceId: wid, id: saved.id }, meta("x")), status(403));
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target });
  const otherBoard = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, kind: "whiteboard", title: "B" }, other)).id;
  const listed = await listBoardTemplates(other, otherBoard);
  assert.deepEqual(listed.map((t) => [t.id, t.name, t.items.length]), [[result.templateId, "Retro", 3]]);
  // The marketplace's own guess: a bare list of items.
  const bare = await pkgs.readPackage(rawZip([{ name: "template.json", data: manifestOf("whiteboard", "payload/whiteboard.json") }, { name: "payload/whiteboard.json", data: Buffer.from(JSON.stringify([{ id: "a", type: "sticky", x: 0, y: 0, w: 10, h: 10 }])) }]));
  assert.equal(pkgs.packagePreview(bare).creates.items, 1);
});

test("appearance: owners only, with the typefaces it uses; replaces the look where it is applied", async () => {
  const inter = readFileSync(join(process.cwd(), "public/fonts/theme/inter-latin-wght-normal.woff2"));
  const face = await fonts.uploadWorkspaceFont(owner, wid, { name: "Hausschrift", file: { name: "Hausschrift.woff2", bytes: inter } });
  const faceId = face.id;
  await assert.rejects(() => pkgs.packageDraft(owner, { kind: "appearance", workspaceId: wid }), /kein eigenes Erscheinungsbild/);
  await fonts.saveWorkspaceTheme(owner, wid, { accent: "#2f6f5e", fonts: { ui: `custom:${faceId}` } });
  for (const who of [editor, viewer, guest]) await assert.rejects(() => pkgs.buildPackage(who, { kind: "appearance", workspaceId: wid }, meta("x")), status(403), who.name);
  const { entries, parsed, preview } = await roundTrip("appearance", null);
  const file = JSON.parse(entries.get("payload/theme.json")!.toString());
  assert.equal(file.format, "flowplan.workspace-look");
  assert.equal(file.theme.accent, "#2f6f5e");
  assert.ok(entries.has(`payload/fonts/${faceId}.woff2`));
  assert.deepEqual(preview.creates.fonts, ["Hausschrift"]);
  await fonts.saveWorkspaceTheme(other, target, { accent: "#aa0000" });
  const outsider = await user("ziel-editor");
  await run("INSERT INTO members VALUES(?,?,?)", target, outsider.id, "editor");
  await assert.rejects(() => pkgs.importPackage(outsider, parsed, { workspaceId: target }), status(403));
  await pkgs.importPackage(other, parsed, { workspaceId: target });
  const look = await fonts.workspaceLook(target);
  assert.equal(look.theme?.accent, "#2f6f5e", "replaced");
  assert.equal(look.fonts.length, 1);
  assert.notEqual(look.fonts[0].id, faceId, "a face of its own");
  assert.equal(look.theme?.fonts?.ui, `custom:${look.fonts[0].id}`);
});

test("link rules: owners only; added to the rules of the target", async () => {
  await saveWorkspaceLinkRules(owner, wid, [{ name: "Jira", pattern: "\\bABC-\\d+\\b", template: "https://jira.example/browse/{match}", enabled: true }]);
  for (const who of [editor, guest]) await assert.rejects(() => pkgs.buildPackage(who, { kind: "link-rules", workspaceId: wid }, meta("x")), status(403));
  const { entries, parsed, preview } = await roundTrip("link-rules", null);
  const file = JSON.parse(entries.get("payload/link-rules.json")!.toString());
  assert.equal(file.format, "flowplan.link-rules");
  assert.equal(file.rules[0].id, undefined, "no ids of this workspace");
  assert.equal(preview.creates.rules?.length, 1);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target });
  assert.equal(result.added, 1);
  assert.deepEqual((await workspaceLinkRules(target)).map((r) => r.pattern), ["\\bABC-\\d+\\b"]);
});

test("guests and strangers never publish; the details and pictures are checked", async () => {
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Notiz" })).id;
  const tpl = (await act({ action: "template.save", pageId: page, name: "Notiz" })).id;
  await assert.rejects(() => pkgs.buildPackage(guest, { kind: "document", workspaceId: wid, id: tpl }, meta("x")), status(403));
  await assert.rejects(() => pkgs.packageDraft(guest, { kind: "document", workspaceId: wid, id: tpl }), status(403));
  const stranger = await user("stranger");
  await assert.rejects(() => pkgs.buildPackage(stranger, { kind: "document", workspaceId: wid, id: tpl }, meta("x")), status(403));
  // Someone else's template: not for an editor.
  await assert.rejects(() => pkgs.buildPackage(editor, { kind: "document", workspaceId: wid, id: tpl }, meta("x")), status(403));
  await assert.rejects(() => pkgs.buildPackage(owner, { kind: "document", workspaceId: wid, id: tpl }, meta("x", { summary: { de: "", en: "" } })), /Kurzbeschreibung/);
  await assert.rejects(() => pkgs.buildPackage(owner, { kind: "document", workspaceId: wid, id: tpl }, meta("x"), [Buffer.from("<svg/>")]), /WebP-, PNG- oder JPEG/);
  await assert.rejects(() => pkgs.buildPackage(owner, { kind: "document", workspaceId: wid, id: tpl }, meta("x"), [PNG, PNG, PNG, PNG, PNG]), /Höchstens 4/);
  await assert.rejects(() => pkgs.buildPackage(owner, { kind: "document", workspaceId: wid, id: tpl }, meta("x"), [Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])]), status(413));
  const audited = await all("SELECT 1 FROM audit WHERE action='marketplace.package'");
  assert.ok(audited.length >= 5, "building is in the activity log");
});

/* ---------- Malicious packages ---------- */

test("malicious packages are refused: zip bomb, traversal, oversized, wrong kind, broken envelope", async () => {
  const good = manifestOf("link-rules", "payload/link-rules.json");
  const rules = Buffer.from(JSON.stringify({ rules: [{ pattern: "X-\\d+", template: "https://x.example/{match}" }] }));
  // The baseline is fine.
  assert.equal((await pkgs.readPackage(rawZip([{ name: "template.json", data: good }, { name: "payload/link-rules.json", data: rules }]))).manifest.kind, "link-rules");
  const refused = async (bytes: Buffer, match: RegExp | ((e: unknown) => boolean), label: string) => await assert.rejects(() => pkgs.readPackage(bytes), match, label);
  // A zip bomb: 200 MB of zeros in a few hundred KB.
  await refused(rawZip([{ name: "template.json", data: good }, { name: "payload/link-rules.json", data: Buffer.alloc(200 * 1024 * 1024), deflate: true }]), (e) => [400, 413].includes((e as { status?: number }).status ?? 0), "zip bomb");
  // Path traversal and absolute paths.
  await refused(rawZip([{ name: "template.json", data: good }, { name: "../../etc/passwd", data: rules }]), (e) => (e as { status?: number }).status === 400, "traversal");
  await refused(rawZip([{ name: "template.json", data: good }, { name: "/abs/file", data: rules }]), (e) => (e as { status?: number }).status === 400, "absolute");
  await refused(rawZip([{ name: "template.json", data: manifestOf("link-rules", "payload/../template.json") }, { name: "payload/link-rules.json", data: rules }]), /ungültig/, "payload outside payload/");
  // Too large: the file, template.json.
  await refused(Buffer.alloc(25 * 1024 * 1024 + 1), status(413), "file > 25 MB");
  await refused(rawZip([{ name: "template.json", data: manifestOf("link-rules", "payload/link-rules.json", { pad: "x".repeat(70_000) }) }]), status(413), "template.json > 64 KB");
  // Wrong kind or format.
  await refused(rawZip([{ name: "template.json", data: manifestOf("plugin", "payload/x.json") }]), /Marketplace-Vorlage|ungültig/, "unknown kind");
  await refused(rawZip([{ name: "template.json", data: Buffer.from(JSON.stringify({ format: "flowplan-template-1" })) }]), /Keine Marketplace-Vorlage/, "a plain template");
  await refused(rawZip([{ name: "template.json", data: manifestOf("workflow", "payload/link-rules.json") }, { name: "payload/link-rules.json", data: rules }]), /Workflow-Datei/, "rules declared as a workflow");
  await refused(rawZip([{ name: "template.json", data: manifestOf("document", "payload/template.zip") }, { name: "payload/template.zip", data: rawZip([{ name: "template.json", data: Buffer.from(JSON.stringify({ format: "flowplan-template-1", kind: "database", name: "x", payload: "{}", files: [] })) }]) }]), /Art der Vorlage/, "database template declared as a document");
  await refused(rawZip([{ name: "template.json", data: manifestOf("link-rules", "payload/link-rules.json") }]), /fehlt/, "payload missing");
  await refused(rawZip([{ name: "payload/link-rules.json", data: rules }]), /template\.json fehlt/, "no template.json");
  await refused(Buffer.from("not a zip at all"), status(400), "not a zip");
  await refused(rawZip([{ name: "template.json", data: Buffer.from("{nope") }]), status(400), "broken JSON");
  await refused(rawZip([{ name: "template.json", data: good }, { name: "payload/link-rules.json", data: Buffer.from(JSON.stringify({ rules: [{ pattern: "(a+)+$", template: "javascript:alert(1)" }] })) }]), /Keine der Linkregeln/, "only unsafe rules");
  await refused(rawZip([{ name: "template.json", data: manifestOf("appearance", "payload/theme.json") }, { name: "payload/theme.json", data: Buffer.from(JSON.stringify({ theme: { accent: "red; background:url(x)" } })) }]), /Erscheinungsbild ist ungültig/, "a look that is not a look");
  await refused(rawZip([{ name: "template.json", data: manifestOf("appearance", "payload/theme.json") }, { name: "payload/theme.json", data: Buffer.from(JSON.stringify({ theme: { accent: "#123456" }, fonts: [{ id: "f", name: "Fake", file: "payload/fonts/f.woff2" }] })) }, { name: "payload/fonts/f.woff2", data: Buffer.alloc(100, 7) }]), /keine Schrift/, "a font that is not a font");
  // Whiteboard items with script-like content are dropped by the item schema; only unsafe ones → empty.
  await refused(rawZip([{ name: "template.json", data: manifestOf("whiteboard", "payload/whiteboard.json") }, { name: "payload/whiteboard.json", data: Buffer.from(JSON.stringify({ items: [{ id: "x", type: "image", x: 0, y: 0, w: 1, h: 1, src: "javascript:alert(1)" }] })) }]), /leer/, "only unsafe items");
  // Unknown fields are fine (the marketplace adds license, author, marketplace).
  const extras = await pkgs.readPackage(rawZip([{ name: "template.json", data: manifestOf("link-rules", "payload/link-rules.json", { license: "CC0-1.0", author: { name: "Ada", handle: "ada" }, marketplace: { id: "t1", slug: "x", version: 3, url: "https://marketplace.flowplan.org/t/x" }, future: { anything: true } }) }, { name: "payload/link-rules.json", data: rules }]));
  const p = pkgs.packagePreview(extras);
  assert.deepEqual([p.license, p.author, p.url], ["CC0-1.0", "Ada", "https://marketplace.flowplan.org/t/x"]);
});

test("a nested template.zip bomb is refused before the template import", async () => {
  const inner = rawZip([{ name: "template.json", data: Buffer.from(JSON.stringify({ format: "flowplan-template-1", kind: "document", name: "x", payload: JSON.stringify({ html: "<p/>" }), files: [] })) }, { name: "files/00000000-0000-4000-8000-000000000000", data: Buffer.alloc(150 * 1024 * 1024), deflate: true }]);
  await assert.rejects(() => pkgs.readPackage(rawZip([{ name: "template.json", data: manifestOf("document", "payload/template.zip") }, { name: "payload/template.zip", data: inner }])), (e) => [400, 413].includes((e as { status?: number }).status ?? 0));
});

test("packages written with yazl by the builder read back identically", async () => {
  const bytes = await writeZip(new Map([["template.json", manifestOf("link-rules", "payload/link-rules.json")], ["payload/link-rules.json", Buffer.from(JSON.stringify([{ pattern: "Y-\\d+", template: "https://y.example/{match}" }]))]]));
  assert.equal(pkgs.packagePreview(await pkgs.readPackage(bytes)).creates.rules?.length, 1);
});

/* ---------- The templates that come with Flowplan (scripts/marketplace-official.mjs) ---------- */

test("official packages: every built-in template, deterministic, valid, and each kind imports", async () => {
  const { officialPackages, OFFICIAL_SKIPPED } = await import("../lib/marketplace-official");
  const { templateCatalog } = await import("../lib/template-catalog");
  const { galleryTemplates } = await import("../lib/whiteboard-template-gallery");
  const { TEMPLATE_IDS } = await import("../lib/workflows/templates");
  const { draftOf } = await import("../lib/workflows/store");
  const { extraOfficial } = await import("../lib/marketplace-official-extra");
  const every = await officialPackages("0.9.4");
  const again = await officialPackages("0.9.4");
  assert.deepEqual(every.map((p) => p.bytes.toString("base64")), again.map((p) => p.bytes.toString("base64")), "byte for byte the same");
  assert.equal(new Set(every.map((p) => p.file)).size, every.length, "unique file names");
  // The built-in ones here; the marketplace-only ones in tests/marketplace-official-extra.test.ts.
  const extra = new Set(extraOfficial.map((x) => `${x.kind}:${x.id}`));
  const first = every.filter((p) => !extra.has(`${p.kind}:${p.id}`));
  assert.equal(every.length - first.length, extraOfficial.length);
  const count = (kind: string) => first.filter((p) => p.kind === kind).length;
  const catalog = Object.keys(templateCatalog).filter((key) => !OFFICIAL_SKIPPED.includes(key));
  assert.equal(count("document") + count("database"), catalog.length);
  assert.equal(count("whiteboard"), galleryTemplates.length);
  assert.equal(count("workflow"), TEMPLATE_IDS.length);
  assert.equal(new Set(first.map((p) => p.file)).size, first.length, "unique file names");
  // The marketplace takes the file name as the slug: a-z, 0-9 and -, at most 60.
  for (const p of first) assert.match(p.file, /^[a-z0-9][a-z0-9-]{0,59}\.flowplan-template$/, p.file);
  const imported = new Set<string>();
  for (const pkg of first) {
    assert.match(pkg.file, /^(document|database|whiteboard|workflow)-[a-z0-9-]+\.flowplan-template$/i);
    const parsed = await pkgs.readPackage(pkg.bytes);
    const m = parsed.manifest;
    assert.equal(m.license, "CC0-1.0");
    assert.equal(m.minVersion, "0.9.4");
    assert.ok(m.summary.de && m.summary.en, `${pkg.file}: summaries in both languages`);
    // Every template of a kind imports (workflows: one page each is enough).
    if (pkg.kind === "workflow" && imported.has("workflow")) continue;
    const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
    imported.add(pkg.kind);
    if (pkg.kind === "workflow") {
      const page = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", result.pageId as string))!;
      assert.doesNotMatch(JSON.stringify(await draftOf(page)), /\$ask:/, "open gaps are cleared");
      assert.ok((result.gaps ?? 0) > 0, "the gaps are counted");
      assert.ok((pkgs.packagePreview(parsed).creates.workflow?.gaps ?? []).length > 0, "and listed in the preview");
    } else assert.ok(result.templateId, pkg.file);
  }
  assert.deepEqual([...imported].sort(), ["database", "document", "whiteboard", "workflow"]);
  // The other workflows build a valid graph with their gaps cleared as well.
  for (const pkg of first.filter((p) => p.kind === "workflow")) {
    const parsed = await pkgs.readPackage(pkg.bytes);
    assert.equal(parsed.payload.kind, "workflow");
    if (parsed.payload.kind === "workflow") assert.doesNotMatch(JSON.stringify(parsed.payload.data.graph), /\$ask:/, pkg.file);
  }
});
