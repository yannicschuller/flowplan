// Flashcards phase 5, the domain (docs/specs/flashcards.md §10): the study
// reminder (pure rules and the worker: due, studied today, once a day, the
// pause after 30 days, push only without the inbox), the app's summary and
// widget "Karten fällig", the deck for the offline copy, ratings sent later
// (study.reviews: idempotent, the log wins, the clock, orphaned cards), the
// decks the offline copy keeps and what works offline. Runs on SQLite and
// PostgreSQL (test:db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-study5-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { studyOffline } = await import("../lib/study");
const { studyDueEverywhere } = await import("../lib/study-stats");
const { reminderStep, reminderText, processStudyReminders, PAUSED_TEXT } = await import("../lib/study-reminders");
const { studyDay, studyDayStart, reminderMoment } = await import("../lib/study-day");
const { mobileSummary } = await import("../lib/mobile-devices");
const W = await import("../lib/mobile-widgets");
const { offlineChanges } = await import("../lib/offline-changes");
const { localQueue, reviewBatches } = await import("../lib/study-offline");
const { needsServer, needsServerRequest } = await import("../lib/offline-actions");
const { notificationUrl } = await import("../lib/page-location");
const { englishMessage } = await import("../lib/i18n-errors");
const { replay } = await import("../lib/fsrs");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const reader = await user("reader");
const wid = await createWorkspace(owner.id, "Lernen 5"),
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
      { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] },
    ],
    views: [
      { id: "study", name: "Lernen", type: "study", filters: [], sorts: [] },
      { id: "onlyA", name: "Nur A", type: "study", filters: [{ field: "tags", op: "contains", value: "A" }], sorts: [] },
    ],
  });
  await act({ action: "study.settings", pageId, settings: { version: 1, front: { field: "title" }, back: { field: "back" } } });
  return pageId;
}
const card = async (pageId: string, front: string, back: string, extra: Record<string, unknown> = {}) =>
  (await act({ action: "row.create", pageId, cells: { title: front, back, ...extra } })).id as string;
const rate = async (who: Identity, pageId: string, rowId: string, rating: number, more: Record<string, unknown> = {}) =>
  (await command(who, { action: "study.review", pageId, rowId, sub: "", rating, id: randomUUID(), zone, ...more })) as any;
const reviews = async (who: Identity, list: Record<string, unknown>[]) => (await command(who, { action: "study.reviews", reviews: list })) as any;

// ---- The reminder ----

test("reminder rules: the time in the zone, once a day, the pause after 30 days", () => {
  const day = "2026-11-18";
  const at = reminderMoment(day, "18:00", zone);
  assert.equal(new Date(at).toISOString(), "2026-11-18T17:00:00.000Z");
  // Before the day's start (04:00): the next date, still the same study day.
  assert.equal(new Date(reminderMoment(day, "02:30", zone)).toISOString(), "2026-11-19T01:30:00.000Z");
  assert.equal(studyDay(reminderMoment(day, "02:30", zone), zone), day);
  const base = { zone, dayStart: 4, remindAt: "18:00", remindedDay: null, pausedAt: null, lastReview: at - 86_400_000, updatedAt: 0 };
  assert.equal(reminderStep({ ...base, now: at - 60_000 }).step, "wait");
  assert.deepEqual(reminderStep({ ...base, now: at + 60_000 }), { step: "check", day });
  assert.equal(reminderStep({ ...base, now: at + 60_000, remindedDay: day }).step, "wait");
  // 30 days without studying: one pause notice, then quiet.
  const old = { ...base, lastReview: at - 31 * 86_400_000 };
  assert.equal(reminderStep({ ...old, now: at + 60_000 }).step, "pause");
  assert.equal(reminderStep({ ...old, now: at + 60_000, pausedAt: at - 86_400_000 }).step, "paused");
  // Touching the setting counts as activity.
  assert.equal(reminderStep({ ...old, now: at + 60_000, updatedAt: at - 86_400_000 }).step, "check");
  assert.equal(reminderText([{ title: "Spanisch A1", due: 12 }]), "12 Karten warten auf dich – „Spanisch A1“.");
  assert.equal(reminderText([{ title: "B", due: 2 }, { title: "Spanisch A1", due: 10 }, { title: "C", due: 0 }]), "12 Karten warten auf dich – „Spanisch A1“ und ein weiterer Stapel.");
  assert.equal(reminderText([{ title: "A", due: 1 }]), "1 Karte wartet auf dich – „A“.");
  assert.equal(englishMessage("12 Karten warten auf dich – „Spanisch A1“ und 2 weitere Stapel."), "12 cards are waiting for you – “Spanisch A1” and 2 more decks.");
  assert.ok(englishMessage(PAUSED_TEXT).startsWith("Study reminders paused"));
  assert.equal(notificationUrl({ page_id: null, link: "#study", kind: "study" }), "/#study");
});

test("reminder worker: due cards, not studied today, push only, once per day", async () => {
  const pageId = await deck("Erinnern");
  await card(pageId, "uno", "eins");
  await card(pageId, "dos", "zwei");
  const set = await command(reader, { action: "study.reminder", remindAt: "18:00", zone });
  assert.deepEqual(set, { remindAt: "18:00", zone });
  await assert.rejects(command(reader, { action: "study.reminder", remindAt: "25:00", zone }));
  // Set long ago: no pause (studying is not needed for a first reminder).
  await run("UPDATE study_prefs SET updated_at=?,reminded_day=NULL WHERE user_id=? AND page_id=''", Date.now() - 86_400_000, reader.id);
  const day = studyDay(Date.now(), zone);
  const evening = reminderMoment(day, "18:00", zone) + 60_000;
  const before = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", reader.id))!.n);
  assert.equal(await processStudyReminders(reminderMoment(day, "18:00", zone) - 60_000), 0);
  assert.equal(await processStudyReminders(evening), 1);
  const sent = await one<{ body: string; kind: string; link: string; push_only: number | null; read_at: string | null }>(
    "SELECT body,kind,link,push_only,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC,seq DESC LIMIT 1",
    reader.id,
  );
  assert.equal(sent?.kind, "study");
  assert.equal(sent?.link, "#study");
  assert.equal(sent?.body, "2 Karten warten auf dich – „Erinnern“.");
  // Inbox off by default: kept for push only – not in the inbox or its count.
  assert.equal(Number(sent?.push_only), 1);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", reader.id))!.n), before + 1);
  assert.ok(!(await bootstrap(reader, wid)).notifications.some((n: any) => n.kind === "study"));
  assert.equal((await mobileSummary(reader)).unread, 0);
  // Once per study day.
  assert.equal(await processStudyReminders(evening + 10 * 60_000), 0);
  // Push stays on with the inbox off (the kind does without it).
  const prefs = (await command(reader, { action: "notification.prefs", kind: "study", inbox: false, push: true, email: false })) as any;
  assert.deepEqual({ inbox: prefs.study.inbox, push: prefs.study.push }, { inbox: false, push: true });
  // With the inbox on: an ordinary notification.
  await run("UPDATE study_prefs SET reminded_day=NULL WHERE user_id=? AND page_id=''", reader.id);
  await command(reader, { action: "notification.prefs", kind: "study", inbox: true, push: true });
  assert.equal(await processStudyReminders(evening), 1);
  assert.ok((await bootstrap(reader, wid)).notifications.some((n: any) => n.kind === "study"));
  // Every channel off: nothing is sent.
  await run("UPDATE study_prefs SET reminded_day=NULL WHERE user_id=? AND page_id=''", reader.id);
  await command(reader, { action: "notification.prefs", kind: "study", inbox: false, push: false, email: false });
  const count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", reader.id))!.n);
  assert.equal(await processStudyReminders(evening), 0);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", reader.id))!.n), count);
  await command(reader, { action: "notification.prefs", kind: "study", inbox: true, push: true });
  assert.equal((await one<{ push_only: number | null }>("SELECT push_only FROM notifications WHERE user_id=? AND kind='study' ORDER BY seq DESC LIMIT 1", reader.id))?.push_only ?? null, null);
  // Studied today: no reminder.
  await run("UPDATE study_prefs SET reminded_day=NULL WHERE user_id=? AND page_id=''", reader.id);
  const [first] = await all<{ row_id: string }>("SELECT row_id FROM study_cards WHERE page_id=? ORDER BY position LIMIT 1", pageId);
  await rate(reader, pageId, first.row_id, 3);
  assert.equal(await processStudyReminders(evening), 0);
  // Off: nothing.
  await command(reader, { action: "study.reminder", remindAt: null, zone });
  assert.equal((await one<{ remind_at: string | null }>("SELECT remind_at FROM study_prefs WHERE user_id=? AND page_id=''", reader.id))?.remind_at, null);
});

test("reminder pause: one notice after 30 days without studying, then quiet until a rating", async () => {
  const quiet = await user("quiet");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, quiet.id, "viewer");
  const pageId = await deck("Pause");
  const row = await card(pageId, "tres", "drei");
  await command(quiet, { action: "study.reminder", remindAt: "08:00", zone });
  const longAgo = Date.now() - 40 * 86_400_000;
  await run("UPDATE study_prefs SET updated_at=?,reminded_day=NULL WHERE user_id=? AND page_id=''", longAgo, quiet.id);
  const day = studyDay(Date.now(), zone);
  const morning = reminderMoment(day, "08:00", zone) + 60_000;
  assert.equal(await processStudyReminders(morning), 1);
  assert.equal((await one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? ORDER BY seq DESC LIMIT 1", quiet.id))?.body, PAUSED_TEXT);
  // The next day: nothing.
  const tomorrow = morning + 86_400_000;
  assert.equal(await processStudyReminders(tomorrow), 0);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", quiet.id))!.n), 1);
  // A rating starts the reminders again (the next study day).
  await rate(quiet, pageId, row, 3);
  await command(quiet, { action: "study.reminder", remindAt: "08:00", zone });
  await run("UPDATE study_prefs SET reminded_day=NULL WHERE user_id=? AND page_id=''", quiet.id);
  const later = reminderMoment(studyDay(tomorrow + 86_400_000, zone), "08:00", zone) + 60_000;
  // New cards of the workspace's other decks are due: an ordinary reminder,
  // no second pause notice.
  assert.equal(await processStudyReminders(later), 1);
  assert.match((await one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? ORDER BY seq DESC LIMIT 1", quiet.id))!.body, /Karten? warte/);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND body=?", quiet.id, PAUSED_TEXT))!.n), 1);
});

// ---- App: summary and widget ----

test("app summary and widget: due cards across workspaces, within 2 KB", async () => {
  const learner = await user("learner");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, learner.id, "viewer");
  // No decks of their own in a second workspace without any.
  const empty = await user("empty");
  const lonely = await createWorkspace(empty.id, "Leer");
  assert.equal((await mobileSummary(empty)).study, undefined);
  void lonely;
  const pageId = await deck("App-Stapel");
  for (let i = 0; i < 3; i++) await card(pageId, `Wort ${i}`, `Word ${i}`);
  const summary = await mobileSummary(learner, null, zone);
  assert.ok(summary.study);
  assert.ok(summary.study!.due >= 3);
  assert.ok(summary.study!.new >= 3);
  assert.equal(summary.study!.streak, 0);
  // Added after the kinds before it (later kinds follow it: lib/mobile-widget-schema.ts).
  assert.equal(W.widgetKinds.indexOf("study"), 13);
  const ctx = W.widgetContext(learner, undefined, zone);
  const data = (await W.widgetData(ctx, "study", {})) as any;
  assert.equal(data.url, "/#study");
  assert.equal(data.due, summary.study!.due);
  assert.ok(data.decks.some((d: any) => d.pageId === pageId && d.due === 3 && d.url.includes(pageId)));
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= W.MAX_WIDGET_BYTES);
  const chosen = (await W.widgetData(ctx, "study", { pageIds: [pageId] })) as any;
  assert.deepEqual(chosen.decks.map((d: any) => d.pageId), [pageId]);
  assert.equal(chosen.due, 3);
  await assert.rejects(W.widgetData(ctx, "study", { pageIds: ["nope"] }));
  const options = (await W.widgetOptions(learner, "study")) as any;
  assert.ok(options.decks.some((d: any) => d.id === pageId));
  // Rated: the streak counts and the summary follows.
  const [first] = await all<{ row_id: string }>("SELECT row_id FROM study_cards WHERE page_id=? ORDER BY position LIMIT 1", pageId);
  await rate(learner, pageId, first.row_id, 3);
  assert.equal((await mobileSummary(learner, null, zone)).study!.streak, 1);
  assert.equal((await studyDueEverywhere(learner, zone)).decks.find((d) => d.pageId === pageId)?.new, 2);
});

// ---- Offline ----

test("offline deck: every card with content and state, sub-decks, limits of another day", async () => {
  const pageId = await deck("Offline");
  const a = await card(pageId, "rojo", "rot", { tags: ["A"] });
  await card(pageId, "azul", "blau", { tags: ["B"] });
  await rate(owner, pageId, a, 3);
  const snapshot = (await studyOffline(owner, { pageId, zone })) as any;
  assert.equal(snapshot.offline, true);
  assert.equal(snapshot.userId, owner.id);
  assert.equal(snapshot.cards.length, 2);
  assert.ok(snapshot.cards.every((c: any) => c.front.text && c.back.text));
  assert.ok(snapshot.cards.find((c: any) => c.rowId === a).memory);
  assert.deepEqual(snapshot.studiedRows, [a]);
  assert.equal(snapshot.done.new, 1);
  assert.deepEqual(snapshot.views.onlyA.rows, [a]);
  assert.equal(snapshot.views.study.rows, undefined);
  assert.deepEqual(snapshot.baseLimits, { new: 20, review: 200 });
  // The same answer as GET …/study?offline=1 for the reader: only their state.
  const theirs = (await studyOffline(reader, { pageId, zone })) as any;
  assert.ok(theirs.cards.every((c: any) => c.memory === null));
  // Built on the device: a waiting rating counts, the other card is next.
  const now = Date.now();
  const b = snapshot.cards.find((c: any) => c.rowId !== a);
  const pending = [{ id: randomUUID(), userId: owner.id, pageId, rowId: b.rowId, sub: "", rating: 3 as const, reviewedAt: now, zone, baseReps: 0 }];
  const local = localQueue(snapshot, pending, { now, zone, limit: 50 });
  assert.equal(local.done.new, 2);
  assert.equal(local.pending, 1);
  assert.ok(local.cards.every((c: any) => c.memory));
  assert.equal(localQueue(snapshot, [], { now, zone, limit: 50, viewId: "onlyA" }).total, 1);
  // Another person's waiting ratings do not count.
  assert.equal(localQueue(snapshot, pending.map((p) => ({ ...p, userId: reader.id })), { now, zone, limit: 50 }).done.new, 1);
  // A new study day starts from zero with the limits of any day.
  const nextDay = studyDayStart(studyDay(now, zone), zone) + 86_400_000 + 3_600_000;
  const tomorrow = localQueue(snapshot, [], { now: nextDay, zone, limit: 50 });
  assert.deepEqual(tomorrow.done, { new: 0, review: 0, all: 0 });
  assert.deepEqual(tomorrow.limits, snapshot.baseLimits);
  assert.equal(reviewBatches(Array.from({ length: 1201 }, (_, i) => ({ ...pending[0], id: randomUUID(), reviewedAt: now + i })), owner.id).map((b) => b.length).join(), "500,500,201");
});

test("study.reviews: idempotent, the log wins, the clock, orphaned cards", async () => {
  const pageId = await deck("Nachspielen");
  const row = await card(pageId, "verde", "grün");
  const gone = await card(pageId, "negro", "schwarz");
  const now = Date.now();
  const late = { id: randomUUID(), pageId, rowId: row, sub: "", rating: 3, reviewedAt: now - 2 * 3_600_000, zone };
  // Online first (another device), then the offline rating made before it.
  await rate(owner, pageId, row, 1, { reviewedAt: now - 3_600_000 });
  const first = await reviews(owner, [late]);
  assert.deepEqual(first.results, [{ id: late.id, status: "replayed" }]);
  assert.deepEqual(first.decks, [pageId]);
  const log = await all<{ id: string; rating: number; reviewed_at: number; zone: string }>("SELECT id,rating,reviewed_at,zone FROM review_log WHERE user_id=? AND row_id=? AND undone_at IS NULL", owner.id, row);
  assert.equal(log.length, 2);
  const state = await one<{ reps: number; last_review: number; stability: number }>("SELECT reps,last_review,stability FROM card_states WHERE user_id=? AND row_id=?", owner.id, row);
  assert.equal(Number(state?.reps), 2);
  // The state is the fold of the log, in the order of time.
  const params = { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], maxInterval: 36500 };
  const folded = replay(log.map((l) => ({ id: l.id, rating: Number(l.rating) as 1 | 2 | 3 | 4, reviewedAt: Number(l.reviewed_at), zone: l.zone })), params);
  assert.equal(Number(state?.stability), folded?.stability);
  assert.equal(Number(state?.last_review), now - 3_600_000);
  // Sent again (no answer reached the device): skipped, as often as it comes.
  assert.deepEqual((await reviews(owner, [late])).results, [{ id: late.id, status: "duplicate" }]);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM review_log WHERE id=?", late.id))!.n), 1);
  // Someone else's id: refused for them.
  assert.deepEqual((await reviews(reader, [late])).results, [{ id: late.id, status: "conflict" }]);
  // The device's clock: not in the future; older than 30 days: "offline".
  const future = { id: randomUUID(), pageId, rowId: row, sub: "", rating: 3, reviewedAt: now + 86_400_000, zone };
  const ancient = { id: randomUUID(), pageId, rowId: gone, sub: "", rating: 3, reviewedAt: now - 40 * 86_400_000, zone };
  const answer = await reviews(owner, [future, ancient]);
  assert.deepEqual(answer.results.map((r: any) => r.status), ["ok", "ok"]);
  const kept = await one<{ reviewed_at: number }>("SELECT reviewed_at FROM review_log WHERE id=?", future.id);
  assert.ok(Number(kept?.reviewed_at) <= Date.now() + 5 * 60_000);
  assert.equal((await one<{ source: string }>("SELECT source FROM review_log WHERE id=?", ancient.id))?.source, "offline");
  assert.equal((await one<{ source: string }>("SELECT source FROM review_log WHERE id=?", future.id))?.source, "web");
  // A card that is gone: logged for the statistics, the state left alone.
  await act({ action: "row.delete", pageId, rowId: gone });
  const before = await one<{ reps: number }>("SELECT reps FROM card_states WHERE user_id=? AND row_id=?", owner.id, gone);
  const orphan = { id: randomUUID(), pageId, rowId: gone, sub: "", rating: 4, reviewedAt: now, zone };
  assert.deepEqual((await reviews(owner, [orphan])).results, [{ id: orphan.id, status: "orphaned" }]);
  assert.ok(await one("SELECT 1 FROM review_log WHERE id=?", orphan.id));
  assert.equal(Number((await one<{ reps: number }>("SELECT reps FROM card_states WHERE user_id=? AND row_id=?", owner.id, gone))?.reps), Number(before?.reps));
  // A deck that does not exist: nothing kept.
  const nowhere = { id: randomUUID(), pageId: randomUUID(), rowId: randomUUID(), sub: "", rating: 3, reviewedAt: now, zone };
  assert.deepEqual((await reviews(owner, [nowhere])).results, [{ id: nowhere.id, status: "orphaned" }]);
  assert.equal(await one("SELECT 1 FROM review_log WHERE id=?", nowhere.id), undefined);
  // At most 500 at a time.
  await assert.rejects(reviews(owner, Array.from({ length: 501 }, () => ({ ...late, id: randomUUID() }))));
  // The ratings of the batch count today like online ones (an undo works).
  const undo = (await command(owner, { action: "study.undo", pageId, reviewId: future.id, zone })) as any;
  assert.equal(undo.undone, future.id);
});

test("offline copy: decks studied in the last 14 days; what needs the server", async () => {
  const pageId = await deck("Kopie");
  const row = await card(pageId, "blanco", "weiß");
  assert.ok(!(await offlineChanges(owner, wid, null)).study.includes(pageId));
  await rate(owner, pageId, row, 3);
  assert.ok((await offlineChanges(owner, wid, null)).study.includes(pageId));
  assert.ok((await offlineChanges(owner, wid, Date.now() - 1000)).study.includes(pageId));
  // Only the person's own ratings choose.
  assert.ok(!(await offlineChanges(reader, wid, null)).study.includes(pageId));
  await run("UPDATE review_log SET reviewed_at=? WHERE user_id=? AND page_id=?", Date.now() - 15 * 86_400_000, owner.id, pageId);
  assert.ok(!(await offlineChanges(owner, wid, null)).study.includes(pageId));
  // Ratings are no command that needs the server; AI cards, Anki and the export are.
  for (const action of ["study.review", "study.reviews", "study.queue"]) assert.equal(needsServer({ action }), false, action);
  assert.ok(needsServerRequest("/api/ai/flashcards/propose"));
  assert.ok(needsServerRequest("/api/ai/flashcards/add"));
  assert.ok(needsServerRequest("/api/import/source?source=anki"));
  assert.ok(needsServerRequest(`/api/pages/${pageId}/study/export?format=apkg`));
  assert.equal(needsServerRequest(`/api/pages/${pageId}/study?offline=1`), false);
});
