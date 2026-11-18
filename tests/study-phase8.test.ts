// Flashcards phase 8, the domain (docs/specs/flashcards.md §23): the log for
// the optimiser (study.history – own ratings only, undone ones and cards
// without their first rating left out, import and offline ones in, at least
// 1000), storing and resetting weights per deck or for all decks
// (study.params), scheduling, undo, the offline deck and the statistics with
// them, the memory states computed again, and the note to optimise (again).
// Runs on SQLite and PostgreSQL (test:db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study8-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyOffline, trainingCards, reviewCosts } = await import("../lib/study");
const { addDays } = await import("../lib/study-day");
const { DEFAULT_WEIGHTS, DEFAULT_COSTS, MIN_REVIEWS, memoryOf, optimize, clampWeights } = await import("../lib/fsrs/optimize");
const { replay, schedule } = await import("../lib/fsrs");
const { syntheticLog, TRUE_WEIGHTS } = await import("./helpers/fsrs-synthetic");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const reader = await user("reader");
const wid = await createWorkspace(owner.id, "Lernen 8"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, reader.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const zone = "Europe/Berlin";

async function deck(title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Vorderseite", type: "text" },
      { id: "back", name: "Rückseite", type: "text" },
    ],
    views: [{ id: "study", name: "Lernen", type: "study", filters: [], sorts: [] }],
  });
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" } } });
  return pageId;
}
const card = async (pageId: string, front: string) => (await act({ action: "row.create", pageId, cells: { title: front, back: `${front}!` } })).id as string;
// A log written straight into review_log (fast): synthetic cards of
// lib/fsrs's model, a day per unit of t, ending before today.
async function seedLog(who: Identity, pageId: string, cards: { t: number[]; r: number[] }[], source = "web", start = "2025-01-06", rowIds?: string[]) {
  let n = 0;
  for (const c of cards) {
    const rowId = rowIds?.[cards.indexOf(c)] ?? randomUUID();
    let day = start;
    for (let i = 0; i < c.r.length; i++) {
      day = addDays(day, c.t[i]);
      const at = Date.parse(`${day}T10:00:00Z`) + i * 60_000;
      await run(
        `INSERT INTO review_log(id,user_id,workspace_id,page_id,row_id,sub,rating,state_before,reviewed_at,day,zone,elapsed_days,scheduled_days,duration_ms,stability,difficulty,due,source,received_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        who.id,
        wid,
        pageId,
        rowId,
        "",
        c.r[i],
        i === 0 ? 0 : c.t[i] === 0 ? 1 : 2,
        at,
        day,
        zone,
        c.t[i],
        0,
        c.r[i] === 1 ? 15_000 : 6_000,
        1,
        5,
        at,
        source,
        at,
      );
      n++;
    }
  }
  return n;
}
const history = async (who: Identity, pageId: string, scope?: string): Promise<any> => await command(who, { action: "study.history", pageId, zone, ...(scope ? { scope } : {}) });
const params = async (who: Identity, body: Record<string, unknown>): Promise<any> => await command(who, { action: "study.params", zone, ...body });
const overview = async (who: Identity, pageId: string): Promise<any> => await command(who, { action: "study.queue", pageId, zone, limit: 0 });

test("the log for the optimiser: cards with their ratings and study days in order (pure)", () => {
  const rows = [
    { row_id: "a", sub: "", rating: 3, state_before: 0, day: "2026-01-01", duration_ms: 5000 },
    { row_id: "a", sub: "", rating: 3, state_before: 1, day: "2026-01-01", duration_ms: 4000 },
    { row_id: "a", sub: "", rating: 1, state_before: 2, day: "2026-01-04", duration_ms: 9000 },
    { row_id: "a", sub: "", rating: 4, state_before: 3, day: "2026-01-04", duration_ms: null },
    // Its first rating is not in the log (state before: review): left out.
    { row_id: "b", sub: "", rating: 3, state_before: 2, day: "2026-01-02", duration_ms: 3000 },
    { row_id: "b", sub: "", rating: 3, state_before: 2, day: "2026-01-09", duration_ms: 3000 },
    { row_id: "b", sub: "r", rating: 2, state_before: 0, day: "2026-01-02", duration_ms: 3000 },
    { row_id: "b", sub: "r", rating: 3, state_before: 2, day: "2026-01-12", duration_ms: 3000 },
  ];
  assert.deepEqual(trainingCards(rows), [
    { t: [0, 0, 3, 0], r: [3, 3, 1, 4] },
    { t: [0, 10], r: [2, 3] },
  ]);
  // Too few timed reviews: the default costs.
  assert.deepEqual(reviewCosts(rows), DEFAULT_COSTS);
  const many = Array.from({ length: 30 }, () => [
    { rating: 3, state_before: 0, duration_ms: 10_000 },
    { rating: 3, state_before: 2, duration_ms: 5_000 },
    { rating: 1, state_before: 2, duration_ms: 12_000 },
    { rating: 3, state_before: 3, duration_ms: 8_000 },
  ]).flat();
  const costs = reviewCosts(many);
  assert.equal(costs.learn, 10);
  assert.equal(costs.recall, 5);
  assert.equal(costs.forget, 20);
  assert.deepEqual(costs.first, [0, 0, 1, 0]);
  assert.deepEqual(costs.recalled, [0, 1, 0]);
});

test("study.history: below 1000 ratings only the count; own, not undone, import and offline included", async () => {
  const pageId = await deck("Spanisch");
  const few = await history(owner, pageId);
  assert.equal(few.reviews, 0);
  assert.equal(few.minimum, MIN_REVIEWS);
  assert.deepEqual(few.cards, []);
  assert.equal(few.current, null);
  assert.equal(few.model.source, "default");
  const log = syntheticLog(TRUE_WEIGHTS, 80, 11);
  const seeded = (await seedLog(owner, pageId, log.slice(0, 40), "import")) + (await seedLog(owner, pageId, log.slice(40), "offline"));
  // Another person's log never shows; an undone rating neither.
  await seedLog(reader, pageId, syntheticLog(TRUE_WEIGHTS, 120, 12));
  const undone = await one<{ id: string }>("SELECT id FROM review_log WHERE user_id=? AND page_id=? ORDER BY reviewed_at DESC LIMIT 1", owner.id, pageId);
  await run("UPDATE review_log SET undone_at=? WHERE id=?", Date.now(), undone!.id);
  const count = await history(owner, pageId);
  assert.equal(count.reviews, seeded - 1);
  assert.ok(count.reviews < MIN_REVIEWS);
  assert.deepEqual(count.cards, []);
  // More of the owner's (offline and import count like the rest).
  const more = await seedLog(owner, pageId, syntheticLog(TRUE_WEIGHTS, 100, 13), "offline");
  const full = await history(owner, pageId);
  assert.equal(full.reviews, seeded - 1 + more);
  assert.ok(full.reviews >= MIN_REVIEWS);
  assert.equal(full.cards.reduce((n: number, c: { r: number[] }) => n + c.r.length, 0), full.reviews);
  assert.equal(full.cards.length, 180);
  assert.ok(full.cards.every((c: { t: number[]; r: number[] }) => c.t.length === c.r.length && c.t[0] === 0));
  assert.deepEqual(full.defaults, [...DEFAULT_WEIGHTS]);
  assert.equal(full.retention, 0.9);
  // The reader has only their own.
  assert.equal((await history(reader, pageId)).reviews, syntheticLog(TRUE_WEIGHTS, 120, 12).reduce((n, c) => n + c.r.length, 0));
  // All decks: the same here (one deck), the person's whole log.
  assert.equal((await history(owner, pageId, "all")).reviews, full.reviews);
});

test("study.params: weights for a deck schedule its cards, offline too; reset goes back to the defaults", async () => {
  const pageId = await deck("Französisch");
  const rowId = await card(pageId, "le chat");
  await seedLog(owner, pageId, syntheticLog(TRUE_WEIGHTS, 120, 21));
  const before = await overview(owner, pageId);
  assert.equal(before.params.weights, undefined);
  assert.equal(before.model.source, "default");
  assert.equal(before.optimizer.suggest, "first");
  // A real card studied with the defaults.
  const t0 = Date.now() - 20 * 86_400_000;
  const first = randomUUID(),
    second = randomUUID();
  await command(owner, { action: "study.reviews", reviews: [{ id: first, pageId, rowId, sub: "", rating: 3, reviewedAt: t0, zone }] });
  await command(owner, { action: "study.reviews", reviews: [{ id: second, pageId, rowId, sub: "", rating: 3, reviewedAt: t0 + 4 * 86_400_000, zone }] });
  const data = await history(owner, pageId);
  const fit = optimize(data.cards);
  const answer = await params(owner, { pageId, weights: fit.weights, reviews: data.reviews, fit: { before: fit.before, after: fit.after } });
  assert.equal(answer.model.source, "deck");
  assert.equal(answer.model.reviews, data.reviews);
  assert.ok(answer.model.at > Date.now() - 60_000);
  assert.deepEqual(answer.params.weights, fit.weights);
  assert.equal(answer.optimizer.suggest, null);
  assert.ok(answer.recomputed >= 1);
  const stored = await one<{ params: string; params_at: number }>("SELECT params,params_at FROM study_prefs WHERE user_id=? AND page_id=?", owner.id, pageId);
  assert.deepEqual(JSON.parse(stored!.params).w, fit.weights);
  assert.ok(Number(stored!.params_at) > 0);
  // The card's stability and difficulty: its log under the new weights.
  const state = await one<{ stability: number; difficulty: number }>("SELECT stability,difficulty FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId);
  const expected = replay(
    [
      { id: first, rating: 3, reviewedAt: t0, zone },
      { id: second, rating: 3, reviewedAt: t0 + 4 * 86_400_000, zone },
    ],
    { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500, weights: fit.weights },
  )!;
  assert.ok(Math.abs(Number(state!.stability) - expected.stability) < 1e-6);
  assert.ok(Math.abs(Number(state!.difficulty) - expected.difficulty) < 1e-6);
  // The next rating is scheduled with them.
  const now = Date.now();
  const third = randomUUID();
  const memory = { ...expected };
  const rated = await command(owner, { action: "study.review", pageId, rowId, sub: "", rating: 3, id: third, zone, reviewedAt: now });
  assert.ok(rated);
  const log = await one<{ stability: number }>("SELECT stability FROM review_log WHERE id=?", third);
  const withWeights = schedule(memory, 3, now, { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500, weights: fit.weights }, { zone }, third);
  // (The stored state is the optimiser's fold, ts-fsrs rounds each step to 8 decimals.)
  assert.ok(Math.abs(Number(log!.stability) / withWeights.memory.stability - 1) < 1e-6, `${log!.stability} vs ${withWeights.memory.stability}`);
  assert.ok(Math.abs(withWeights.memory.stability - schedule(memory, 3, now, { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 }, { zone }, third).memory.stability) > 1);
  // The offline deck carries them (lib/study-offline.ts schedules with deck.params).
  const offline: any = await studyOffline(owner, { pageId, zone });
  assert.deepEqual(offline.params.weights, fit.weights);
  assert.equal(offline.model.source, "deck");
  // The statistics name them.
  const stats = await command(owner, { action: "study.stats", pageId, zone });
  assert.equal((stats as any).model.source, "deck");
  assert.equal((stats as any).model.reviews, data.reviews);
  // Another person keeps the defaults.
  assert.equal((await overview(reader, pageId)).params.weights, undefined);
  // Reset: the defaults again, the card's state with them.
  const reset = await params(owner, { pageId, weights: null });
  assert.equal(reset.model.source, "default");
  assert.equal(reset.params.weights, undefined);
  assert.equal((await one<{ params: string | null }>("SELECT params FROM study_prefs WHERE user_id=? AND page_id=?", owner.id, pageId))?.params, null);
  const back = await one<{ stability: number }>("SELECT stability FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId);
  const defaults = replay(
    (await all<{ id: string; rating: number; reviewed_at: number; zone: string }>("SELECT id,rating,reviewed_at,zone FROM review_log WHERE user_id=? AND row_id=? AND undone_at IS NULL", owner.id, rowId)).map((r) => ({
      id: r.id,
      rating: Number(r.rating) as 3,
      reviewedAt: Number(r.reviewed_at),
      zone: r.zone,
    })),
    { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 },
  )!;
  assert.ok(Math.abs(Number(back!.stability) / defaults.stability - 1) < 1e-6, `${back!.stability} vs ${defaults.stability}`);
});

test("study.params: weights for all decks, a deck's own come first; bounds and validation", async () => {
  const a = await deck("A"),
    b = await deck("B");
  const all1 = TRUE_WEIGHTS.map((w) => w * 1.01);
  const own = TRUE_WEIGHTS.map((w) => w * 0.99);
  await params(owner, { pageId: a, scope: "all", weights: all1 });
  assert.equal((await overview(owner, a)).model.source, "all");
  assert.deepEqual((await overview(owner, b)).params.weights, clampWeights(all1));
  await params(owner, { pageId: b, weights: own });
  assert.equal((await overview(owner, b)).model.source, "deck");
  assert.deepEqual((await overview(owner, b)).params.weights, clampWeights(own));
  assert.equal((await overview(owner, a)).model.source, "all");
  // The history's "current" per scope.
  assert.deepEqual((await history(owner, b)).current, clampWeights(own));
  assert.deepEqual((await history(owner, b, "all")).current, clampWeights(all1));
  // Out of bounds: clamped; not 21 numbers: refused.
  const wild = await params(owner, { pageId: b, weights: DEFAULT_WEIGHTS.map((w, i) => (i === 4 ? 99 : i === 20 ? -1 : w)) });
  assert.equal(wild.params.weights[4], 10);
  assert.equal(wild.params.weights[20], 0.1);
  await assert.rejects(params(owner, { pageId: b, weights: DEFAULT_WEIGHTS.slice(0, 20) }));
  await assert.rejects(params(owner, { pageId: b, weights: [...DEFAULT_WEIGHTS.slice(0, 20), Number.NaN] }));
  // Resetting the deck's own: the ones for all decks again; resetting those: the defaults.
  await params(owner, { pageId: b, weights: null });
  assert.equal((await overview(owner, b)).model.source, "all");
  await params(owner, { pageId: b, scope: "all", weights: null });
  assert.equal((await overview(owner, b)).model.source, "default");
  assert.equal((await overview(owner, a)).model.source, "default");
});

test("the note to optimise again: 1000 new ratings, or a month and some", async () => {
  const pageId = await deck("Latein");
  await seedLog(owner, pageId, syntheticLog(TRUE_WEIGHTS, 120, 31));
  await params(owner, { pageId, weights: [...TRUE_WEIGHTS] });
  assert.equal((await overview(owner, pageId)).optimizer.suggest, null);
  // (The synthetic log runs into the future: only its past stays.)
  await run("DELETE FROM review_log WHERE user_id=? AND page_id=? AND reviewed_at>?", owner.id, pageId, Date.now() - 40 * 86_400_000);
  // A month ago, and 200 ratings since.
  await run("UPDATE study_prefs SET params_at=? WHERE user_id=? AND page_id=?", Date.now() - 31 * 86_400_000, owner.id, pageId);
  const today = new Date().toISOString().slice(0, 10);
  await seedLog(owner, pageId, Array.from({ length: 100 }, () => ({ t: [0, 0], r: [3, 3] })), "web", addDays(today, -10));
  const note = (await overview(owner, pageId)).optimizer;
  assert.equal(note.since, 200);
  assert.equal(note.suggest, "again");
  // Just optimised, 200 since: no note.
  await run("UPDATE study_prefs SET params_at=? WHERE user_id=? AND page_id=?", Date.now() - 20 * 86_400_000, owner.id, pageId);
  assert.equal((await overview(owner, pageId)).optimizer.suggest, null);
  // The model of the memory states is the optimiser's (sanity of the import).
  assert.ok(memoryOf({ t: [0, 3], r: [3, 3] }, TRUE_WEIGHTS)!.stability > TRUE_WEIGHTS[2]);
});

// #344: weights per sub-deck (the mapping's `subdeck` select) and per
// card type, and the optimiser on the server (study.optimize) with the
// workload curve.
test("parts of a deck: weights per sub-deck, the optimiser on the server, the workload", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Teile" })).id as string;
  const db = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: db.version,
    fields: [
      { id: "title", name: "Vorderseite", type: "text" },
      { id: "back", name: "Rückseite", type: "text" },
      { id: "deck", name: "Deck", type: "select", options: ["A", "B"] },
      { id: "note", name: "Notiz", type: "text" },
    ],
    views: [{ id: "study", name: "Lernen", type: "study", filters: [], sorts: [] }],
  });
  await assert.rejects(
    act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, subdeck: { field: "note" } } }),
    /Auswahl-Eigenschaft/,
  );
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" }, subdeck: { field: "deck" } } });
  const inA: string[] = [];
  for (let i = 0; i < 130; i++) inA.push((await act({ action: "row.create", pageId, cells: { title: `a${i}`, back: `A${i}`, deck: "A" } })).id);
  const inB = (await act({ action: "row.create", pageId, cells: { title: "b", back: "B", deck: "B" } })).id as string;
  const log = syntheticLog(TRUE_WEIGHTS, 130, 31, 10);
  // Their logs start in the past and leave every card due some day.
  const reviews = await seedLog(owner, pageId, log, "web", "2025-03-03", inA);
  await seedLog(owner, pageId, syntheticLog(TRUE_WEIGHTS, 1, 32), "web", "2025-03-03", [inB]);
  for (const [i, c] of log.entries()) {
    await run(
      "INSERT INTO card_states(user_id,workspace_id,page_id,row_id,sub,state,step,due,due_day,stability,difficulty,reps,lapses,last_review,suspended,updated_at) VALUES(?,?,?,?,?,2,0,?,?,?,?,?,0,?,0,?)",
      owner.id,
      wid,
      pageId,
      inA[i],
      "",
      Date.now() - 86_400_000,
      addDays(new Date().toISOString().slice(0, 10), -1),
      4,
      5,
      c.r.length,
      Date.now() - 5 * 86_400_000,
      Date.now(),
    );
  }

  const h = await history(owner, pageId);
  assert.deepEqual(
    h.groups.map((g: { key: string; cards: number }) => [g.key, g.cards]),
    [
      ["subdeck:A", 130],
      ["subdeck:B", 1],
    ],
    "sub-decks only: every card is basic",
  );
  assert.equal(h.deck.cards.length, 130, "the cards with a memory for the workload");
  assert.equal(h.deck.newCards, 1);
  assert.equal(h.deck.newPerDay, 20);
  const partA: any = await command(owner, { action: "study.history", pageId, group: "subdeck:A", zone });
  assert.equal(partA.reviews, reviews);
  assert.equal(partA.group, "subdeck:A");
  assert.equal((await command(owner, { action: "study.history", pageId, group: "subdeck:B", zone }) as any).cards.length, 0, "too few");
  await assert.rejects(command(owner, { action: "study.history", pageId, group: "subdeck:C", zone }), /Teil des Stapels/);

  // On the server: the same optimiser, a result without storing it …
  const dry: any = await command(owner, { action: "study.optimize", pageId, group: "subdeck:A", zone, minutesPerDay: 15 });
  assert.equal(dry.applied, false);
  assert.equal(dry.weights.length, 21);
  assert.deepEqual(dry.weights, optimize(partA.cards).weights, "the browser's optimiser, the same result");
  assert.ok(dry.better);
  assert.equal(dry.retention.curve.length, 26);
  assert.equal(dry.retention.minutesPerDay, 15);
  assert.ok(dry.retention.curve.every((p: { minutesPerDay: number }) => p.minutesPerDay <= 15.5));
  assert.ok(dry.retention.recommended >= 0.7 && dry.retention.recommended <= 0.95);
  assert.equal((await one<{ group_params: string | null }>("SELECT group_params FROM study_prefs WHERE user_id=? AND page_id=?", owner.id, pageId))?.group_params ?? null, null);
  // … and stored for the sub-deck.
  const applied: any = await command(owner, { action: "study.optimize", pageId, group: "subdeck:A", zone, apply: true });
  assert.equal(applied.applied, true);
  const stored = JSON.parse((await one<{ group_params: string }>("SELECT group_params FROM study_prefs WHERE user_id=? AND page_id=?", owner.id, pageId))!.group_params);
  assert.deepEqual(Object.keys(stored), ["subdeck:A"]);
  assert.deepEqual(stored["subdeck:A"].w, applied.weights);
  const after = await overview(owner, pageId);
  assert.equal(after.model.groups, 1);
  assert.equal(after.model.source, "default", "the deck itself keeps FSRS-6's defaults");
  // The cards of A carry their weights (the buttons, the offline copy); B's do not.
  const queue: any = await command(owner, { action: "study.queue", pageId, zone, limit: 50 });
  const shownA = queue.cards.find((c: { rowId: string }) => inA.includes(c.rowId));
  assert.deepEqual(shownA.weights, applied.weights);
  assert.equal(shownA.group, "subdeck:A");
  const offline: any = await command(owner, { action: "study.queue", pageId, zone, limit: 0 });
  assert.equal(offline.params.weights, undefined);
  // A rating of a card in A is scheduled with A's weights.
  const rowId = shownA.rowId as string;
  const id = randomUUID();
  const reviewedAt = Date.now() - 1000;
  await run("UPDATE card_states SET stability=5,difficulty=5 WHERE user_id=? AND row_id=?", owner.id, rowId);
  const row = (await one<any>("SELECT * FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId))!;
  const before = { state: 2 as const, step: 0, due: Number(row.due), dueDay: row.due_day, stability: Number(row.stability), difficulty: Number(row.difficulty), reps: Number(row.reps), lapses: 0, lastReview: Number(row.last_review) };
  const settingsOf = { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 };
  const withA = schedule(before, 3, reviewedAt, { ...settingsOf, weights: applied.weights }, { zone, dayStart: 4 }, id).memory.stability;
  const withDefaults = schedule(before, 3, reviewedAt, settingsOf, { zone, dayStart: 4 }, id).memory.stability;
  assert.notEqual(withA, withDefaults);
  await command(owner, { action: "study.review", pageId, rowId, sub: "", rating: 3, id, zone, reviewedAt });
  const state = await one<{ stability: number }>("SELECT stability FROM card_states WHERE user_id=? AND row_id=?", owner.id, rowId);
  assert.ok(Math.abs(Number(state!.stability) - withA) < 1e-6, `${state!.stability} ≈ ${withA}`);
  // Through MCP: fitting with a read token, storing (here: the reset of
  // the part, back to the deck's weights) with a write token.
  const { handleMcpMessage } = await import("../lib/mcp");
  const { identityFromApiToken } = await import("../lib/api-tokens");
  const tokenFor = async (scope: "read" | "write") =>
    (await identityFromApiToken(`Bearer ${((await command(owner, { action: "token.create", name: `MCP ${scope}`, scope })) as { token: string }).token}`))!;
  const tool = async (who: Identity, name: string, args: Record<string, unknown>) => {
    const answer = (await handleMcpMessage(who, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as unknown as { result: { content: { text: string }[]; isError?: boolean } };
    return { error: !!answer.result.isError, text: answer.result.content[0].text };
  };
  const readToken = await tokenFor("read"),
    writeToken = await tokenFor("write");
  const fitted = await tool(readToken, "optimize_flashcard_parameters", { pageId, group: "subdeck:A", timeZone: zone });
  assert.equal(fitted.error, false, fitted.text);
  assert.equal(JSON.parse(fitted.text).weights.length, 21);
  assert.equal(JSON.parse(fitted.text).applied, false, "nothing stored");
  assert.equal((await tool(readToken, "set_flashcard_parameters", { pageId, group: "subdeck:A", weights: null })).error, true, "storing needs a write token");
  const reset = await tool(writeToken, "set_flashcard_parameters", { pageId, group: "subdeck:A", weights: null, timeZone: zone });
  assert.equal(reset.error, false, reset.text);
  assert.equal((await overview(owner, pageId)).model.groups, 0);
  // Too few ratings on the server: refused with the count.
  await assert.rejects(command(owner, { action: "study.optimize", pageId, group: "subdeck:B", zone }), /mindestens 1000 Wertungen/);
  // Nobody else's weights change.
  assert.equal((await all("SELECT 1 FROM study_prefs WHERE user_id=? AND group_params IS NOT NULL", reader.id)).length, 0);
});
