// Flashcards phase 3b (docs/specs/flashcards.md §8.1, §8.2): Anki packages
// in the legacy (collection.anki2) and the new format (anki21b, zstd and
// protobuf), built in the test (tests/helpers/anki-fixture.ts); note types
// → card types, fields → sides, sanitised HTML, media and their limits,
// decks → databases with a "Deck" property, the learning state replayed
// through FSRS for the person importing, and the .apkg export read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { ankiPackage, sampleFixture, BASIC, CLOZE, OCCLUSION, REVERSED, TYPED, VOCAB, PNG } from "./helpers/anki-fixture";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-anki-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { readAnkiPackage, protoFields } = await import("../lib/importers/anki-read");
const { ankiKind, suggestNotetype, planAnki, sanitizeAnkiHtml, ankiDocumentHtml, ankiText, templateRefs, cardSub } = await import("../lib/importers/anki");
const { importFromSource } = await import("../lib/importers");
const { studyQueue, studyAnkiExport } = await import("../lib/study");
const { ankiFieldHtml } = await import("../lib/study-anki-export");
const { ankiOptionsSchema } = await import("../lib/anki-mapping");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("anki-owner");
const reader = await user("anki-reader");
const wid = await createWorkspace(owner.id, "Anki");
const boot = await bootstrap(owner, wid);
const space = boot.spaces[0].id;
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, reader.id, "viewer");
const zone = "Europe/Berlin";

test("note types become card types; templates tell the sides of own ones", () => {
  assert.equal(ankiKind(BASIC as never), "basic");
  assert.equal(ankiKind(REVERSED as never), "reversed");
  assert.equal(ankiKind(CLOZE as never), "cloze");
  assert.equal(ankiKind(TYPED as never), "typed");
  assert.equal(ankiKind({ ...OCCLUSION, stock: 6 } as never), "occlusion");
  assert.equal(ankiKind({ ...OCCLUSION, stock: 0 } as never), "occlusion", "by its name too");
  assert.equal(ankiKind(VOCAB as never), "custom");
  assert.equal(ankiKind({ name: "Mein Typ", cloze: false, stock: 2, templates: [] }), "reversed", "the stock kind of schema 18 wins over the name");
  assert.deepEqual(templateRefs("{{#Hint}}{{hint:Hint}}{{/Hint}} {{text:Front}} {{FrontSide}} {{type:Back}} {{! Kommentar}}"), [
    { name: "Hint", filter: "hint" },
    { name: "Front", filter: "text" },
    { name: "Back", filter: "type" },
  ]);
  assert.deepEqual(suggestNotetype(BASIC as never), { type: "basic", reverse: false, roles: ["front", "back"] });
  assert.deepEqual(suggestNotetype(REVERSED as never), { type: "basic", reverse: true, roles: ["front", "back"] });
  assert.deepEqual(suggestNotetype(TYPED as never), { type: "typed", reverse: false, roles: ["front", "back"] });
  assert.deepEqual(suggestNotetype(CLOZE as never), { type: "cloze", reverse: false, roles: ["front", "back"] });
  assert.deepEqual(suggestNotetype(OCCLUSION as never), { type: "occlusion", reverse: false, roles: ["skip", "front", "front", "back", "extra"] });
  // Wort in front with its hint, meaning and example behind, the internal note left out.
  assert.deepEqual(suggestNotetype(VOCAB as never), { type: "basic", reverse: false, roles: ["front", "back", "extra", "hint", "skip"] });
});

test("fields are sanitised; media, formulas and clozes become what documents have", () => {
  const dirty = '<div style="font-family:Arial" class="x" onclick="steal()">a<script>alert(1)</script><style>p{}</style> <b>b</b> H<sub>2</sub>O <a href="javascript:x()">j</a> <a href="https://example.org">l</a></div>';
  const clean = sanitizeAnkiHtml(dirty);
  assert.doesNotMatch(clean, /script|alert|style|onclick|class=|javascript/);
  assert.match(clean, /<b>b<\/b> H<sub>2<\/sub>O/);
  assert.match(clean, /<a href="https:\/\/example.org">l<\/a>/);
  const missing: string[] = [];
  const ctx = { media: (name: string) => (name === "bild.png" || name === "ton.mp3" ? `anki-media/${name}` : null), missing: (name: string) => missing.push(name) };
  const html = ankiDocumentHtml('<img src="bild.png"> <img src="weg.png"> <img src="https://tracker.example/p.gif"> [sound:ton.mp3] \\(x^2\\) {{c1::Paris::Stadt}} {{c2::<b>fett</b>}}', ctx);
  assert.match(html, /<img src="fp-import:\/\/file\/anki-media%2Fbild.png" alt="bild.png">/);
  assert.match(html, /<div data-import-file="fp-import:\/\/file\/anki-media%2Fton.mp3" data-title="ton.mp3"><\/div>/);
  assert.match(html, /<a href="https:\/\/tracker.example\/p.gif">/, "a picture from the web stays a link, never loaded");
  assert.match(html, /<span data-math="x\^2" class="math-inline"><\/span>/);
  assert.match(html, /<span data-cloze="1" data-cloze-hint="Stadt">Paris<\/span>/);
  assert.match(html, /\{\{c2::<b>fett<\/b>\}\}/, "a cloze around formatting stays Anki's syntax (still a card)");
  assert.deepEqual(missing, ["weg.png"]);
  assert.equal(ankiText("<b>hola</b> <i>amigo</i>[sound:x.mp3]<div>zwei</div>"), "**hola** _amigo_\nzwei");
});

test("a legacy package: decks as databases, sub-decks as Deck, media, tags and the learning state", async () => {
  const bytes = await ankiPackage(sampleFixture());
  const pkg = await readAnkiPackage(bytes);
  assert.equal(pkg.format, "anki2");
  assert.equal(pkg.notes.length, 8);
  assert.equal(pkg.media.size, 3);
  const preview = await importFromSource(owner, wid, space, { name: "Sprachen.apkg", bytes }, { dryRun: true });
  const anki = (preview as unknown as { anki: import("../lib/anki-mapping").AnkiPreview }).anki;
  assert.deepEqual(anki.decks.map((d) => [d.name, d.notes, d.subdecks]), [
    ["Spanisch", 4, ["Lektion 1"]],
    ["Biologie", 4, []],
  ]);
  assert.equal(anki.reviews, 10);
  assert.equal(anki.suspended, 1);
  assert.equal(anki.media.missing, 1, "fehlt.png");
  assert.equal(anki.notetypes.find((n) => n.name === "Vokabel")?.samples[0].front, "la casa");
  assert.ok(!preview.warnings.some((w) => /Bildverdeckung/.test(w)), "image occlusion comes with its masks");
  assert.equal(anki.notetypes.find((n) => n.name === "Image Occlusion")?.mapping.type, "occlusion");
  assert.ok(preview.warnings.some((w) => /mit und ohne Rückwärtskarte/.test(w)));
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM pages WHERE workspace_id=? AND kind='database'", wid))!.n), 0, "a preview writes nothing");

  const result = await importFromSource(owner, wid, space, { name: "Sprachen.apkg", bytes }, { anki: JSON.stringify({ state: true }), zone });
  const decks = await all<{ id: string; title: string }>("SELECT id,title FROM pages WHERE workspace_id=? AND kind='database' ORDER BY title", wid);
  assert.deepEqual(decks.map((d) => d.title), ["Biologie", "Spanisch"]);
  // Not the manual change, nor the reverse card's two (the deck has no
  // reverse cards: only one of its basic notes had one).
  assert.equal((result as { reviews?: number }).reviews, 7);
  const spanish = decks.find((d) => d.title === "Spanisch")!.id,
    biology = decks.find((d) => d.title === "Biologie")!.id;
  const es = await database(spanish);
  assert.deepEqual(es.fields.map((f) => f.id), ["title", "back", "hint", "extra", "tags", "type", "deck"]);
  assert.equal(es.views[0].type, "study");
  assert.equal(es.settings?.study?.reverse, false, "one of three basic notes is reversed: off for the deck");
  const esRows = await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", spanish);
  const cells = esRows.map((r) => JSON.parse(r.cells));
  assert.deepEqual(cells[0], { title: "hola", back: "hallo", tags: ["gruss", "a1"], type: cells[0].type });
  assert.equal(cells[1].back, "Hund", "styles and event attributes are gone");
  assert.equal(cells[1].deck, "Lektion 1");
  assert.equal(cells[2].type, "Antwort eintippen");
  assert.deepEqual([cells[3].title, cells[3].back, cells[3].extra, cells[3].hint], ["la casa", "das Haus", "Mi casa es su casa.", "Haus"]);
  // Biology has media and formulas: its sides come from the document.
  const bio = await database(biology);
  assert.deepEqual(bio.settings?.study?.front, { document: "above" });
  assert.deepEqual(bio.settings?.study?.back, { document: "below" });
  const docs = await all<{ html: string }>("SELECT d.html FROM row_documents d JOIN rows r ON r.id=d.row_id WHERE r.page_id=? ORDER BY r.position", biology);
  assert.match(docs[0].html, /<span data-cloze="1">Mitochondrien<\/span>/);
  assert.match(docs[0].html, /H<sub>2<\/sub>O/);
  assert.match(docs[1].html, /<img src="\/api\/files\/[0-9a-f-]{36}" alt="zelle.png"/);
  assert.match(docs[1].html, /<audio src="\/api\/files\/[0-9a-f-]{36}"/);
  assert.match(docs[2].html, /<img [^>]*data-occlusion="\{&quot;v&quot;:1,&quot;mode&quot;:&quot;hide-one&quot;/, "the masks on the picture");
  assert.match(docs[3].html, /data-math="E=mc\^2"/);
  const files = await all<{ name: string; mime: string }>("SELECT name,mime FROM files WHERE page_id=? ORDER BY name", biology);
  assert.deepEqual(files.map((f) => f.name), ["zelle.mp3", "zelle.png"], "stored once, unused media not at all");
  // The cards: cloze c1/c2, the occlusion note with its one mask.
  const queue = (await studyQueue(owner, { pageId: biology, zone, limit: 50 })) as { total: number; states: { new: number; review: number; learning: number } };
  assert.equal(queue.total, 5);
  // The learning state: only the person importing, replayed through FSRS.
  const logs = await all<{ source: string; user_id: string }>("SELECT source,user_id FROM review_log WHERE page_id IN (?,?)", spanish, biology);
  assert.equal(logs.length, 7);
  assert.ok(logs.every((l) => l.source === "import" && l.user_id === owner.id));
  const states = await all<{ sub: string; state: number; suspended: number; stability: number; row_id: string }>("SELECT sub,state,suspended,stability,row_id FROM card_states WHERE user_id=?", owner.id);
  assert.equal(states.length, 4);
  assert.equal(states.filter((s) => s.suspended).length, 1, "the suspended card stays suspended");
  assert.ok(states.some((s) => s.sub === "c1"));
  assert.ok(states.some((s) => Math.abs(s.stability - 42.5) < 1e-9), "Anki's FSRS memory wins");
  assert.equal((await all("SELECT 1 FROM card_states WHERE user_id=?", reader.id)).length, 0, "nobody else gets a state");
  // The import report names the missing file.
  assert.ok(await one("SELECT 1 FROM pages WHERE workspace_id=? AND title LIKE 'Importbericht%'", wid));
});

test("the new format (anki21b): zstd, schema 18 and the protobuf media list", async () => {
  const bytes = await ankiPackage(sampleFixture("latest"));
  const pkg = await readAnkiPackage(bytes);
  assert.equal(pkg.format, "anki21b");
  assert.equal(pkg.notetypes.get(String(CLOZE.id))?.cloze, true);
  assert.equal(pkg.notetypes.get(String(OCCLUSION.id))?.stock, 6);
  assert.equal(pkg.notetypes.get(String(TYPED.id))?.templates[0].qfmt, "{{Front}}\n{{type:Back}}");
  assert.equal(pkg.decks.get("11")?.name, "Spanisch::Lektion 1");
  assert.deepEqual(pkg.readMedia("zelle.png"), PNG, "media files unpacked");
  assert.equal(pkg.reviews.length, 10);
  // The varint reader.
  assert.deepEqual([...protoFields(Buffer.from([0x08, 0x96, 0x01, 0x12, 0x02, 0x68, 0x69])).entries()].map(([k, v]) => [k, v.map((x) => (Buffer.isBuffer(x) ? x.toString() : x))]), [
    [1, [150]],
    [2, ["hi"]],
  ]);
});

test("the mapping of the wizard applies; media limits and broken files", async () => {
  const pkg = await readAnkiPackage(await ankiPackage(sampleFixture()));
  const options = ankiOptionsSchema.parse({ notetypes: { [String(BASIC.id)]: { type: "basic", reverse: true, roles: ["back", "front"] } } });
  const plan = planAnki(pkg, options, "Test", { fileBytes: 10, files: 10 });
  const spanish = plan.tree.pages.find((p) => p.title === "Spanisch")!;
  assert.equal(spanish.database!.rows[0].cells.title, "hallo", "front and back swapped");
  assert.equal((spanish.database!.settings!.study as { reverse: boolean }).reverse, true, "two of three basic notes reversed now");
  assert.equal(plan.preview.media.files, 0, "files above the upload limit are skipped");
  assert.equal(plan.preview.media.skipped, 2, "zelle.png and zelle.mp3, each once");
  assert.ok(plan.tree.report!.counts.file! >= 1);
  assert.equal(cardSub({ type: "cloze" }, 1), "c2");
  assert.equal(cardSub({ type: "basic" }, 1), "r");
  assert.equal(cardSub({ type: "basic" }, 2), null);
  await assert.rejects(readAnkiPackage(Buffer.from("PK\u0003\u0004 kaputt")), /ZIP/);
  await assert.rejects(importFromSource(owner, wid, space, { name: "x.apkg", bytes: await ankiPackage({ ...sampleFixture(), notes: [] }) }, { dryRun: true }), /keine Notizen/);
  await assert.rejects(importFromSource(reader, wid, space, { name: "x.apkg", bytes: await ankiPackage(sampleFixture()) }, { dryRun: true }), /Berechtigung|Schreibrechte/);
});

test("the .apkg export reads back as the same cards", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Export", databaseKind: "flashcards" })) as { id: string }).id;
  const db = await database(pageId);
  await command(owner, { action: "study.settings", pageId, settings: { ...db.settings!.study, reverse: true } });
  await command(owner, { action: "row.create", pageId, cells: { title: "hola", back: "**hallo**", tags: [] } });
  await command(owner, { action: "row.create", pageId, cells: { title: "{{c1::Madrid}} ist die Hauptstadt von {{c2::Spanien}}.", back: "", type: "Lückentext" } });
  await command(owner, { action: "row.create", pageId, cells: { title: "gato", back: "Katze", type: "Antwort eintippen" } });
  const original = (await studyQueue(owner, { pageId, zone, limit: 0 })) as { total: number };
  assert.equal(original.total, 6, "two cards each: reverse, two clozes, typed with its reverse");
  const out = await studyAnkiExport(owner, { pageId, zone });
  assert.equal(out.notes, 3);
  assert.match(out.name, /\.apkg$/);
  const pkg = await readAnkiPackage(out.bytes);
  assert.equal(pkg.format, "anki2");
  assert.equal(pkg.notes.length, 3);
  assert.deepEqual(pkg.cards.map((c) => c.ord).sort(), [0, 0, 0, 1, 1], "reverse card and two clozes");
  assert.deepEqual([...pkg.notetypes.values()].map((n) => ankiKind(n)).sort(), ["cloze", "reversed", "typed"]);
  // Imported again: the same fronts, backs and card types.
  await importFromSource(owner, wid, space, { name: "Export.apkg", bytes: out.bytes });
  const back = (await all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='database' AND title='Export' ORDER BY created_at", wid)).at(-1)!.id;
  const rows = (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", back)).map((r) => JSON.parse(r.cells));
  assert.deepEqual(rows.map((r) => [r.title, r.back ?? ""]), [
    ["hola", "**hallo**"],
    ["{{c1::Madrid}} ist die Hauptstadt von {{c2::Spanien}}.", ""],
    ["gato", "Katze"],
  ]);
  assert.deepEqual(rows.map((r) => r.type), ["Vorder-/Rückseite", "Lückentext", "Antwort eintippen"]);
  const reimported = (await studyQueue(owner, { pageId: back, zone, limit: 0 })) as { total: number };
  // Anki's typing note type has one card: the deck's reverse brings the
  // typed reverse back (reverse stays on: one of the two basic notes).
  assert.equal(reimported.total, original.total, "card for card");
  // Document sides: clozes, formulas and pictures for Anki.
  const names: string[] = [];
  const field = ankiFieldHtml('<p>Die <span data-cloze="1" data-cloze-hint="Ort">Zelle</span> <span data-math="x^2" class="math-inline"></span> <img src="/api/files/0b6c5c1e-1111-4222-8333-944455556666" data-block-id="b1"><audio src="/api/files/0b6c5c1e-1111-4222-8333-944455556667" controls></audio><img src="https://example.org/x.png"></p>', (fid) => (names.push(fid), fid));
  assert.equal(field, '<p>Die {{c1::Zelle::Ort}} \\(x^2\\) <img src="0b6c5c1e-1111-4222-8333-944455556666" />[sound:0b6c5c1e-1111-4222-8333-944455556667]<span></span></p>');
  assert.equal(names.length, 2);
  // Only who may read the deck exports it; the reader may (reading is enough).
  const other = await user("anki-stranger");
  await assert.rejects(studyAnkiExport(other, { pageId, zone }));
});

// Phase 6: Image Occlusion notes with their masks – groups, pixels of older
// Anki versions, the learning state per mask, and back as Anki's note type.
test("image occlusion: masks, groups, pixels, the learning state and the export", async () => {
  const { diagramPng } = await import("./helpers/png");
  const { occludedImages, occlusionTargets } = await import("../lib/study-occlusion");
  const start = Date.UTC(2026, 9, 1, 8);
  const fixture = {
    notetypes: [OCCLUSION],
    decks: [{ id: 30, name: "Anatomie" }],
    notes: [
      {
        id: 31,
        mid: OCCLUSION.id,
        // c1 one rectangle, c2 an ellipse and a polygon (one card), a text shape left out.
        fields: [
          "{{c1::image-occlusion:rect:left=.1:top=.2:width=.2:height=.1:oi=1}}<br>{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.05:oi=1}}<br>{{c2::image-occlusion:polygon:points=.6,.1 .9,.1 .75,.4:oi=1}}<br>{{c3::image-occlusion:text:text=Hinweis:left=.1:top=.1}}",
          '<img src="herz.png">',
          "Das Herz",
          "Vier Kammern",
          "",
        ],
        deck: 30,
        cards: [
          { ord: 0, id: 3101 },
          { ord: 1, id: 3102 },
        ],
      },
      // Anki 23.10 kept pixels: with the picture's size (640×400) they become proportions.
      { id: 32, mid: OCCLUSION.id, fields: ["{{c1::image-occlusion:rect:left=64:top=40:width=128:height=80}}", '<img src="herz.png">', "", "", ""], deck: 30, cards: [{ ord: 0, id: 3201 }] },
      // Without masks: no card, said in the report.
      { id: 33, mid: OCCLUSION.id, fields: ["", '<img src="herz.png">', "Leer", "", ""], deck: 30, cards: [{ ord: 0, id: 3301 }] },
    ],
    reviews: [
      { at: start, cardId: 3101, ease: 3, type: 0 },
      { at: start, cardId: 3102, ease: 1, type: 0 },
      { at: start + 60_000, cardId: 3102, ease: 3, type: 0 },
    ],
    media: { "herz.png": diagramPng() },
  };
  const bytes = await ankiPackage(fixture);
  const preview = await importFromSource(owner, wid, space, { name: "Anatomie.apkg", bytes }, { dryRun: true });
  assert.ok(preview.warnings.some((w) => /^1 von 3 Bildverdeckungs-Notizen haben keine lesbaren Masken/.test(w)));
  assert.ok(preview.warnings.some((w) => /^1 Formen der Bildverdeckung/.test(w)), "the text shape");
  const result = await importFromSource(owner, wid, space, { name: "Anatomie.apkg", bytes }, { anki: JSON.stringify({ state: true }), zone });
  assert.equal((result as { reviews?: number }).reviews, 3);
  const pageId = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='database' AND title='Anatomie' ORDER BY created_at DESC", wid))!.id;
  const rows = await all<{ id: string; cells: string; html: string }>("SELECT r.id,r.cells,d.html FROM rows r JOIN row_documents d ON d.row_id=r.id WHERE r.page_id=? ORDER BY r.position", pageId);
  assert.deepEqual(rows.map((r) => JSON.parse(r.cells).type), ["Bildverdeckung", "Bildverdeckung", "Bildverdeckung"]);
  assert.equal(JSON.parse(rows[1].cells).title, "herz.png", "a picture without header is named by its file");
  const [first] = occludedImages(rows[0].html);
  assert.equal(first.occlusion.mode, "hide-all");
  assert.deepEqual(occlusionTargets(first.occlusion).map((t) => t.masks.length), [1, 2]);
  assert.deepEqual(occludedImages(rows[1].html)[0].occlusion.masks.map((m) => [m.x, m.y, m.w, m.h]), [[0.1, 0.1, 0.2, 0.2]]);
  assert.deepEqual(occludedImages(rows[2].html), []);
  const queue = (await studyQueue(owner, { pageId, zone, limit: 50 })) as { total: number };
  assert.equal(queue.total, 3, "two cards of the first note, one of the second");
  // The learning state: Anki's card c1 is the rectangle's, c2 the group's.
  const states = await all<{ sub: string; reps: number }>("SELECT sub,reps FROM card_states WHERE user_id=? AND page_id=?", owner.id, pageId);
  const targets = occlusionTargets(first.occlusion);
  assert.deepEqual(
    states.map((s) => [s.sub, Number(s.reps)]).sort(),
    [
      [targets[0].key, 1],
      [targets[1].key, 2],
    ].sort(),
  );

  // Exported as Anki's Image Occlusion: one note per picture, a card per mask or group.
  const out = await studyAnkiExport(owner, { pageId, zone });
  assert.equal(out.notes, 2);
  const pkg = await readAnkiPackage(out.bytes);
  const nt = [...pkg.notetypes.values()][0];
  assert.equal(nt.name, "Image Occlusion (Flowplan)");
  assert.equal(ankiKind(nt), "occlusion");
  assert.deepEqual(nt.fields, ["Occlusion", "Image", "Header", "Back Extra", "Comments"]);
  const note = pkg.notes.find((n) => n.fields[2] === "Das Herz")!;
  assert.match(note.fields[0], /^\{\{c1::image-occlusion:rect:left=\.1:top=\.2:width=\.2:height=\.1:oi=1\}\}<br>\{\{c2::image-occlusion:ellipse:/);
  assert.match(note.fields[1], /^<img src="herz\.png"/);
  assert.deepEqual(pkg.cards.map((c) => c.ord).sort(), [0, 0, 1]);
  assert.ok(pkg.media.has("herz.png"));
  // Imported again: the same cards.
  await importFromSource(owner, wid, space, { name: "Anatomie.apkg", bytes: out.bytes });
  const back = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='database' AND title='Anatomie' AND id<>?", wid, pageId))!.id;
  assert.equal(((await studyQueue(owner, { pageId: back, zone, limit: 0 })) as { total: number }).total, 3, "card for card");
});
