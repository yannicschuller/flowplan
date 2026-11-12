// Print options and print presets (#215): options → what leaves the copy and
// the style sheet, the combined print view, the presets with their
// permissions, the bootstrap and the archive round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-print-options-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { exportArchive, importArchive, jsonExportWorkspace } = await import("../lib/archive");
const { exportPrintHtml } = await import("../lib/export-pdf");
const { workspacePrintPresets, userPrintSettings } = await import("../lib/print-settings");
const P = await import("../lib/print-options");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
}
const owner = await account("druck-owner"),
  member = await account("druck-member"),
  guest = await account("druck-guest"),
  restorer = await account("druck-restorer");
const wid = await createWorkspace(owner.id, "Druckerei");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "owner");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id).catch(async () => await run("INSERT INTO workspace_guests VALUES(?,?)", wid, guest.id));
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!;

const CLEAN = { ...P.DEFAULT_PRINT_OPTIONS, cover: false, icon: false, tags: false, properties: false, links: "plain" as const };

test("options: stored values are read key by key, unknown values become the defaults", () => {
  assert.deepEqual(P.printOptionsOf(null), P.DEFAULT_PRINT_OPTIONS);
  const read = P.printOptionsOf({ cover: false, paper: "a3", titleSize: "large", bodyFont: "comic", extra: 1 });
  assert.equal(read.cover, false);
  assert.equal(read.paper, "auto");
  assert.equal(read.titleSize, "large");
  assert.equal(read.bodyFont, "default");
  assert.equal("extra" in read, false);
  assert.deepEqual(P.printOptionsFromQuery(P.printOptionsQuery(CLEAN)), CLEAN);
  assert.equal(P.printOptionsQuery(P.DEFAULT_PRINT_OPTIONS), "");
  assert.deepEqual(P.printOptionsFromQuery("{not json"), P.DEFAULT_PRINT_OPTIONS);
  // What the dialog starts with: the last choice, else the workspace's default.
  const preset = { id: "p1", name: "Extern", options: CLEAN };
  assert.deepEqual(P.initialPrintOptions(null, { presets: [preset], defaultId: "p1" }), CLEAN);
  assert.deepEqual(P.initialPrintOptions({ last: P.DEFAULT_PRINT_OPTIONS, presets: [] }, { presets: [preset], defaultId: "p1" }), P.DEFAULT_PRINT_OPTIONS);
});

test("options: cover, icon, tags and properties leave the copy of a page or record", () => {
  const doc = new Window().document;
  const page = () => {
    doc.body.innerHTML =
      '<article class="page-content"><div class="page-cover">C<button class="cover-change">Cover ändern</button></div><div class="document-header"><button class="large-page-icon">I</button><div class="page-title">T</div></div>' +
      '<section class="page-properties"><div class="page-properties-tags">#tag</div><dl class="page-properties-list">Status</dl></section><div class="document-editor"><p>Text</p></div>' +
      '<div class="row-detail"><div class="row-cover">RC</div><h2><span class="row-title-icon">RI</span>Eintrag</h2><div class="row-properties">Felder</div></div></article>';
    return doc.querySelector(".page-content")! as unknown as Element;
  };
  let copy = page();
  P.applyPrintOptions(copy, P.DEFAULT_PRINT_OPTIONS);
  for (const sel of [".page-cover", ".large-page-icon", ".page-properties-tags", ".page-properties-list", ".row-cover", ".row-title-icon", ".row-properties"]) assert.ok(copy.querySelector(sel), sel);
  assert.ok(copy.classList.contains("print-options"));
  assert.equal(copy.querySelector(".cover-change"), null, "no editing buttons on paper");
  copy = page();
  P.applyPrintOptions(copy, { ...P.DEFAULT_PRINT_OPTIONS, cover: false, icon: false });
  for (const sel of [".page-cover", ".large-page-icon", ".row-cover", ".row-title-icon"]) assert.equal(copy.querySelector(sel), null, sel);
  assert.ok(copy.querySelector(".page-title") && copy.querySelector(".page-properties-tags"));
  copy = page();
  P.applyPrintOptions(copy, { ...P.DEFAULT_PRINT_OPTIONS, tags: false });
  assert.equal(copy.querySelector(".page-properties-tags"), null);
  assert.ok(copy.querySelector(".page-properties-list") && copy.querySelector(".row-properties"));
  copy = page();
  P.applyPrintOptions(copy, { ...P.DEFAULT_PRINT_OPTIONS, properties: false });
  assert.equal(copy.querySelector(".page-properties-list"), null);
  assert.equal(copy.querySelector(".row-properties"), null);
  assert.ok(copy.querySelector(".page-properties-tags"));
  copy = page();
  P.applyPrintOptions(copy, CLEAN);
  assert.equal(copy.querySelector(".page-properties"), null);
  assert.ok(copy.querySelector(".document-editor p"), "the content stays");
});

test("options: the style sheet sets paper, page numbers, title size, typefaces and links", () => {
  // A page as before, plus page numbers.
  assert.equal(P.printOptionsCss(P.DEFAULT_PRINT_OPTIONS, "page"), "@page { @bottom-center { content: counter(page); font: 10pt Helvetica, Arial, sans-serif; color: #666; } }");
  assert.equal(P.printOptionsCss({ ...P.DEFAULT_PRINT_OPTIONS, pageNumbers: false }, "page"), "");
  const page = P.printOptionsCss({ ...P.DEFAULT_PRINT_OPTIONS, paper: "letter", pageNumbers: false, titleSize: "large", bodyFont: "serif", headingFont: "workspace", links: "dashed" }, "page");
  assert.match(page, /@page \{ size: letter; \}/);
  assert.doesNotMatch(page, /counter\(page\)/);
  assert.match(page, /\.print-options \.page-title, \.print-options \.row-detail h2 \{ font-size: 47\.5px; \}/);
  assert.match(page, /\.print-options, \.print-options \.document-editor, \.print-options \.ProseMirror \{ font-family: Georgia/);
  assert.match(page, /\.print-options h1, .*\.print-options \.page-title, .* \{ font-family: var\(--font-display\); \}/);
  assert.match(page, /\.print-options a \{ color: inherit; text-decoration: underline dashed;/);
  // The combined view: A4 and the link addresses as before.
  const book = P.printOptionsCss(P.DEFAULT_PRINT_OPTIONS, "book");
  assert.match(book, /@page \{ size: A4; margin: 18mm 16mm 20mm; @bottom-center \{ content: counter\(page\);/);
  assert.match(book, /\.print-book a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)";/);
  const plain = P.printOptionsCss({ ...P.DEFAULT_PRINT_OPTIONS, links: "plain", pageNumbers: false, titleSize: "small", headingFont: "workspace" }, "book", { heading: '"Lora", Georgia, serif; } body { color: red' });
  assert.doesNotMatch(plain, /attr\(href\)|counter\(page\)/);
  assert.match(plain, /\.print-book \.chapter-title \{ font-size: 19\.2pt; \}/);
  // A stack cannot close the rule.
  assert.doesNotMatch(plain, /\} body \{/);
  assert.match(plain, /font-family: "Lora", Georgia, serif  body  color red;/);
});

test("the combined print view follows the options", async () => {
  const root = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Handbuch" })) as { id: string }).id;
  const child = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Kapitel", parentId: root })) as { id: string }).id;
  const html = '<p>Siehe <a href="https://example.org/x">Quelle</a></p>';
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), child);
  const before = (await exportPrintHtml(owner, { pageId: root, children: true })).html;
  assert.match(before, /<section class="cover">/);
  assert.match(before, /<nav class="toc">/);
  assert.match(before, /counter\(page\)/);
  assert.match(before, /attr\(href\)/);
  assert.match(before, /size: A4/);
  const clean = (await exportPrintHtml(owner, { pageId: root, children: true }, { ...CLEAN, titlePage: false, toc: false, pageNumbers: false, paper: "letter", bodyFont: "workspace" })).html;
  assert.doesNotMatch(clean, /<section class="cover">|<nav class="toc">|counter\(page\)|attr\(href\)/);
  assert.match(clean, /size: letter/);
  assert.match(clean, /\.chapter:first-of-type \{ page-break-before: auto;/);
  // The workspace's typefaces: Flowplan's own (fonts.css) by default.
  assert.match(clean, /<link rel="stylesheet" href="\/fonts\.css">/);
  assert.match(clean, /\.print-book \{ font-family: "Instrument Sans"/);
});

test("presets: everyone keeps their own; only owners change the workspace's, guests never", async () => {
  // Personal: the last choice and the own list.
  const saved = (await command(member, { action: "profile.print", options: CLEAN, presets: [{ id: "mine-1", name: " Intern ", options: { cover: false } }] })) as { last: unknown; presets: { name: string; options: { cover: boolean; tags: boolean } }[] };
  assert.deepEqual(saved.last, CLEAN);
  assert.equal(saved.presets[0].name, "Intern");
  assert.equal(saved.presets[0].options.cover, false);
  assert.equal(saved.presets[0].options.tags, true);
  assert.deepEqual((await userPrintSettings(member.id)).last, CLEAN);
  // Only the list changes; the last choice stays.
  await command(member, { action: "profile.print", presets: [] });
  assert.deepEqual(await userPrintSettings(member.id), { last: CLEAN, presets: [] });
  await assert.rejects(command(member, { action: "profile.print", presets: [{ id: "x", name: "", options: {} }] }));
  await assert.rejects(command(member, { action: "profile.print", presets: Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, options: {} })) }));
  await assert.rejects(command(member, { action: "profile.print", options: { ...CLEAN, paper: "a0" } }));

  // The workspace's.
  const presets = [
    { id: "intern", name: "Intern", options: P.DEFAULT_PRINT_OPTIONS },
    { id: "extern", name: "Sauber für extern", options: CLEAN },
  ];
  const result = (await command(owner, { action: "workspace.printPresets", workspaceId: wid, presets, defaultId: "extern" })) as { presets: unknown[]; defaultId: string };
  assert.equal(result.presets.length, 2);
  assert.equal(result.defaultId, "extern");
  await assert.rejects(command(member, { action: "workspace.printPresets", workspaceId: wid, presets: [] }), { status: 403 });
  await assert.rejects(command(guest, { action: "workspace.printPresets", workspaceId: wid, presets: [] }), { status: 403 });
  assert.equal((await workspacePrintPresets(wid)).presets.length, 2);
  // A default that is not in the list is none.
  const none = (await command(owner, { action: "workspace.printPresets", workspaceId: wid, presets, defaultId: "gone" })) as { defaultId: string | null };
  assert.equal(none.defaultId, null);
  await command(owner, { action: "workspace.printPresets", workspaceId: wid, presets, defaultId: "extern" });

  // Delivered to members and guests in the bootstrap.
  for (const person of [member, guest]) {
    const boot = (await bootstrap(person, wid)) as { printPresets: { presets: { name: string }[]; defaultId: string }; print: { presets: unknown[] } };
    assert.deepEqual(boot.printPresets.presets.map((p) => p.name), ["Intern", "Sauber für extern"]);
    assert.equal(boot.printPresets.defaultId, "extern");
    assert.ok(Array.isArray(boot.print.presets));
  }
});

test("archive round trip: the workspace's presets and its default come along, checked preset by preset", async () => {
  const zip = await exportArchive(owner, wid);
  const target = await createWorkspace(restorer.id, "Ziel");
  const result = await importArchive(restorer, target, zip);
  assert.equal(result.omittedSettings.printPresets, 0);
  const restored = await workspacePrintPresets(target);
  assert.deepEqual(restored.presets.map((p) => [p.name, p.options.cover]), [["Intern", true], ["Sauber für extern", false]]);
  assert.equal(restored.presets.find((p) => p.id === restored.defaultId)?.name, "Sauber für extern");
  // Again: names the workspace has stay as they are.
  const again = await importArchive(restorer, target, zip);
  assert.equal(again.omittedSettings.printPresets, 0);
  assert.equal((await workspacePrintPresets(target)).presets.length, 2);

  // The JSON export carries them too; an invalid preset is left out and counted.
  const json = await jsonExportWorkspace(wid);
  assert.equal(json.printPresets.presets.length, 2);
  const other = await createWorkspace(restorer.id, "JSON-Ziel");
  const otherSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", other))!;
  const backup = { format: "flowplan-1", workspace: { ...json, printPresets: { ...json.printPresets, presets: [...json.printPresets.presets, { id: "bad", name: "", options: {} }] } }, pages: [] };
  const imported = (await command(restorer, { action: "workspace.import", workspaceId: other, spaceId: otherSpace.id, backup })) as { omittedSettings: { printPresets: number } };
  assert.equal(imported.omittedSettings.printPresets, 1);
  assert.equal((await workspacePrintPresets(other)).presets.length, 2);
  // Not an owner of the target: nothing is taken over.
  const foreign = await createWorkspace(owner.id, "Fremd");
  await run("INSERT INTO members VALUES(?,?,?)", foreign, restorer.id, "editor");
  const notOwner = await importArchive(restorer, foreign, zip).catch(() => null);
  if (notOwner) assert.equal((await workspacePrintPresets(foreign)).presets.length, 0);
});
