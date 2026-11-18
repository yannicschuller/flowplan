// Flashcards on a public link (docs/specs/flashcards.md §7.3): the cards a
// share hands out (lib/shared-study.ts) – public properties only, no private
// records, password and end date as on every other way through the link,
// images through the share's own paths, parts of 2000 – and the learning
// state the practice keeps in the browser (lib/public-study-progress.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";
import {
  currentDeck,
  parseProgress,
  practiceParams,
  practiceQueue,
  progressKey,
  progressStore,
  type DeckProgress,
  type PracticeSettings,
} from "../lib/public-study-progress";
import { hasProgress } from "../lib/public-study-key";
import { studyDay } from "../lib/study-day";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-public-study-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { sharedStudyCards, publicStudyDeck, PUBLIC_STUDY_PAGE } = await import("../lib/shared-study");
const { publicLayout } = await import("../components/public-views");
const access = await import("../lib/share-access");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Teilen"),
  boot = await bootstrap(owner, wid);
const status = async (fn: () => unknown, code: number) => assert.rejects(async () => fn(), (e: { status?: number }) => e.status === code);
const setDocument = async (rowId: string, html: string) => {
  const doc = await one("SELECT 1 FROM row_documents WHERE row_id=?", rowId);
  if (doc) await run("UPDATE row_documents SET html=?,state=? WHERE row_id=?", html, htmlState(html), rowId);
  else await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rowId, htmlState(html), html, id());
};
const occlusion = (fileId: string) =>
  `<img src="/api/files/${fileId}" alt="Planeten" data-occlusion="${JSON.stringify({ v: 1, mode: "hide-all", masks: [{ id: "m1", shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "Venus" }, { id: "m2", shape: "ellipse", x: 0.5, y: 0.5, w: 0.2, h: 0.2, label: "Erde" }] }).replace(/"/g, "&quot;")}">`;

async function deck(title: string) {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title, databaseKind: "flashcards" })) as { id: string }).id;
  return pageId;
}
const rowOf = async (pageId: string, cells: Record<string, unknown>) => ((await command(owner, { action: "row.create", pageId, cells })) as { id: string }).id;

test("a shared deck: public cards only, in the share's file paths, password and end date as the link's", async () => {
  const pageId = await deck("Astronomie");
  const basic = await rowOf(pageId, { title: "Größter Planet?", back: "Jupiter" });
  await rowOf(pageId, { title: "Der {{c1::Mond}} kreist um die {{c2::Erde}}.", back: "", type: "Lückentext" });
  const secret = await rowOf(pageId, { title: "Geheim", back: "Nur für mich" });
  await run("UPDATE rows SET access='private' WHERE id=?", secret);
  const pictured = await rowOf(pageId, { title: "Welcher Planet?", back: "", type: "Bildverdeckung" });
  const fileId = randomUUID();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fileId, pageId, "planeten.png", "image/png", 1, owner.id);
  await setDocument(pictured, `<p>Das innere Sonnensystem</p><p>${occlusion(fileId)}</p>`);
  const token = ((await command(owner, { action: "share.create", pageId, role: "viewer", name: "Klasse 7" })) as { token: string }).token;

  const answer = await sharedStudyCards(token, { pageId });
  assert.equal(answer.total, 5, "one basic, two clozes, two masks – the private record stays out");
  assert.ok(!JSON.stringify(answer).includes("Nur für mich"));
  assert.ok(!JSON.stringify(answer).includes("memory"), "no learning state of anybody");
  const first = answer.cards.find((c) => c.rowId === basic)!;
  assert.deepEqual([first.front, first.back].map((s) => ("text" in s ? s.text : "")), ["Größter Planet?", "Jupiter"]);
  const clozes = answer.cards.filter((c) => c.kind === "cloze");
  assert.deepEqual(clozes.map((c) => c.sub), ["c1", "c2"]);
  const masked = answer.cards.filter((c) => c.kind === "occlusion");
  assert.equal(masked.length, 2);
  assert.equal(masked[0].occlusion!.src, `/api/share/${token}/files/${fileId}`, "the picture through the share");
  assert.ok(!JSON.stringify(answer).includes(`"/api/files/`), "no file address of the workspace");
  assert.equal(masked[0].back && "text" in masked[0].back ? masked[0].back.text : "", "Venus");
  assert.equal(answer.settings.newPerDay, 20);

  // Parts: offset and limit.
  const part = await sharedStudyCards(token, { pageId, offset: 1, limit: 2 });
  assert.equal(part.cards.length, 2);
  assert.equal(part.next, 3);
  assert.equal((await sharedStudyCards(token, { pageId, offset: 4, limit: 2 })).next, null);
  assert.equal(PUBLIC_STUDY_PAGE, 2000);

  // A password: nothing without the unlock cookie, everything with it.
  await command(owner, { action: "share.protect", pageId, token, password: "sterne-123" });
  await status(() => sharedStudyCards(token, { pageId }), 401);
  const { value } = await access.unlockShare(token, "sterne-123", "10.0.0.9");
  assert.equal((await access.withShareCookie(value, () => sharedStudyCards(token, { pageId }))).total, 5);
  // After its end: gone.
  await command(owner, { action: "share.protect", pageId, token, password: null, expiresAt: Date.now() + 60_000 });
  await run("UPDATE share_links SET expires_at=? WHERE token=?", Date.now() - 1, token);
  await status(() => sharedStudyCards(token, { pageId }), 410);
});

test("a mapping that reads a hidden property shows no cards; the study view is public only then", async () => {
  const pageId = await deck("Vokabeln");
  await rowOf(pageId, { title: "perro", back: "Hund" });
  const token = ((await command(owner, { action: "share.create", pageId, role: "viewer", name: "Kurs" })) as { token: string }).token;
  const raw = (await one<{ fields: string; views: string; version: number }>("SELECT fields,views,version FROM databases WHERE page_id=?", pageId))!;
  const fields = JSON.parse(raw.fields);
  const study = JSON.parse(raw.views).find((v: { type: string }) => v.type === "study");
  assert.ok(study, "the flashcards database has a study view");
  const settings = (await publicStudyDeck(token, pageId))!.settings;
  assert.equal(publicLayout(study, fields, settings), true);
  // The back gets a read rule: no public cards, no public study view.
  const ruled = fields.map((f: { id: string }) => (f.id === "back" ? { ...f, access: { read: "owners" } } : f));
  await command(owner, { action: "database.update", pageId, version: raw.version, fields: ruled, views: JSON.parse(raw.views) });
  assert.equal(await publicStudyDeck(token, pageId), null);
  await status(() => sharedStudyCards(token, { pageId }), 404);
  assert.equal(publicLayout(study, ruled, settings), false);
  assert.equal(publicLayout(study, fields, undefined), false, "no mapping, no study view");
  // A view of another type or another page of the workspace: not found.
  await status(() => sharedStudyCards(token, { pageId, viewId: "nope" }), 404);
});

// ---- the progress in the browser ----

const settings: PracticeSettings = {
  newPerDay: 2,
  reviewsPerDay: 200,
  retention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
  maxInterval: 36500,
  buryNew: true,
  buryReviews: true,
  typedCompare: { ignoreCase: true, ignoreAccents: false, ignorePunctuation: true },
};
const cards = ["a", "b", "c", "d"].map((rowId) => ({ rowId, sub: "", kind: "basic", front: { text: rowId }, back: { text: rowId.toUpperCase() } }));
const zone = "Europe/Berlin";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("practice: new cards within the deck's limit, ratings fold into the state on a later day", () => {
  const now = Date.UTC(2026, 10, 18, 10);
  let progress: DeckProgress = currentDeck(undefined, practiceParams(settings), now, zone);
  let q = practiceQueue({ pageId: "p", title: "Deck", settings, cards, progress }, { now, zone, limit: 50 });
  assert.equal(q.counts.new, 2, "the deck's new cards per day");
  assert.equal(q.cards.length, 2);
  // Good on a new card: learning, back in minutes.
  progress = { ...progress, reviews: [{ id: randomUUID(), userId: "", pageId: "p", rowId: q.cards[0].rowId, sub: "", rating: 3, reviewedAt: now, zone, baseReps: 0 }] };
  q = practiceQueue({ pageId: "p", title: "Deck", settings, cards, progress }, { now: now + 1000, zone, limit: 50 });
  assert.equal(q.counts.new, 1, "one new card left today");
  assert.equal(q.done.new, 1);
  // "Heute mehr lernen".
  progress.more[progress.day] = 10;
  q = practiceQueue({ pageId: "p", title: "Deck", settings, cards, progress }, { now: now + 1000, zone, limit: 50 });
  assert.equal(q.counts.new, 3);
  // The next day: the rating is part of the base, the extra limit gone.
  const tomorrow = now + 86_400_000;
  const next = currentDeck(progress, practiceParams(settings), tomorrow, zone);
  assert.equal(next.reviews.length, 0);
  assert.equal(next.day, studyDay(tomorrow, zone));
  assert.equal(Object.keys(next.base).length, 1);
  assert.deepEqual(next.more, {});
  q = practiceQueue({ pageId: "p", title: "Deck", settings, cards, progress: next }, { now: tomorrow, zone, limit: 50 });
  assert.equal(q.counts.new, 2);
  assert.ok(q.counts.learning + q.counts.review >= 1, "the card studied yesterday is due");
});

test("practice storage: localStorage under flowplan-study:<token>, memory without it, damaged data ignored", () => {
  const storage = memoryStorage();
  const store = progressStore("tok", storage);
  assert.equal(store.persistent, true);
  assert.equal(hasProgress("tok", storage), false);
  const deck = currentDeck(undefined, practiceParams(settings), Date.now(), zone);
  deck.reviews.push({ id: randomUUID(), userId: "", pageId: "p", rowId: "a", sub: "", rating: 3, reviewedAt: Date.now(), zone, baseReps: 0 });
  store.write({ v: 1, noted: true, decks: { p: deck } });
  assert.deepEqual([...storage.map.keys()], [progressKey("tok")]);
  assert.equal(progressKey("tok"), "flowplan-study:tok");
  assert.equal(store.read().noted, true);
  assert.equal(store.read().decks.p.reviews.length, 1);
  assert.equal(hasProgress("tok", storage), true);
  store.clear();
  assert.equal(storage.map.size, 0);
  assert.equal(hasProgress("tok", storage), false);
  // A browser that refuses storage: the session keeps it in memory.
  const refusing = { getItem: () => null, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => {} };
  const once = progressStore("tok", refusing);
  assert.equal(once.persistent, false);
  once.write({ v: 1, decks: { p: deck } });
  assert.equal(once.read().decks.p.reviews.length, 1);
  assert.equal(progressStore("tok", null).persistent, false);
  // Anything else stored there is no progress.
  assert.deepEqual(parseProgress("{nope"), { v: 1, decks: {} });
  assert.deepEqual(parseProgress(JSON.stringify({ v: 2, decks: {} })), { v: 1, decks: {} });
  const odd = parseProgress(JSON.stringify({ v: 1, decks: { p: { base: { x: { state: 9 } }, reviews: [{ rowId: "a", sub: "", rating: 7, reviewedAt: 1 }], more: { d: -1 } } } }));
  assert.deepEqual(odd.decks.p, { base: {}, day: "", reviews: [], more: {} });
});

test("a published deck: copied with its card mapping and a study view, nobody's state", async () => {
  const { copyPublication } = await import("../lib/publication-copy");
  const pageId = await deck("Zum Kopieren");
  await rowOf(pageId, { title: "uno", back: "eins" });
  await command(owner, { action: "page.publish", pageId, enabled: true });
  const token = (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pageId))!.public_token;
  assert.equal((await sharedStudyCards(token, { pageId })).total, 1, "a publication shows its cards too");
  const visitor = await user("visitor");
  const own = await createWorkspace(visitor.id, "Eigen");
  const ownSpace = (await bootstrap(visitor, own)).spaces[0].id;
  const copied = await copyPublication(visitor, { token, workspaceId: own, spaceId: ownSpace });
  const stored = (await one<{ settings: string; views: string }>("SELECT settings,views FROM databases WHERE page_id=?", copied.id))!;
  assert.equal(JSON.parse(stored.settings).study.front.field, "title");
  assert.ok(JSON.parse(stored.views).some((v: { type: string }) => v.type === "study"));
  assert.equal(await one("SELECT 1 FROM card_states WHERE page_id=?", copied.id), undefined);
});
