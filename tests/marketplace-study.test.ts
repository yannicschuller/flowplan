// Flashcard decks as marketplace templates (#345, docs/specs/flashcards.md
// §8.4): a published deck carries its properties, views, card mapping and
// records with their pictures and masks – never learning states, never
// what is about people (who made a record, person properties, mentions,
// member ids and addresses) – plus payload/study-meta.json with the deck's
// numbers and a few sample cards for the marketplace's preview. Installing
// gives a fresh deck: every card new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-marketplace-study-"));
const setup = await import("./helpers/workflow-setup");
const { owner, editor, wid, space, user, act } = setup;
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { replaceRowDocument } = await import("../lib/row-documents");
const pkgs = await import("../lib/marketplace-package");
const { readZip } = await import("../lib/archive");
const { studyMeta, studyMetaBytes, STUDY_META_PATH, STUDY_META_FORMAT, STUDY_META_LIMITS } = await import("../lib/marketplace-study-meta");
const { publicDatabaseContent, withoutMentions } = await import("../lib/marketplace-public-template");
const { templateCatalog } = await import("../lib/template-catalog");
const { officialPackages } = await import("../lib/marketplace-official");

const zone = "Europe/Berlin";
const other = await user("deck-taker");
const target = await createWorkspace(other.id, "Ziel");
const targetSpace = (await bootstrap(other, target)).spaces[0].id;
const queue = async (pageId: string, who = owner) => await act({ action: "study.queue", pageId, zone, limit: 50 }, who);

// A real PNG (w × h, grey), so every check that reads its bytes is satisfied.
function png(w: number, h: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const occlusion = (masks: unknown[]) => JSON.stringify({ v: 1, mode: "hide-one", masks }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

test("study-meta of the built-in deck: numbers, one sample per card type, clozes as runs, masks as fractions – plain text only", () => {
  const t = templateCatalog.flashcards;
  const meta = studyMeta({ database: { fields: t.fields, settings: { study: t.settings!.study } }, rows: t.rows!.map((r) => ({ cells: r.cells, content: r.content })) })!;
  assert.equal(meta.format, STUDY_META_FORMAT);
  assert.equal(meta.records, t.rows!.length);
  assert.ok(meta.cards >= meta.records);
  assert.deepEqual(Object.keys(meta.types).sort(), ["basic", "choice", "cloze", "occlusion", "typed"]);
  assert.equal(meta.types.occlusion, 4, "one card per planet");
  assert.deepEqual([...new Set(meta.samples.map((s) => s.type))].sort(), ["basic", "choice", "cloze", "occlusion", "typed"]);
  assert.ok(meta.samples.length <= STUDY_META_LIMITS.samples);
  const cloze = meta.samples.find((s) => s.type === "cloze")!;
  assert.ok(cloze.front.some((r) => r.gap), "the front hides a gap");
  const gapFront = cloze.front.find((r) => r.gap)!.text;
  const gapBack = cloze.back.find((r) => r.gap)!.text;
  assert.notEqual(gapFront, gapBack, "hidden on the front, the answer on the back");
  const choice = meta.samples.find((s) => s.type === "choice")!;
  assert.ok(choice.choices!.length >= 2 && choice.choices!.includes(choice.back.map((r) => r.text).join("")));
  assert.deepEqual(choice.choices, [...choice.choices!].sort((a, b) => a.localeCompare(b)), "sorted – the order gives nothing away");
  const masked = meta.samples.find((s) => s.type === "occlusion")!;
  assert.equal(masked.image, undefined, "a picture of Flowplan's own (SVG under public/) is not an attachment");
  assert.equal(masked.masks!.length, 4);
  assert.equal(masked.masks!.filter((m) => m.asked).length, 1);
  for (const m of masked.masks!) for (const v of [m.x, m.y, m.w, m.h]) assert.ok(v >= 0 && v <= 1);
  const text = JSON.stringify(meta);
  assert.ok(!/<[a-z]/i.test(text), "no HTML");
  assert.ok(studyMetaBytes(meta).length <= STUDY_META_LIMITS.bytes);
  assert.equal(studyMeta({ database: { fields: t.fields }, rows: [] }), null, "no mapping, no deck");
});

test("what is about people: records without their authors, person values, mentions and member ids gone", () => {
  const uid = randomUUID();
  const { content, cleared } = publicDatabaseContent(
    {
      database: { fields: [{ id: "title", type: "text" }, { id: "who", type: "person" }, { id: "by", type: "created_by" }], views: [{ id: "v", filter: { value: uid } }] } as never,
      rows: [{ id: "r1", cells: { title: "Hallo", who: uid, by: uid }, content: `<p>Frag <span data-mention="${uid}" class="mention">@Anna</span> morgen.</p>`, position: 2, created_by: uid, updated_by: uid, created_at: "2026-01-01" } as never],
      rowTemplates: [{ name: "Neu", cells: { who: uid, title: "x" }, html: "", is_default: 0 } as never],
      meta: { properties: [{ name: "Verantwortlich", type: "person", value: uid }, { name: "Stand", type: "text", value: "anna@example.org" }] as never[] },
    },
    { ids: new Set([uid]), emails: new Set(["anna@example.org"]) },
  );
  const text = JSON.stringify(content);
  assert.ok(!text.includes(uid), "no member id anywhere");
  assert.ok(!text.includes("Anna") && !text.includes("anna@example.org"));
  assert.deepEqual(Object.keys(content.rows![0]).sort(), ["cells", "content", "id", "position"]);
  assert.deepEqual(content.rows![0].cells, { title: "Hallo" });
  assert.equal(content.rows![0].content, "<p>Frag  morgen.</p>");
  assert.deepEqual(content.rowTemplates![0].cells, { title: "x" });
  assert.deepEqual(content.meta!.properties!.map((p) => (p as { name: string }).name), ["Stand"]);
  assert.ok(cleared >= 6);
  assert.deepEqual(withoutMentions('<p>a<span data-cloze="1">b</span></p>'), { html: '<p>a<span data-cloze="1">b</span></p>', count: 0 }, "other spans stay");
});

test("a deck published to the marketplace: no learning state, no people, the picture and its masks along; installed it is a fresh deck", async () => {
  // A deck by the owner, edited by an editor: a person property, a mention,
  // an occlusion record with an uploaded picture.
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "", starterTemplate: "flashcards" })).id as string;
  const db = await one<{ fields: string; version: number }>("SELECT fields,version FROM databases WHERE page_id=?", pageId);
  const fields = JSON.parse(db!.fields);
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([...fields, { id: "owner", name: "Zuständig", type: "person" }]), pageId);
  const rowList = await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? ORDER BY position", pageId);
  const rowIds = rowList.map((r) => r.id);
  // Portable on SQLite and PostgreSQL: the cells are rewritten in JS.
  for (const r of rowList)
    await run("UPDATE rows SET cells=?,created_by=?,updated_by=? WHERE id=?", JSON.stringify({ ...JSON.parse(r.cells || "{}"), owner: editor.id }), editor.id, editor.id, r.id);
  await replaceRowDocument(rowIds[0], `<p>Frag <span data-mention="${editor.id}" class="mention">@editor</span>: die Hauptstadt von Frankreich ist <span data-cloze="1">Paris</span>.</p>`, owner.id);
  const fid = id();
  mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
  const picture = png(64, 48);
  writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fid), picture);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "karte.png", "image/png", picture.length, owner.id);
  const masks = [
    { id: "a", shape: "rect", x: 0.1, y: 0.1, w: 0.3, h: 0.2, label: "Nord" },
    { id: "b", shape: "polygon", x: 0.5, y: 0.5, w: 0.2, h: 0.2, points: [[0.5, 0.5], [0.7, 0.5], [0.6, 0.7]] },
  ];
  const rid = (await act({ action: "row.create", pageId, cells: { title: "Wo liegt das?", back: "", type: "Bildverdeckung" } })).id as string;
  await replaceRowDocument(rid, `<p>Wo liegt das?</p><img src="/api/files/${fid}" alt="Karte" data-occlusion="${occlusion(masks)}">`, owner.id);
  // Someone studied: their state stays where it is.
  const first = (await queue(pageId)).cards[0];
  await act({ action: "study.review", pageId, rowId: first.rowId, sub: first.sub, rating: 3, id: randomUUID(), zone });
  assert.ok(await one("SELECT 1 FROM card_states WHERE page_id=?", pageId));
  const deckCards = (await queue(pageId)).total;

  const templateId = (await act({ action: "template.save", pageId, name: "Erdkunde" })).id as string;
  const draft = await pkgs.packageDraft(owner, { kind: "database", workspaceId: wid, id: templateId });
  const codes = draft.notes.map((n) => n.code);
  assert.ok(codes.includes("study-never"), "the dialog says learning progress stays");
  assert.ok(codes.includes("people-cleared"));
  const built = await pkgs.buildPackage(owner, { kind: "database", workspaceId: wid, id: templateId }, { titles: { en: "Geography" }, summary: { de: "Erdkunde.", en: "Geography." }, category: "knowledge", tags: ["Lernkarten"], language: "de" }, []);

  // What the package holds.
  const outer = await readZip(built.bytes, { foreign: true });
  const everything = [...outer.values()].map((b) => b.toString("latin1")).join("\n");
  const inner = await readZip(outer.get("payload/template.zip")!, { foreign: true });
  const manifest = JSON.parse(inner.get("template.json")!.toString("utf8"));
  const payload = manifest.payload as string;
  for (const who of [owner, editor]) {
    assert.ok(!payload.includes(who.id) && !everything.includes(who.id), `no id of ${who.name}`);
    assert.ok(!payload.includes(who.email), `no address of ${who.name}`);
  }
  assert.ok(!payload.includes("data-mention"), "no mention");
  for (const word of ["card_states", "review_log", "stability", "difficulty", "\"due\"", "memory", "created_by", "updated_by"]) assert.ok(!payload.includes(word), `no ${word}`);
  const content = JSON.parse(payload);
  assert.ok(content.rows.every((r: { cells: Record<string, unknown> }) => !("owner" in r.cells)), "person values cleared");
  assert.ok(payload.includes('data-cloze=\\"1\\"'), "the cloze mark travels");
  assert.ok(payload.includes("data-occlusion"), "the masks travel");
  assert.ok(manifest.files.some((f: { id: string }) => f.id === fid) && inner.has(`files/${fid}`), "the picture travels");

  const meta = JSON.parse(outer.get(STUDY_META_PATH)!.toString("utf8"));
  assert.equal(meta.format, STUDY_META_FORMAT);
  assert.equal(meta.cards, deckCards);
  const masked = meta.samples.find((s: { type: string; image?: unknown }) => s.type === "occlusion" && s.image);
  assert.deepEqual(masked.image, { file: fid, alt: "Karte" }, "the sample's picture is the template's attachment");
  assert.deepEqual(masked.masks.map((m: { shape: string }) => m.shape), ["rect", "polygon"]);
  assert.ok(!JSON.stringify(meta).includes("@editor"));

  // Read back and installed elsewhere: a fresh deck.
  const parsed = await pkgs.readPackage(built.bytes);
  assert.equal(parsed.payload.kind === "database" && parsed.payload.cards, deckCards);
  assert.equal(pkgs.packagePreview(parsed).creates!.cards, deckCards);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  const copy = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, title: "Vom Marketplace", templateId: result.templateId }, other)).id as string;
  const q = await queue(copy, other);
  assert.equal(q.total, deckCards);
  assert.ok(q.cards.every((c: { memory: unknown }) => c.memory === null), "every card new");
  assert.equal(await one("SELECT 1 FROM card_states WHERE page_id=?", copy), undefined);
  assert.equal(await one("SELECT 1 FROM review_log WHERE page_id=?", copy), undefined);
  const occluded = q.cards.find((c: { kind: string; occlusion?: { masks: unknown[] } }) => c.kind === "occlusion" && c.occlusion!.masks.length === 2);
  assert.ok(occluded, "the masks over the uploaded picture");
  assert.match(occluded.occlusion.src, /^\/api\/files\//);
  assert.notEqual(occluded.occlusion.src, `/api/files/${fid}`, "a copy of the picture in the new workspace");
  const rows = await all<{ created_by: string }>("SELECT created_by FROM rows WHERE page_id=?", copy);
  assert.ok(rows.every((r) => r.created_by === other.id), "the records are the new owner's");
});

test("other database templates get no study-meta, but lose what is about people as well", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Liste" })).id as string;
  const templateId = (await act({ action: "template.save", pageId, name: "Liste" })).id as string;
  const built = await pkgs.buildPackage(owner, { kind: "database", workspaceId: wid, id: templateId }, { titles: { en: "List" }, summary: { en: "A list." }, category: "other", language: "en" }, []);
  const outer = await readZip(built.bytes, { foreign: true });
  assert.equal(outer.has(STUDY_META_PATH), false);
  assert.ok(![...outer.values()].some((b) => b.toString("latin1").includes(owner.id)));
  const parsed = await pkgs.readPackage(built.bytes);
  assert.equal(parsed.payload.kind === "database" && parsed.payload.cards, undefined);
});

test("official decks carry study-meta.json, deterministic; other official templates none", async () => {
  const a = await officialPackages("0.10.2");
  const b = await officialPackages("0.10.2");
  for (const key of ["flashcards", "vocabulary", "shortcuts"]) {
    const pkg = a.find((p) => p.kind === "database" && p.id === key)!;
    const meta = JSON.parse((await readZip(pkg.bytes, { foreign: true })).get(STUDY_META_PATH)!.toString("utf8"));
    assert.ok(meta.cards > 0 && meta.samples.length > 0, key);
    assert.ok(pkg.bytes.equals(b.find((p) => p.kind === "database" && p.id === key)!.bytes), `${key}: the same bytes again`);
  }
  const project = a.find((p) => p.id === "project")!;
  assert.equal((await readZip(project.bytes, { foreign: true })).has(STUDY_META_PATH), false);
});
