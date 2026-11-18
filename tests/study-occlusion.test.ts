// Flashcards phase 6: image occlusion (docs/specs/flashcards.md §5.5) – the
// stored masks (cleaned, limited), one card per mask or group with stable
// keys, the pictures in a record's document and the text around them, the
// cleaning of documents, Anki's "Occlusion" field both ways, and the cards
// as the queue, the offline copy, the due counts and the CSV export see
// them. Runs on SQLite and PostgreSQL (test:db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";
import {
  MAX_MASKS,
  fromAnkiOcclusion,
  maskKey,
  occludedImages,
  occlusionAttribute,
  occlusionTargets,
  parseOcclusion,
  toAnkiOcclusion,
  withoutOccludedImages,
  type Occlusion,
} from "../lib/study-occlusion";
import { deriveCards, needsDocument } from "../lib/study-content";
import { studySettingsSchema } from "../lib/study-schema";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study6-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyOffline, studyExport } = await import("../lib/study");
const { studyDue } = await import("../lib/study-stats");
const { localQueue } = await import("../lib/study-offline");
const { cleanHtml, htmlState } = await import("../lib/document-server");

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333",
  G = "99999999-9999-4999-8999-999999999999";
const masks = (mode: Occlusion["mode"] = "hide-all"): Occlusion => ({
  v: 1,
  mode,
  masks: [
    { id: A, shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "Vorhof" },
    { id: B, shape: "ellipse", x: 0.5, y: 0.5, w: 0.2, h: 0.1, group: G, label: "Kammer" },
    { id: C, shape: "polygon", x: 0, y: 0, w: 0, h: 0, points: [[0.6, 0.1], [0.9, 0.1], [0.75, 0.4]], group: G },
  ],
});
const img = (o: Occlusion | string, alt = "Herz") => `<img src="/api/files/0b6c5c1e-1111-4222-8333-944455556666" alt="${alt}" data-occlusion="${(typeof o === "string" ? o : JSON.stringify(o)).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;

test("masks are cleaned: positions inside the picture, ids, shapes and limits", () => {
  const parsed = parseOcclusion(JSON.stringify(masks()))!;
  assert.equal(parsed.mode, "hide-all");
  assert.equal(parsed.masks.length, 3);
  // A polygon's box comes from its corners.
  assert.deepEqual([parsed.masks[2].x, parsed.masks[2].y, parsed.masks[2].w, parsed.masks[2].h], [0.6, 0.1, 0.3, 0.3]);
  const dirty = parseOcclusion({
    mode: "weird",
    masks: [
      { id: A, shape: "rect", x: -1, y: 0.95, w: 3, h: 0.5, label: "a\u0000b   c", onclick: "x()" },
      { id: A, shape: "rect", x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { id: "<script>", shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1 },
      { id: B, shape: "star", x: 0, y: 0, w: 0.1, h: 0.1 },
      { id: C, shape: "rect", x: 0.2, y: 0.2, w: 0.001, h: 0.2 },
      { id: G, shape: "polygon", points: [[0, 0], [1, 1]] },
    ],
  })!;
  assert.equal(dirty.mode, "hide-all", "an unknown mode is the default");
  assert.deepEqual(dirty.masks, [{ id: A, shape: "rect", x: 0, y: 0.95, w: 1, h: 0.05, label: "a b c" }], "kept within the picture; doubles, bad ids, shapes and tiny masks dropped");
  assert.equal(parseOcclusion("{kaputt"), null);
  assert.equal(parseOcclusion({ masks: [] }), null);
  assert.equal(occlusionAttribute({ masks: [] }), null);
  const many = { masks: Array.from({ length: MAX_MASKS + 5 }, (_, i) => ({ id: `m${i}`, shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1 })) };
  assert.equal(parseOcclusion(many)!.masks.length, MAX_MASKS);
});

test("one card per mask or group, with keys that stay when masks move", () => {
  const targets = occlusionTargets(masks());
  assert.deepEqual(
    targets.map((t) => [t.key, t.masks.length, t.labels]),
    [
      [`o:${A}`, 1, ["Vorhof"]],
      [`g:${G}`, 2, ["Kammer"]],
    ],
  );
  assert.ok(targets.every((t) => t.key.length <= 40), "within the sub of a rating");
  const moved = { ...masks(), masks: masks().masks.map((m) => ({ ...m, x: m.x + 0.05, label: "neu" })) };
  assert.deepEqual(occlusionTargets(moved).map((t) => t.key), targets.map((t) => t.key));
  assert.equal(maskKey({ id: A }), `o:${A}`);
});

test("pictures with masks in a document, and the text around them", () => {
  const html = `<p>Das Herz</p><figure class="block-figure">${img(masks())}<figcaption>Abb. 1</figcaption></figure><p>Zweites Bild:</p><p>${img(masks("hide-one"), "")}</p><img src="/x.png"><hr><p>Rückseite</p>`;
  const images = occludedImages(html);
  assert.equal(images.length, 2);
  assert.equal(images[0].alt, "Herz");
  assert.equal(images[1].occlusion.mode, "hide-one");
  assert.equal(withoutOccludedImages(html), '<p>Das Herz</p><p>Zweites Bild:</p><img src="/x.png"><hr><p>Rückseite</p>', "the figure goes with its caption, the empty paragraph too");
  assert.deepEqual(occludedImages('<img src="/x.png" data-occlusion="kaputt">'), []);
});

test("documents keep only clean masks", () => {
  const clean = cleanHtml(`<p>${img(masks())}</p>`);
  assert.equal(occludedImages(clean).length, 1);
  assert.match(clean, /data-occlusion="\{&quot;v&quot;:1/);
  const tricked = cleanHtml(`<p><img src="/x.png" data-occlusion='{"masks":[{"id":"x","shape":"rect","x":0,"y":0,"w":0.5,"h":0.5,"label":"<b onmouseover=alert(1)>"}],"evil":"<script>"}'></p><div data-occlusion="${JSON.stringify(masks()).replace(/"/g, "&quot;")}">x</div>`);
  assert.doesNotMatch(tricked, /evil|<div data-occlusion/, "unknown keys and other elements lose it");
  assert.deepEqual(occludedImages(tricked)[0].occlusion.masks[0].label, "<b onmouseover=alert(1)>", "a label is text (shown as React text)");
  assert.doesNotMatch(cleanHtml('<p><img src="/x.png" data-occlusion="nichts"></p>'), /data-occlusion/);
});

const fields = [
  { id: "title", name: "Vorderseite", type: "text" },
  { id: "back", name: "Rückseite", type: "text" },
  { id: "type", name: "Kartentyp", type: "select", options: ["Vorder-/Rückseite", "Bildverdeckung"] },
] as never;
test("deriveCards: an occlusion record's cards, sides without the picture", () => {
  const settings = studySettingsSchema.parse({ version: 1, type: { field: "type" }, front: { field: "title" }, back: { document: "all" } });
  const doc = `<p>Notiz</p><p>${img(masks())}</p>`;
  const cards = deriveCards(settings, fields, { title: "Herz", type: "Bildverdeckung" }, doc);
  assert.deepEqual(cards.map((c) => [c.sub, c.kind, c.occlusion?.index, c.occlusion?.total, c.occlusion?.target.length]), [
    [`o:${A}`, "occlusion", 1, 2, 1],
    [`g:${G}`, "occlusion", 2, 2, 2],
  ]);
  assert.deepEqual(cards[0].front, { text: "Herz" });
  assert.deepEqual(cards[0].back, { html: "<p>Notiz</p>" });
  // The same picture twice is one card per key.
  assert.equal(deriveCards(settings, fields, { title: "Herz", type: "Bildverdeckung" }, doc + doc).length, 2);
  assert.deepEqual(deriveCards(settings, fields, { title: "Herz", type: "Bildverdeckung" }, "<p>kein Bild</p>"), []);
  // Basic records ignore masks; only occlusion records need the document.
  assert.equal(deriveCards(settings, fields, { title: "Herz", back: "x", type: "Vorder-/Rückseite" }, doc)[0].kind, "basic");
  const textSides = studySettingsSchema.parse({ version: 1, type: { field: "type" }, front: { field: "title" }, back: { field: "back" } });
  assert.equal(needsDocument(textSides, { type: "Bildverdeckung" }), true);
  assert.equal(needsDocument(textSides, { type: "Vorder-/Rückseite" }), false);
});

test("Anki's Occlusion field: shapes, groups, mode and pixels", () => {
  let n = 0;
  const next = () => `id${++n}`;
  const field =
    "{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}<br>{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.05:oi=1}}<br>{{c2::image-occlusion:polygon:points=.1,.6 .3,.6 .2,.9:oi=1}}<br>{{c3::image-occlusion:text:text=Hallo:left=.1:top=.1}}";
  const read = fromAnkiOcclusion(field, next);
  assert.equal(read.occlusion!.mode, "hide-all");
  assert.equal(read.skipped, 1, "the text shape");
  assert.deepEqual(
    read.occlusion!.masks.map((m) => [m.shape, m.x, m.y, m.w, m.h, !!m.group]),
    [
      ["rect", 0.1, 0.2, 0.3, 0.1, false],
      ["ellipse", 0.5, 0.5, 0.2, 0.1, true],
      ["polygon", 0.1, 0.6, 0.2, 0.3, true],
    ],
  );
  assert.equal(read.numbers.get(1), `o:${read.occlusion!.masks[0].id}`);
  assert.equal(read.numbers.get(2), `g:${read.occlusion!.masks[1].group}`);
  // Without oi: only the one asked is covered.
  assert.equal(fromAnkiOcclusion("{{c1::image-occlusion:rect:left=.1:top=.1:width=.1:height=.1}}", next).occlusion!.mode, "hide-one");
  // Pixels (Anki 23.10): with the picture's size, else nothing.
  const pixels = "{{c1::image-occlusion:rect:left=64:top=40:width=128:height=80}}";
  assert.deepEqual(
    fromAnkiOcclusion(pixels, next, { width: 640, height: 400 }).occlusion!.masks.map((m) => [m.x, m.y, m.w, m.h]),
    [[0.1, 0.1, 0.2, 0.2]],
  );
  assert.equal(fromAnkiOcclusion(pixels, next).occlusion, null);
  // Written back: one cloze number per card, read again the same.
  const written = toAnkiOcclusion(masks());
  assert.match(written, /^\{\{c1::image-occlusion:rect:left=\.1:top=\.1:width=\.2:height=\.2:oi=1\}\}<br>\{\{c2::image-occlusion:ellipse:/);
  const again = fromAnkiOcclusion(written, next).occlusion!;
  assert.deepEqual(occlusionTargets(again).map((t) => t.masks.length), [1, 2]);
  assert.deepEqual(again.masks.map((m) => [m.shape, m.x, m.y, m.w, m.h]), parseOcclusion(masks())!.masks.map((m) => [m.shape, m.x, m.y, m.w, m.h]));
});

// ---- the deck ----

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Bildverdeckung"),
  boot = await bootstrap(owner, wid);
const zone = "Europe/Berlin";
const setDocument = async (rowId: string, html: string) => {
  const doc = await one("SELECT 1 FROM row_documents WHERE row_id=?", rowId);
  if (doc) await run("UPDATE row_documents SET html=?,state=? WHERE row_id=?", html, htmlState(html), rowId);
  else await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rowId, htmlState(html), html, id());
};

test("the queue, a rating, a moved mask, the due counts, offline and the CSV export", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Anatomie", databaseKind: "flashcards" })) as { id: string }).id;
  const db = await database(pageId);
  assert.ok(db.fields.find((f) => f.id === "type")?.options?.includes("Bildverdeckung"), "the flashcards database offers the type");
  const rowId = ((await command(owner, { action: "row.create", pageId, cells: { title: "Das Herz", back: "Vier Kammern", type: "Bildverdeckung" } })) as { id: string }).id;
  await command(owner, { action: "row.create", pageId, cells: { title: "hola", back: "hallo" } });
  await setDocument(rowId, `<p>${img(masks())}</p>`);
  const q = (await command(owner, { action: "study.queue", pageId, zone, limit: 50 })) as any;
  assert.equal(q.total, 3, "two occlusion cards and one basic card");
  const occ = q.cards.filter((c: any) => c.kind === "occlusion");
  // Siblings wait for the next day: one card of the record today.
  assert.equal(occ.length, 1);
  const first = occ[0];
  const group = first.sub === `g:${G}`;
  assert.ok(first.sub === `o:${A}` || group);
  assert.equal(first.context.text, "Das Herz");
  assert.equal(first.note.text, "Vier Kammern");
  assert.deepEqual(first.back, { text: group ? "Kammer" : "Vorhof" }, "the labels are the answer");
  assert.equal(first.occlusion.src, "/api/files/0b6c5c1e-1111-4222-8333-944455556666");
  assert.equal(first.occlusion.masks.length, 3);
  assert.deepEqual(first.occlusion.target, group ? [B, C] : [A]);
  // studyDue counts every mask card like cloze cards.
  const due = (await studyDue(owner, { workspaceId: wid, zone })) as any;
  assert.equal(due.decks.find((d: any) => d.pageId === pageId).new, 3);
  await command(owner, { action: "study.review", pageId, rowId, sub: first.sub, rating: 3, id: randomUUID(), zone });
  // Masks moved and relabelled: the cards and the learning state stay.
  const moved = { ...masks(), masks: masks().masks.map((m) => ({ ...m, y: m.y + 0.05, label: m.label ? `${m.label}!` : undefined })) };
  await setDocument(rowId, `<p>${img(moved)}</p>`);
  const after = (await command(owner, { action: "study.queue", pageId, zone, limit: 0 })) as any;
  assert.equal(after.total, 3);
  assert.equal(after.states.learning, 1, "the rated mask kept its state");
  // The group removed: its card rests; a new mask is a new card.
  const fewer = { ...moved, masks: [moved.masks[0], { id: randomUUID(), shape: "rect" as const, x: 0.7, y: 0.7, w: 0.1, h: 0.1 }] };
  if (group) await command(owner, { action: "study.review", pageId, rowId, sub: `o:${A}`, rating: 3, id: randomUUID(), zone, reviewedAt: Date.now() + 1000 });
  await setDocument(rowId, `<p>${img(fewer)}</p>`);
  const changed = (await command(owner, { action: "study.queue", pageId, zone, limit: 0 })) as any;
  assert.equal(changed.total, 3);
  assert.equal(changed.states.learning, 1);
  // The offline copy carries the picture and its masks; the device's queue
  // takes the cards like any other.
  const snapshot = (await studyOffline(owner, { pageId, zone })) as any;
  const offlineCard = snapshot.cards.find((c: any) => c.kind === "occlusion" && c.sub === `o:${A}`);
  assert.equal(offlineCard.occlusion.masks.length, 2);
  const local = localQueue(snapshot, [{ id: randomUUID(), userId: owner.id, pageId, rowId, sub: `o:${A}`, rating: 1, reviewedAt: Date.now(), zone, baseReps: 1 }], { now: Date.now(), zone, limit: 50 });
  assert.equal(local.pending, 1);
  assert.ok(local.cards.length >= 1);
  // The CSV export names the type and the card.
  const csv = (await studyExport(owner, { pageId, zone })).csv;
  assert.match(csv, /Das Herz,Vier Kammern,,,,Bildverdeckung,o:11111111-1111-4111-8111-111111111111/);
});
