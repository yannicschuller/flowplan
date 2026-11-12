// Workspace settings in backups (#196, #202): the automatic link rules and
// the look (theme and uploaded faces) travel in the ZIP archive and the JSON
// export, are checked on import like the settings (invalid ones left out
// and counted, never the whole import), and older archives without them
// still import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-archive-settings-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { exportArchive, importArchive, jsonExportWorkspace, readZip, writeZip } = await import("../lib/archive");
const fonts = await import("../lib/workspace-fonts");
const { workspaceLinkRules } = await import("../lib/auto-link-rules");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("settings-owner"),
  restorer = await account("settings-restorer");
const wid = await createWorkspace(owner.id, "Quelle");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!;
await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Notizen" });

const inter = readFileSync(join(process.cwd(), "public/fonts/theme/inter-latin-wght-normal.woff2"));
const JIRA = { name: "Jira", pattern: "\\bABC-\\d+\\b", template: "https://jira.example/browse/{match}", enabled: true };
const ISSUES = { pattern: "#(\\d+)", template: "https://github.com/acme/app/issues/$1", enabled: false };
const face = await fonts.uploadWorkspaceFont(owner, wid, { name: "Hausschrift", file: { name: "Hausschrift.woff2", bytes: inter } });
await command(owner, { action: "workspace.theme", workspaceId: wid, theme: { accent: "#be123c", background: "sepia", fonts: { display: `custom:${face.id}`, mono: "source-code-pro" } } });
await command(owner, { action: "workspace.linkRules", workspaceId: wid, rules: [JIRA, ISSUES] });

const zip = await exportArchive(owner, wid);
const entries = await readZip(zip);
const manifest = JSON.parse(entries.get("flowplan.json")!.toString("utf8"));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
// A copy of the archive with a changed manifest (and files).
async function crafted(change: (m: typeof manifest, files: Map<string, Buffer>) => void) {
  const copy = new Map([...entries].map(([k, v]) => [k, v as Buffer]));
  const m = structuredClone(manifest);
  change(m, copy);
  copy.set("flowplan.json", Buffer.from(JSON.stringify(m)));
  return await writeZip(copy);
}

test("round trip: link rules and the look with its uploaded face come back in a fresh workspace", async () => {
  assert.deepEqual(manifest.linkRules.map((r: { pattern: string }) => r.pattern), [JIRA.pattern, ISSUES.pattern]);
  assert.equal(manifest.look.theme.accent, "#be123c");
  assert.ok(entries.has(`fonts/${face.id}`));
  const target = await createWorkspace(restorer.id, "Ziel");
  const result = await importArchive(restorer, target, zip);
  assert.deepEqual(result.omittedSettings, { linkRules: 0, fonts: 0, theme: 0, printPresets: 0 });
  const rules = await workspaceLinkRules(target);
  assert.deepEqual(rules.map((r) => [r.name, r.pattern, r.template, r.enabled]), [
    ["Jira", JIRA.pattern, JIRA.template, true],
    ["", ISSUES.pattern, ISSUES.template, false],
  ]);
  const look = await fonts.workspaceLook(target, true);
  assert.equal(look.theme?.accent, "#be123c");
  assert.equal(look.theme?.background, "sepia");
  assert.equal(look.theme?.fonts?.mono, "source-code-pro");
  const restored = look.fonts.find((f) => f.name === "Hausschrift");
  assert.ok(restored && restored.id !== face.id);
  assert.equal(look.theme?.fonts?.display, `custom:${restored.id}`);
  const stored = await one<{ workspace_id: string; created_by: string }>("SELECT workspace_id,created_by FROM workspace_fonts WHERE id=?", restored.id);
  assert.deepEqual({ ...stored }, { workspace_id: target, created_by: restorer.id });
  // The source workspace is untouched.
  assert.equal((await workspaceLinkRules(wid)).length, 2);
});

test("into a workspace that has rules and a look: rules are added (its own win), its look stays", async () => {
  const target = await createWorkspace(restorer.id, "Eigenes");
  await command(restorer, { action: "workspace.theme", workspaceId: target, theme: { accent: "#15803d" } });
  await command(restorer, { action: "workspace.linkRules", workspaceId: target, rules: [{ pattern: JIRA.pattern, template: "https://own.example/{match}" }] });
  await importArchive(restorer, target, zip);
  assert.deepEqual((await fonts.workspaceLook(target)).theme, { accent: "#15803d" });
  const rules = await workspaceLinkRules(target);
  assert.deepEqual(rules.map((r) => [r.pattern, r.template]), [
    [JIRA.pattern, "https://own.example/{match}"],
    [ISSUES.pattern, ISSUES.template],
  ]);
  // An editor (not owner) of the target brings pages only.
  const shared = await createWorkspace(owner.id, "Geteilt");
  await run("INSERT INTO members VALUES(?,?,?)", shared, restorer.id, "editor");
  await importArchive(restorer, shared, zip);
  assert.deepEqual(await workspaceLinkRules(shared), []);
  assert.equal((await fonts.workspaceLook(shared)).theme, null);
});

test("a crafted archive: invalid rules, an oversized and a fake face and a bad theme are left out, the rest is imported", async () => {
  const big = Buffer.concat([inter, Buffer.alloc(fonts.FONT_LIMITS.bytes)]);
  const fake = Buffer.alloc(2048, 7);
  const [bigId, fakeId] = [id(), id()];
  const archive = await crafted((m, files) => {
    m.linkRules = [
      { pattern: "(a+)+", template: "https://x.example/{match}" }, // nested repeat
      { pattern: "[", template: "https://x.example/{match}" }, // not a regular expression
      { pattern: "x*", template: "https://x.example/{match}" }, // matches empty text
      { pattern: "TICKET-\\d+", template: "javascript:alert(1)" }, // unsafe address
      { pattern: "a".repeat(201), template: "https://x.example/{match}" }, // too long
      "not a rule",
      JIRA,
      ...Array.from({ length: 60 }, (_, i) => ({ pattern: `R${i}-\\d+`, template: "https://r.example/{match}" })),
    ];
    m.look.fonts.push({ id: bigId, name: "Riesig", size: big.length, sha256: sha256(big) }, { id: fakeId, name: "Falsch", size: fake.length, sha256: sha256(fake) });
    files.set(`fonts/${bigId}`, big);
    files.set(`fonts/${fakeId}`, fake);
  });
  const target = await createWorkspace(restorer.id, "Gebastelt");
  const result = await importArchive(restorer, target, archive);
  assert.ok(result.pages >= 1, "the pages are imported");
  // 6 invalid + 11 beyond the 50 rules (JIRA + 49 more fit).
  assert.equal(result.omittedSettings.linkRules, 6 + 11);
  assert.equal(result.omittedSettings.fonts, 2);
  const rules = await workspaceLinkRules(target);
  assert.equal(rules.length, 50);
  assert.equal(rules[0].pattern, JIRA.pattern);
  const look = await fonts.workspaceLook(target, true);
  assert.deepEqual(look.fonts.map((f) => f.name), ["Hausschrift"]);
  assert.equal(look.theme?.accent, "#be123c");

  // A theme that does not pass the settings' schema is left out; the face still comes.
  const badTheme = await crafted((m) => {
    m.look.theme = { accent: "red", css: "body{}" };
    m.linkRules = "nonsense";
  });
  const other = await createWorkspace(restorer.id, "Ohne Farbe");
  const second = await importArchive(restorer, other, badTheme);
  assert.deepEqual(second.omittedSettings, { linkRules: 1, fonts: 0, theme: 1, printPresets: 0 });
  const otherLook = await fonts.workspaceLook(other, true);
  assert.equal(otherLook.theme, null);
  assert.deepEqual(otherLook.fonts.map((f) => f.name), ["Hausschrift"]);
});

test("a face beyond the workspace quota is left out, not the import", async () => {
  const padded = Buffer.concat([inter, Buffer.alloc(1024 * 1024 + 1)]);
  assert.ok(fonts.sniffFont(padded), "still a font");
  const archive = await crafted((m, files) => {
    m.look.fonts = [{ id: face.id, name: "Gepolstert", size: padded.length, sha256: sha256(padded) }];
    files.set(`fonts/${face.id}`, padded);
  });
  const target = await createWorkspace(restorer.id, "Knapp");
  await run("UPDATE workspaces SET quota_mb=1 WHERE id=?", target);
  const result = await importArchive(restorer, target, archive);
  assert.equal(result.omittedSettings.fonts, 1);
  const look = await fonts.workspaceLook(target, true);
  assert.deepEqual(look.fonts, []);
  // Its slot goes back to the default; the rest of the look stays.
  assert.deepEqual(look.theme, { accent: "#be123c", background: "sepia", fonts: { mono: "source-code-pro" } });
});

test("an archive from before (no link rules, no look) still imports", async () => {
  const archive = await crafted((m, files) => {
    delete m.linkRules;
    for (const f of m.look.fonts) files.delete(`fonts/${f.id}`);
    delete m.look;
  });
  const target = await createWorkspace(restorer.id, "Alt");
  const result = await importArchive(restorer, target, archive);
  assert.ok(result.pages >= 1);
  assert.deepEqual(result.omittedSettings, { linkRules: 0, fonts: 0, theme: 0, printPresets: 0 });
  assert.deepEqual(await workspaceLinkRules(target), []);
  assert.equal((await fonts.workspaceLook(target)).theme, null);
});

test("the JSON export carries the look and the link rules; its import checks them the same way", async () => {
  const exported = await jsonExport(wid);
  assert.equal(exported.workspace.theme.accent, "#be123c");
  assert.deepEqual(exported.workspace.linkRules.map((r: { pattern: string }) => r.pattern), [JIRA.pattern, ISSUES.pattern]);
  const target = await createWorkspace(restorer.id, "JSON-Ziel");
  const targetSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", target))!;
  exported.workspace.linkRules.push({ pattern: "(a+)+", template: "https://x.example/{match}" });
  const result = (await command(restorer, { action: "workspace.import", workspaceId: target, spaceId: targetSpace.id, backup: exported })) as { omittedSettings: unknown };
  assert.deepEqual(result.omittedSettings, { linkRules: 1, fonts: 0, theme: 0, printPresets: 0 });
  assert.deepEqual((await workspaceLinkRules(target)).map((r) => r.pattern), [JIRA.pattern, ISSUES.pattern]);
  // Uploaded faces are only in the ZIP archive: that slot stays at the default.
  assert.deepEqual((await fonts.workspaceLook(target)).theme, { accent: "#be123c", background: "sepia", fonts: { mono: "source-code-pro" } });
  // A JSON export from before (no workspace settings) still imports.
  const old = await createWorkspace(restorer.id, "JSON-Alt");
  const oldSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", old))!;
  const { workspace: _w, ...older } = exported;
  const plain = (await command(restorer, { action: "workspace.import", workspaceId: old, spaceId: oldSpace.id, backup: older })) as { pages: number; omittedSettings: unknown };
  assert.ok(plain.pages >= 1);
  assert.deepEqual(plain.omittedSettings, { linkRules: 0, fonts: 0, theme: 0, printPresets: 0 });
  assert.deepEqual(await workspaceLinkRules(old), []);
});

// What GET /api/export returns (app/api/[...path]/route.ts): the workspace
// part as there, one document page.
async function jsonExport(workspaceId: string) {
  return JSON.parse(
    JSON.stringify({
      format: "flowplan-1",
      exportedAt: new Date().toISOString(),
      workspace: await jsonExportWorkspace(workspaceId),
      pages: [{ id: id(), parent_id: null, title: "Notizen", kind: "document", data: { html: "<p>ABC-1</p>" } }],
    }),
  );
}
