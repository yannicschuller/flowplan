// Flashcards, the domain (docs/specs/flashcards.md §14.1 study.test.ts):
// the card index, the queue with its limits, ratings and undo, personal
// settings and who may do what. Runs on SQLite and PostgreSQL (test:db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyDecks } = await import("../lib/study-stats");
const { htmlState } = await import("../lib/document-server");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const reader = await user("reader");
const wid = await createWorkspace(owner.id, "Lernen"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, reader.id, "viewer");
const as = (who: Identity) => async (body: Record<string, unknown>): Promise<any> => await command(who, body);
const act = as(owner);
const zone = "Europe/Berlin";

async function deck(title: string, settings: Record<string, unknown> = {}) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Vorderseite", type: "text" },
      { id: "back", name: "Rückseite", type: "text" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
      { id: "secret", name: "Geheim", type: "text", access: { read: "editors" } },
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [] },
      { id: "chapter", name: "Nur A", type: "study", filters: [{ field: "tags", op: "contains", value: "A" }], sorts: [] },
      { id: "table", name: "Alle Karten", type: "table", filters: [], sorts: [] },
    ],
  });
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, ...settings } });
  return pageId;
}
const card = async (pageId: string, front: string, back: string, extra: Record<string, unknown> = {}) =>
  (await act({ action: "row.create", pageId, cells: { title: front, back, ...extra } })).id as string;
const queue = async (who: Identity, pageId: string, more: Record<string, unknown> = {}) => await command(who, { action: "study.queue", pageId, zone, ...more }) as any;
const rate = async (who: Identity, pageId: string, c: { rowId: string; sub: string }, rating: number, more: Record<string, unknown> = {}) =>
  (await command(who, { action: "study.review", pageId, rowId: c.rowId, sub: c.sub, rating, id: randomUUID(), zone, ...more })) as any;

test("a deck derives cards from its records and studies them with daily limits", async () => {
  const pageId = await deck("Spanisch", { newPerDay: 2 });
  await card(pageId, "hola", "hallo", { tags: ["A"] });
  await card(pageId, "perro", "Hund");
  await card(pageId, "gato", "Katze", { tags: ["A"] });
  await card(pageId, "leer", "");
  const first = await queue(owner, pageId);
  assert.equal(first.configured, true);
  // The record without a back is no card.
  assert.equal(first.total, 3);
  assert.deepEqual(first.counts, { new: 2, learning: 0, review: 0 });
  assert.deepEqual(first.cards.map((c: any) => c.front.text), ["hola", "perro"]);
  assert.deepEqual(first.cards[0].back, { text: "hallo", formatted: true });
  // A study view's filter is a sub-deck.
  assert.deepEqual((await queue(owner, pageId, { viewId: "chapter" })).cards.map((c: any) => c.front.text), ["hola", "gato"]);
  // Good on a new card: a learning step, the new limit is used once.
  const after = await rate(owner, pageId, first.cards[0], 3);
  assert.equal(after.review.memory.state, 1);
  assert.equal(after.done.new, 1);
  assert.deepEqual(after.counts, { new: 1, learning: 1, review: 0 });
  // Learning cards due within 20 minutes come first.
  const next = await queue(owner, pageId);
  assert.equal(next.cards[0].rowId, first.cards[0].rowId);
  assert.equal(next.cards[0].memory.state, 1);
  // Easy graduates to a review on a later study day.
  const easy = await rate(owner, pageId, next.cards[0], 4);
  assert.equal(easy.review.memory.state, 2);
  assert.match(easy.review.memory.dueDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(easy.counts.learning, 0);
  // Both new cards of today used: "Heute mehr lernen" adds more for today.
  await rate(owner, pageId, (await queue(owner, pageId)).cards.find((c: any) => !c.memory), 3);
  assert.equal((await queue(owner, pageId)).counts.new, 0);
  const more = await act({ action: "study.prefs", pageId, zone, more: { new: 10 } });
  assert.equal(more.limits.new, 12);
  assert.equal(more.counts.new, 1);
  // Own limits override the deck's, null returns to them.
  assert.equal((await act({ action: "study.prefs", pageId, zone, newPerDay: 0 })).limits.new, 10);
  assert.equal((await act({ action: "study.prefs", pageId, zone, newPerDay: null })).limits.new, 12);
});

test("a rating is idempotent by its id and the last one can be undone by replaying the log", async () => {
  const pageId = await deck("Undo");
  const rowId = await card(pageId, "uno", "eins");
  const [c] = (await queue(owner, pageId)).cards;
  const reviewId = randomUUID();
  const once = await rate(owner, pageId, c, 1, { id: reviewId });
  const again = await rate(owner, pageId, c, 4, { id: reviewId });
  assert.equal(again.duplicate, true);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM review_log WHERE row_id=?", rowId))!.n), 1);
  assert.equal(once.review.memory.state, 1);
  const second = await rate(owner, pageId, c, 3);
  // Only the last rating of a card.
  await assert.rejects(async () => await act({ action: "study.undo", pageId, reviewId, zone }), /letzte Wertung/);
  const undone = await act({ action: "study.undo", pageId, reviewId: second.review.id, zone });
  assert.equal(undone.card.rowId, rowId);
  const state = await one<{ stability: number; reps: number }>("SELECT stability,reps FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId);
  assert.equal(Number(state!.reps), 1);
  assert.equal(Number(state!.stability), once.review.memory.stability);
  // Undoing the first one too: the card is new again and the new limit freed.
  const fresh = await act({ action: "study.undo", pageId, reviewId, zone });
  assert.equal(await one("SELECT 1 FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId), undefined);
  assert.equal(fresh.done.new, 0);
  assert.equal(fresh.counts.new, 1);
  await assert.rejects(async () => await act({ action: "study.undo", pageId, reviewId, zone }), /schon rückgängig/);
});

test("reverse cards and siblings: one card of a record per study day", async () => {
  const pageId = await deck("Umgekehrt", { reverse: true });
  await card(pageId, "rojo", "rot");
  const q = await queue(owner, pageId);
  assert.equal(q.total, 2);
  // Never both sides of a record in one day.
  assert.equal(q.cards.length, 1);
  assert.equal(q.cards[0].sub, "");
  await rate(owner, pageId, q.cards[0], 4);
  assert.equal((await queue(owner, pageId)).counts.new, 0);
  const deckRow = (await all<{ sub: string }>("SELECT sub FROM study_cards WHERE page_id=? ORDER BY sub", pageId)).map((r) => r.sub);
  assert.deepEqual(deckRow, ["", "r"]);
});

test("the back from the record's document below its first rule", async () => {
  const pageId = await deck("Dokument", { front: { document: "above" }, back: { document: "below" } });
  const rowId = await card(pageId, "Titel", "");
  await act({ action: "row.update", pageId, rowId, version: 1, cells: { title: "Titel" } }).catch(() => undefined);
  const html = "<p>Was ist <strong>H₂O</strong>?</p><hr><p>Wasser</p><img src=\"/api/files/x\" alt=\"Bild\">";
  const doc = await one<{ generation: string }>("SELECT generation FROM row_documents WHERE row_id=?", rowId);
  if (doc) await run("UPDATE row_documents SET html=?,state=? WHERE row_id=?", html, htmlState(html), rowId);
  else await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rowId, htmlState(html), html, id());
  const [c] = (await queue(owner, pageId)).cards;
  assert.match(c.front.html, /^<p>Was ist <strong>H₂O<\/strong>\?<\/p>$/);
  assert.match(c.back.html, /<p>Wasser<\/p>/);
  assert.doesNotMatch(c.back.html, /<hr/);
});

test("reading is enough to study; the mapping needs write access; read tokens do not rate", async () => {
  const pageId = await deck("Rechte");
  await card(pageId, "sí", "ja");
  const q = await queue(reader, pageId);
  assert.equal(q.cards.length, 1);
  const rated = await rate(reader, pageId, q.cards[0], 3);
  assert.equal(rated.review.memory.state, 1);
  // Own state: the owner's deck is still new for the owner.
  assert.equal((await queue(owner, pageId)).counts.new, 1);
  await assert.rejects(async () => await command(reader, { action: "study.settings", pageId, settings: null }), /Keine Berechtigung/);
  await assert.rejects(async () => await command(reader, { action: "database.settings", pageId, settings: { study: null } }), /Keine Berechtigung|Unbekannte Einstellung/);
  await assert.rejects(async () => await act({ action: "database.settings", pageId, settings: { study: null } }), /Unbekannte Einstellung/);
  const readToken = { ...owner, apiScope: "read" as const };
  await assert.rejects(async () => await rate(readToken, pageId, q.cards[0], 3), /nur lesen/);
  const writeToken = { ...owner, apiScope: "write" as const };
  const viaApi = await rate(writeToken, pageId, q.cards[0], 3);
  assert.equal((await one<{ source: string }>("SELECT source FROM review_log WHERE id=?", viaApi.review.id))!.source, "api");
  // Studying is not an edit and leaves no audit entry; the mapping is.
  assert.equal(await one("SELECT 1 FROM audit WHERE action LIKE 'study.review' LIMIT 1"), undefined);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='study.settings' LIMIT 1"));
  // Deck list (MCP): counts per person.
  const decks = await studyDecks(reader, wid, zone);
  assert.ok(decks.some((d) => d.pageId === pageId && d.learning === 1));
});

test("hidden sides and private records give no cards", async () => {
  const pageId = await deck("Verborgen", { back: { field: "secret" } });
  await card(pageId, "clave", "x", { secret: "Schlüssel" });
  assert.equal((await queue(owner, pageId)).total, 1);
  const hidden = await queue(reader, pageId);
  assert.equal(hidden.blocked, "hidden");
  assert.equal(hidden.total, 0);
  const open = await deck("Privat");
  const mine = await card(open, "privado", "privat");
  await card(open, "público", "öffentlich");
  await run("UPDATE rows SET access='private' WHERE id=?", mine);
  assert.deepEqual((await queue(reader, open)).cards.map((c: any) => c.front.text), ["público"]);
  await assert.rejects(async () => await rate(reader, open, { rowId: mine, sub: "" }, 3), /Karte nicht gefunden/);
});

test("trash, restore and a changed mapping keep the learning state", async () => {
  const pageId = await deck("Papierkorb");
  const rowId = await card(pageId, "agua", "Wasser");
  const [c] = (await queue(owner, pageId)).cards;
  await rate(owner, pageId, c, 4);
  await act({ action: "row.delete", pageId, rowId });
  assert.equal((await queue(owner, pageId)).total, 0);
  assert.ok((await one<{ orphaned_at: number | null }>("SELECT orphaned_at FROM card_states WHERE row_id=?", rowId))!.orphaned_at);
  await act({ action: "row.trash.restore", trashId: rowId });
  const back = await queue(owner, pageId);
  assert.equal(back.total, 1);
  assert.equal(back.states.review, 1);
  assert.equal((await one<{ orphaned_at: number | null }>("SELECT orphaned_at FROM card_states WHERE row_id=?", rowId))!.orphaned_at, null);
  // Another mapping rebuilds the index; the keys and the state stay.
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "back" }, back: { field: "title" } } });
  const swapped = await queue(owner, pageId);
  assert.equal(swapped.states.review, 1);
  // A removed mapping: no deck any more.
  await act({ action: "study.settings", pageId, settings: null });
  assert.equal((await queue(owner, pageId)).configured, false);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM study_cards WHERE page_id=?", pageId))!.n), 0);
});

test("leaving the workspace removes the learning state, the own log stays", async () => {
  const pageId = await deck("Mitglied");
  await card(pageId, "luz", "Licht");
  const learner = await user("learner");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, learner.id, "viewer");
  const [c] = (await queue(learner, pageId)).cards;
  await rate(learner, pageId, c, 3);
  assert.ok(await one("SELECT 1 FROM card_states WHERE user_id=?", learner.id));
  await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, learner.id);
  assert.equal(await one("SELECT 1 FROM card_states WHERE user_id=?", learner.id), undefined);
  assert.ok(await one("SELECT 1 FROM review_log WHERE user_id=?", learner.id));
  await assert.rejects(async () => await queue(learner, pageId));
});

test("invalid mappings are refused", async () => {
  const pageId = await deck("Ungültig");
  await assert.rejects(async () => await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "nope" }, back: { field: "back" } } }), /unbekannte Eigenschaft/);
  await assert.rejects(async () => await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "back" }, back: { field: "back" } } }), /verschiedene/);
  await assert.rejects(async () => await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, retention: 0.5 } }));
  await assert.rejects(async () => await act({ action: "study.queue", pageId: (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Doc" })).id }), /Keine Datenbank/);
});

test("the database kind and the template “Lernkarten-Datenbank” start as decks", async () => {
  const kindId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", databaseKind: "flashcards", title: "Neu" })).id as string;
  const fresh = await database(kindId);
  assert.equal(fresh.views.find((v: any) => v.default)?.type ?? fresh.views[0].type, "study");
  assert.deepEqual(fresh.settings?.study?.front, { field: "title" });
  await card(kindId, "uno", "eins");
  assert.equal((await queue(owner, kindId)).total, 1);
  const templateId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", starterTemplate: "flashcards", title: "Vorlage" })).id as string;
  const q = await queue(owner, templateId);
  assert.equal(q.configured, true);
  assert.equal(q.total, 6);
  // The example property is shown after the answer.
  assert.ok(q.cards.some((c: any) => c.extra?.text?.includes("Taste")));
  // A reader studies the template's cards too.
  assert.equal((await queue(reader, templateId)).counts.new, 6);
});
