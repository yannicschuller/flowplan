import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-review-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { processPageReviews } = await import("../lib/page-review");
const { englishMessage } = await import("../lib/i18n-errors");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  stranger = await user("stranger");
const wid = await createWorkspace(owner.id, "Reviews");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: (await bootstrap(owner, wid)).spaces[0].id, title: "Handbuch" })).id as string;
const page = async () =>
  (await one<{ owner_id: string | null; review_at: string | null; review_every_days: number | null }>(
    "SELECT owner_id,review_at,review_every_days FROM pages WHERE id=?",
    pageId,
  ))!;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("owners are members who can read the page; editors set them", async () => {
  await assert.rejects(async () => await act({ action: "page.owner", pageId, ownerId: editor.id }, viewer), /Berechtigung/);
  await assert.rejects(async () => await act({ action: "page.owner", pageId, ownerId: stranger.id }), /Mitglied/);
  await act({ action: "page.owner", pageId, ownerId: editor.id }, editor);
  assert.equal((await page()).owner_id, editor.id);
  await act({ action: "page.owner", pageId, ownerId: null });
  assert.equal((await page()).owner_id, null);
  await act({ action: "page.owner", pageId, ownerId: editor.id });
});

test("review dates: an interval starts today, reviewed moves it on, a one-off date is cleared", async () => {
  await act({ action: "page.review", pageId, everyDays: 90 });
  assert.deepEqual(await page(), { owner_id: editor.id, review_at: day(90), review_every_days: 90 });
  await act({ action: "page.review", pageId, reviewAt: "2020-01-01" });
  assert.equal((await page()).review_every_days, 90);
  await assert.rejects(async () => await act({ action: "page.review", pageId, reviewAt: "2020-02-31" }));
  // Bootstrap lists it for the owner only.
  assert.deepEqual((await bootstrap(editor, wid)).reviewsDue.map((r: { pageId: string }) => r.pageId), [pageId]);
  assert.deepEqual((await bootstrap(owner, wid)).reviewsDue, []);
  await act({ action: "page.review", pageId, done: true }, editor);
  assert.equal((await page()).review_at, day(90));
  await act({ action: "page.review", pageId, reviewAt: "2020-01-01", everyDays: null });
  await act({ action: "page.review", pageId, done: true });
  assert.equal((await page()).review_at, null);
  await assert.rejects(async () => await act({ action: "page.review", pageId, done: true }), /keine Prüfung/);
});

test("owners are reminded once per due date", async () => {
  await act({ action: "page.review", pageId, reviewAt: day(-1), everyDays: 30 });
  assert.equal(await processPageReviews(), 1);
  assert.equal(await processPageReviews(), 0);
  const notes = await all<{ body: string; kind: string; page_id: string }>("SELECT body,kind,page_id FROM notifications WHERE user_id=?", editor.id);
  assert.deepEqual(notes, [{ body: "„Handbuch“ wartet auf deine Prüfung", kind: "reminder", page_id: pageId }]);
  assert.equal(englishMessage(notes[0].body), "“Handbuch” is waiting for your review");
  // A new due date reminds again; a future one does not.
  await act({ action: "page.review", pageId, reviewAt: day(0) });
  assert.equal(await processPageReviews(), 1);
  await act({ action: "page.review", pageId, reviewAt: day(5) });
  assert.equal(await processPageReviews(), 0);
});
