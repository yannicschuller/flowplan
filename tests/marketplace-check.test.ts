// The import check of marketplace packages (lib/marketplace-check.ts,
// POST /api/marketplace/check): tokens need the permission "Marketplace-
// Prüfung" (off by default, never a real import), the check never keeps
// anything, the dry run catches what only fails on insert, malicious
// packages are refused, and it is rate-limited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-marketplace-check-"));
delete process.env.FLOWPLAN_MARKETPLACE_URL;
const setup = await import("./helpers/workflow-setup");
const { owner, viewer, guest, wid, space, act, user, node, chain, workflow } = setup;
const { one, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { readZip, writeZip } = await import("../lib/archive");
const pkgs = await import("../lib/marketplace-package");
const check = await import("../lib/marketplace-check");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { saveWorkspaceLinkRules } = await import("../lib/auto-link-rules");

const status = (code: number) => (e: unknown) => (e as { status?: number }).status === code;
const meta = (title: string) => ({ title, summary: { de: `${title}.`, en: `${title}.` }, category: "projects", tags: [], language: "multi" });
const build = async (kind: string, id: string | null) => (await pkgs.buildPackage(owner, { kind: kind as never, workspaceId: wid, id }, meta(`Paket ${kind}`))).bytes;
const tokenFor = async (scope: "read" | "write" | "clipper", marketplaceCheck: boolean) => {
  const { token } = (await command(owner, { action: "token.create", name: `T ${scope} ${marketplaceCheck}`, scope, marketplaceCheck })) as { token: string };
  return (await identityFromApiToken(`Bearer ${token}`, { clipper: scope === "clipper" }))!;
};
// Everything an import could leave behind.
const TABLES = ["templates", "template_files", "pages", "rows", "documents", "files", "whiteboard_templates", "workspace_fonts", "workflows", "audit"];
async function snapshot() {
  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = Number((await one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))?.n ?? 0);
  const ws = await one<{ theme: string | null; link_rules: string | null }>("SELECT theme,link_rules FROM workspaces WHERE id=?", wid);
  const uploads = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  return { counts, theme: ws?.theme ?? null, rules: ws?.link_rules ?? null, uploads: existsSync(uploads) ? readdirSync(uploads).length : 0 };
}

// A document template with an attachment, a database template with records.
const docPage = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Protokoll" })).id as string;
await run("UPDATE documents SET html=? WHERE page_id=?", "<h1>Agenda</h1><p>Punkte</p>", docPage);
const docTemplate = (await act({ action: "template.save", pageId: docPage, name: "Meeting-Protokoll" })).id as string;
const dbPage = await setup.makeDatabase("Aufgaben");
await act({ action: "row.create", pageId: dbPage, cells: {} });
const dbTemplate = (await act({ action: "template.save", pageId: dbPage, name: "Aufgabenliste" })).id as string;

test("permission: sessions pass; tokens only with “Marketplace-Prüfung”; clipper and demo never", async () => {
  check.requireMarketplaceCheck(owner);
  for (const scope of ["read", "write"] as const) {
    const plain = await tokenFor(scope, false);
    assert.equal(plain.apiMarketplaceCheck, undefined, "off unless chosen");
    assert.throws(() => check.requireMarketplaceCheck(plain), status(403));
    await assert.rejects(() => check.checkPackage(plain, Buffer.from("x")), status(403));
    const allowed = await tokenFor(scope, true);
    assert.equal(allowed.apiMarketplaceCheck, true);
    check.requireMarketplaceCheck(allowed);
  }
  const clipper = await tokenFor("clipper", true);
  assert.equal(clipper.apiMarketplaceCheck, undefined, "never for clipper tokens");
  assert.throws(() => check.requireMarketplaceCheck(clipper), status(403));
  assert.throws(() => check.requireMarketplaceCheck({ ...owner, demo: true }), status(403));
  const row = await one<{ marketplace_check: number }>("SELECT marketplace_check FROM api_tokens WHERE name='T read true'");
  assert.equal(row?.marketplace_check, 1);
});

test("the permission never allows a real import: a read token with it is still refused by commands", async () => {
  const token = await tokenFor("read", true);
  await assert.rejects(() => command(token, { action: "page.create", workspaceId: wid, spaceId: space, title: "x" }), status(403));
});

test("good packages of every kind: ok, what would be created, nothing kept", async () => {
  const token = await tokenFor("read", true);
  await saveWorkspaceLinkRules(owner, wid, [{ name: "Ticket", pattern: "T-(\\d+)", template: "https://t.example/$1", enabled: true }]);
  const rulesPkg = await build("link-rules", null);
  await saveWorkspaceLinkRules(owner, wid, []);
  const { pageId: flow } = await workflow("Zusammenfassen", chain(node("trigger.manual", {}, "Start"), node("ai.summarize", { text: "{{Start.text}}" }, "Kurz")), owner, false);
  const [docPkg, dbPkg, wfPkg] = [await build("document", docTemplate), await build("database", dbTemplate), await build("workflow", flow)];
  const before = await snapshot();
  const doc = await check.checkPackage(token, docPkg, { workspaceId: wid });
  assert.equal(doc.ok, true, JSON.stringify(doc.errors));
  assert.equal(doc.kind, "document");
  assert.equal(doc.dryRun.ran, true);
  assert.equal(doc.dryRun.rolledBack, true);
  assert.deepEqual([doc.creates.templates, doc.creates.pages], [1, 1]);
  const db = await check.checkPackage(token, dbPkg, { workspaceId: wid });
  assert.equal(db.ok, true, JSON.stringify(db.errors));
  assert.ok((db.creates.fields ?? 0) > 0 && (db.creates.views ?? 0) > 0);
  assert.equal(db.creates.records, 1, "the record was really inserted in the dry run");
  const wf = await check.checkPackage(token, wfPkg, { workspaceId: wid });
  assert.equal(wf.ok, true, JSON.stringify(wf.errors));
  assert.equal(wf.creates.nodes, 2);
  const rules = await check.checkPackage(token, rulesPkg, { workspaceId: wid });
  assert.equal(rules.ok, true);
  assert.equal(rules.creates.rules, 1);
  assert.deepEqual(await snapshot(), before, "no row, file or setting kept");
  assert.ok(!(await one("SELECT 1 FROM audit WHERE action='marketplace.import'")), "no import audited");
});

test("the dry run catches a broken database template that only fails on insert", async () => {
  const token = await tokenFor("read", true);
  const bytes = await build("database", dbTemplate);
  const outer = await readZip(bytes, { foreign: true });
  const inner = await readZip(outer.get("payload/template.zip")!, { foreign: true });
  const t = JSON.parse(inner.get("template.json")!.toString());
  const content = JSON.parse(t.payload);
  // Two properties with the same id: the schema takes it, creating a page refuses it.
  content.database.fields.push({ ...content.database.fields[0] });
  t.payload = JSON.stringify(content);
  inner.set("template.json", Buffer.from(JSON.stringify(t)));
  outer.set("payload/template.zip", await writeZip(inner));
  const broken = await writeZip(outer);
  // The import's own reading (the old preview=1) finds nothing wrong …
  assert.ok(pkgs.packagePreview(await pkgs.readPackage(broken)).creates);
  const before = await snapshot();
  // … the dry run does.
  const r = await check.checkPackage(token, broken, { workspaceId: wid });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "import_failed");
  assert.match(r.errors[0].de, /Doppelte/);
  assert.match(r.errors[0].en, /\w/);
  assert.deepEqual(await snapshot(), before, "rolled back");
  // Without the dry run it would have passed.
  const shallow = await check.checkPackage(token, broken, { dryRun: false });
  assert.equal(shallow.ok, true);
  assert.equal(shallow.dryRun.reason, "off");
});

test("malicious and broken packages are refused with a code, nothing is kept", async () => {
  const token = await tokenFor("read", true);
  const before = await snapshot();
  const manifest = (extra: Record<string, unknown>) => Buffer.from(JSON.stringify({ format: "flowplan-marketplace-1", kind: "link-rules", title: "x", summary: { de: "x" }, category: "other", tags: [], minVersion: "0.9.4", language: "de", payload: "payload/link-rules.json", ...extra }));
  const notZip = await check.checkPackage(token, Buffer.from("not a zip"), { workspaceId: wid });
  assert.equal(notZip.ok, false);
  assert.match(notZip.errors[0].code, /^package_/);
  const bomb = await writeZip(new Map([["template.json", manifest({})], ["payload/link-rules.json", Buffer.alloc(80 * 1024 * 1024)]]));
  const b = await check.checkPackage(token, bomb, { workspaceId: wid });
  assert.equal(b.ok, false);
  assert.match(b.errors[0].code, /^package_/);
  const unsafe = await writeZip(new Map([["template.json", manifest({})], ["payload/link-rules.json", Buffer.from(JSON.stringify({ rules: [{ pattern: "(a+)+$", template: "javascript:alert(1)" }] }))]]));
  const u = await check.checkPackage(token, unsafe, { workspaceId: wid });
  assert.equal(u.ok, false);
  assert.equal(u.errors[0].code, "package_link_rules");
  const tooBig = await check.checkPackage(token, Buffer.alloc(25 * 1024 * 1024 + 1), { workspaceId: wid });
  assert.equal(tooBig.errors[0].code, "package_too_large");
  // A workflow with a step type this Flowplan does not know.
  const graph = chain(node("trigger.manual", {}, "Start"));
  const data = { format: "flowplan.workflow", version: 1, title: "Fremd", graph: { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: "n_shell001", type: "system.shell" }] }, references: {} };
  const wfPkg = await writeZip(new Map([["template.json", Buffer.from(JSON.stringify({ format: "flowplan-marketplace-1", kind: "workflow", title: "Fremd", summary: { de: "x" }, category: "other", tags: [], minVersion: "0.9.4", language: "de", payload: "payload/workflow.json" }))], ["payload/workflow.json", Buffer.from(JSON.stringify(data))]]));
  const w = await check.checkPackage(token, wfPkg, { workspaceId: wid }).catch((e) => ({ ok: false, errors: [{ code: `thrown:${(e as Error).message}` }] }));
  assert.equal(w.ok, false, JSON.stringify(w));
  assert.deepEqual(await snapshot(), before);
});

test("workspace: given ones need membership (not as a guest); without one the caller's own", async () => {
  const token = await tokenFor("read", true);
  const bytes = await build("document", docTemplate);
  const stranger = await user("stranger");
  await assert.rejects(() => check.checkPackage(stranger, bytes, { workspaceId: wid }), (e) => [403, 404].includes((e as { status?: number }).status ?? 0));
  await assert.rejects(() => check.checkPackage(guest, bytes, { workspaceId: wid }), status(403));
  const auto = await check.checkPackage(token, bytes);
  assert.equal(auto.dryRun.workspace, true);
  const nowhere = await check.checkPackage(stranger, bytes);
  assert.equal(nowhere.dryRun.ran, false);
  assert.equal(nowhere.dryRun.reason, "no_workspace");
  // A viewer: read, but the dry run needs edit rights.
  const asViewer = await check.checkPackage(viewer, bytes, { workspaceId: wid });
  assert.ok(asViewer.warnings.some((w) => w.code === "dry_run_role"));
});

test("official workflows with gaps pass: steps completed on import are hints, not errors", async () => {
  const { officialPackages } = await import("../lib/marketplace-official");
  const flows = (await officialPackages("0.9.4")).filter((p) => p.kind === "workflow");
  assert.ok(flows.length >= 6);
  let gapped = 0;
  for (const f of flows) {
    const r = await check.checkPackage(owner, f.bytes, { dryRun: false });
    assert.deepEqual(r.errors, [], `${f.file}: ${JSON.stringify(r.errors)}`);
    if (r.warnings.some((w) => w.code === "gaps")) gapped++;
  }
  assert.ok(gapped > 0, "some official workflows have gaps");
});

test("rate limit: at most 30 checks in 10 minutes per person", async () => {
  const busy = await user("busy");
  for (let i = 0; i < 30; i++) await check.checkPackage(busy, Buffer.from("x"));
  await assert.rejects(() => check.checkPackage(busy, Buffer.from("x")), status(429));
});
