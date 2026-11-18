// Flashcard decks as templates (docs/specs/flashcards.md §8.4, §8.5): the
// built-in "Lernkarten-Datenbank" (one card of every type, the image
// occlusion picture from public/), "Vokabeln" and "Flowplan-Tastenkürzel"
// (records written from the keymap), the card mapping (settings.study) kept
// wherever a template is saved, exported, packaged for the marketplace and
// applied – the study view, clozes and data-occlusion with it – and the
// learning states never.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study-templates-"));
const setup = await import("./helpers/workflow-setup");
const { owner, wid, space, user, act } = setup;
const { one, all, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { replaceRowDocument } = await import("../lib/row-documents");
const pkgs = await import("../lib/marketplace-package");
const { exportTemplate, importTemplate } = await import("../lib/template-exchange");
const { templateCatalog } = await import("../lib/template-catalog");
const { templateCatalogEn } = await import("../lib/template-catalog-en");
const { catalogRows } = await import("../lib/template-rows");
const { shortcutCards } = await import("../lib/template-shortcut-cards");
const { shortcutCardsModule, shortcutAreas } = await import("../scripts/shortcut-card-rows");
const { officialPackages, FLASHCARD_TAG } = await import("../lib/marketplace-official");
const { readZip } = await import("../lib/archive");
const { recordType } = await import("../lib/study-content");
const { studySettingsSchema } = await import("../lib/study-schema");

const zone = "Europe/Berlin";
const other = await user("deck-owner");
const target = await createWorkspace(other.id, "Ziel");
const targetSpace = (await bootstrap(other, target)).spaces[0].id;
const queue = async (pageId: string, viewId?: string, who = owner) => await setup.act({ action: "study.queue", pageId, zone, limit: 50, ...(viewId ? { viewId } : {}) }, who);
const settingsOf = async (pageId: string) => JSON.parse((await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", pageId))!.settings || "{}");
const starter = async (key: string, who = owner, workspaceId = wid, spaceId = space) =>
  (await act({ action: "page.create", workspaceId, spaceId, kind: "database", title: "", starterTemplate: key }, who)).id as string;

test("Lernkarten-Datenbank: one example of every card type in both languages, the picture comes with Flowplan", async () => {
  for (const catalog of [templateCatalog, templateCatalogEn]) {
    const t = catalog.flashcards;
    const settings = studySettingsSchema.parse(t.settings!.study);
    const types = (t.rows || []).map((r) => recordType(settings, r.cells));
    for (const type of ["basic", "cloze", "typed", "choice", "occlusion"]) assert.ok(types.includes(type as never), `${t.name}: ${type}`);
    const pictured = t.rows!.find((r) => recordType(settings, r.cells) === "occlusion")!;
    const src = /src="([^"]+)"/.exec(pictured.content || "")![1];
    assert.ok(existsSync(join(process.cwd(), "public", src)), `${src} is in public/`);
    assert.match(pictured.content!, /data-occlusion=/);
  }
  const pageId = await starter("flashcards");
  const q = await queue(pageId);
  assert.deepEqual([...new Set(q.cards.map((c: { kind: string }) => c.kind))].sort(), ["basic", "choice", "cloze", "occlusion", "typed"]);
  const kinds = await all<{ kind: string }>("SELECT kind FROM study_cards WHERE page_id=?", pageId);
  assert.equal(kinds.filter((k) => k.kind === "occlusion").length, 4, "one card per planet");
  const masked = q.cards.find((c: { kind: string }) => c.kind === "occlusion");
  assert.equal(masked.occlusion.src, "/examples/inner-planets.svg");
  const choice = q.cards.find((c: { kind: string }) => c.kind === "choice");
  assert.deepEqual(choice.choice.options.slice().sort(), ["Gut", "Leicht", "Nochmal", "Schwer"]);
});

test("Vokabeln: typed in both directions, accents count, the example as the hint, a lesson as a sub-deck", async () => {
  for (const catalog of [templateCatalog, templateCatalogEn]) {
    const s = studySettingsSchema.parse(catalog.vocabulary.settings!.study);
    assert.equal(catalog.vocabulary.category, "personal");
    assert.deepEqual([s.type, s.reverse, s.typedCompare.ignoreAccents, s.hint?.field], [{ fixed: "typed" }, true, false, "example"]);
    assert.deepEqual(catalog.vocabulary.views!.filter((v) => v.type === "study").length, 2);
  }
  const pageId = await starter("vocabulary");
  const all = await queue(pageId);
  assert.equal(all.total, 14, "seven words, both ways");
  assert.ok(all.cards.every((c: { kind: string; typed?: unknown }) => c.kind === "typed" && c.typed));
  const lesson = await queue(pageId, "lesson1");
  assert.equal(lesson.total, 8, "four words of lesson 1, both ways");
});

test("Flowplan-Tastenkürzel: the records are the keymap's, written by the script", async () => {
  // Run `npm run shortcut-cards` when this fails after a shortcut changed.
  assert.equal(readFileSync(join(process.cwd(), "lib/template-shortcut-cards.ts"), "utf8"), shortcutCardsModule());
  for (const [catalog, locale, t] of [
    [templateCatalog, "de", (d: string) => d],
    [templateCatalogEn, "en", (_d: string, e: string) => e],
  ] as const) {
    const template = catalog.shortcuts;
    assert.equal(template.rows, undefined, "not in the app's bundle");
    const rows = catalogRows("shortcuts", template, locale);
    assert.equal(rows, shortcutCards[locale]);
    assert.ok(rows.length >= 30);
    const areas = template.fields!.find((f) => f.id === "area")!.options;
    assert.deepEqual(areas, shortcutAreas(t));
    for (const row of rows) {
      assert.ok(areas!.includes(String(row.cells.area)), String(row.cells.area));
      assert.ok(row.cells.mac && row.cells.pc && row.cells.title, JSON.stringify(row));
    }
    assert.ok(rows.some((r) => r.cells.mac === "⌘ K" && r.cells.pc === "Ctrl + K"));
  }
  const pageId = await starter("shortcuts");
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", pageId)).length, shortcutCards.de.length);
  const q = await queue(pageId);
  assert.equal(q.total, shortcutCards.de.length * 2, "both directions");
  assert.ok(q.cards.some((c: { hint?: { text: string } }) => c.hint?.text === "App"), "the area is the hint");
});

test("a deck saved as a template, exported, packaged and applied: mapping, study view, clozes and masks travel – learning states never", async () => {
  const pageId = await starter("flashcards");
  // Someone studied a card: their state stays where it is.
  const first = (await queue(pageId)).cards[0];
  await act({ action: "study.review", pageId, rowId: first.rowId, sub: first.sub, rating: 3, id: randomUUID(), zone });
  assert.ok(await one("SELECT 1 FROM card_states WHERE page_id=?", pageId));
  // An editor's cloze mark in a record's document, and an automation that must not travel.
  const row = (await all<{ id: string }>("SELECT id FROM rows WHERE page_id=? ORDER BY position", pageId))[0].id;
  const html = '<p>Die Hauptstadt von Frankreich ist <span data-cloze="1">Paris</span>.</p>';
  await replaceRowDocument(row, html, owner.id);
  const settings = await settingsOf(pageId);
  await run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify({ ...settings, automations: [] }), pageId);

  const mapping = studySettingsSchema.parse(settings.study);
  const templateId = (await act({ action: "template.save", pageId, name: "Mein Stapel" })).id as string;
  const stored = JSON.parse((await one<{ payload: string }>("SELECT payload FROM templates WHERE id=?", templateId))!.payload);
  assert.deepEqual(Object.keys(stored.database.settings), ["study"], "only the card mapping of the settings");
  assert.equal(stored.database.settings.study.choices.field, "choices");
  assert.ok(stored.database.views.some((v: { type: string }) => v.type === "study"));
  for (const word of ["card_states", "review_log", "stability", "memory"]) assert.ok(!JSON.stringify(stored).includes(word), `no ${word}`);

  // Applied in the same workspace.
  const copy = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Kopie", templateId })).id as string;
  assert.deepEqual((await settingsOf(copy)).study, mapping);
  assert.equal((await queue(copy)).total, (await queue(pageId)).total);
  assert.equal(await one("SELECT 1 FROM card_states WHERE page_id=?", copy), undefined, "nobody's state came along");

  // Exported as a file and imported in another instance's workspace.
  const exported = await exportTemplate(owner, wid, templateId);
  const imported = await importTemplate(other, target, exported.zip, "workspace", targetSpace);
  const there = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, title: "Importiert", templateId: imported.id }, other)).id as string;
  assert.deepEqual((await settingsOf(there)).study, mapping);

  // As a marketplace package: built, read back, imported, applied.
  const built = await pkgs.buildPackage(owner, { kind: "database", workspaceId: wid, id: templateId }, { titles: { en: "My deck" }, summary: { de: "Ein Stapel.", en: "A deck." }, category: "knowledge", tags: [FLASHCARD_TAG], language: "de" }, []);
  const parsed = await pkgs.readPackage(built.bytes);
  assert.equal(parsed.manifest.category, "knowledge");
  assert.deepEqual(parsed.manifest.tags, [FLASHCARD_TAG]);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  const fromMarket = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, title: "Vom Marketplace", templateId: result.templateId }, other)).id as string;
  assert.deepEqual((await settingsOf(fromMarket)).study, mapping);
  assert.equal((await settingsOf(fromMarket)).automations, undefined);
  const q = await queue(fromMarket, undefined, other);
  assert.ok(q.cards.some((c: { kind: string; occlusion?: { masks: unknown[] } }) => c.kind === "occlusion" && c.occlusion!.masks.length === 4), "data-occlusion survived");
  const docs = await all<{ html: string }>("SELECT d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=?", fromMarket);
  assert.ok(docs.some((d) => d.html.includes('data-cloze="1"')), "the cloze mark survived");
  assert.ok(q.cards.every((c: { memory: unknown }) => c.memory === null), "everything new for the new owner");
  const views = JSON.parse((await one<{ views: string }>("SELECT views FROM databases WHERE page_id=?", fromMarket))!.views);
  assert.ok(views.some((v: { type: string }) => v.type === "study"));
});

test("a mapping that no longer fits the properties is left out when applied", async () => {
  const pageId = await starter("vocabulary");
  const templateId = (await act({ action: "template.save", pageId, name: "Kaputt" })).id as string;
  const payload = JSON.parse((await one<{ payload: string }>("SELECT payload FROM templates WHERE id=?", templateId))!.payload);
  payload.database.settings.study.back = { field: "nope" };
  await run("UPDATE templates SET payload=? WHERE id=?", JSON.stringify(payload), templateId);
  const copy = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Ohne Karten", templateId })).id as string;
  assert.equal((await settingsOf(copy)).study, undefined);
});

test("official packages: decks carry their mapping and the tag Lernkarten in their category", async () => {
  const every = await officialPackages("0.9.9");
  for (const key of ["flashcards", "vocabulary", "shortcuts"]) {
    const pkg = every.find((p) => p.kind === "database" && p.id === key)!;
    const parsed = await pkgs.readPackage(pkg.bytes);
    assert.ok(parsed.manifest.tags.includes(FLASHCARD_TAG), key);
    assert.equal(parsed.manifest.category, templateCatalog[key as keyof typeof templateCatalog].category);
    const inner = await readZip((await readZip(pkg.bytes, { foreign: true })).get("payload/template.zip")!, { foreign: true });
    const content = JSON.parse(JSON.parse(inner.get("template.json")!.toString()).payload);
    assert.ok(content.database.settings.study, `${key}: settings.study`);
    if (key === "shortcuts") assert.equal(content.rows.length, shortcutCards.de.length);
  }
  assert.ok(!(await pkgs.readPackage(every.find((p) => p.id === "project")!.bytes)).manifest.tags.includes(FLASHCARD_TAG));
});
