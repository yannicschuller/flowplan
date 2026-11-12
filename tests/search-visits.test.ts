// #243: the quick search ranks by the person's own visits (frecency), shows
// the path and last change of every hit and, with nothing typed, the
// recently visited pages and records grouped by day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-visits-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { searchWorkspace, recentlyVisited, refreshSearchIndex } = await import("../lib/search-index");
const { recordSearchVisit, pruneSearchVisits, frecency, ENTRIES_KEPT, RETENTION_DAYS, VISITS_KEPT } = await import("../lib/search-visits");
const { visitPage } = await import("../lib/page-activity");
const { groupByDay, hitPath } = await import("../lib/search-palette");
const { refreshSearchStats } = await import("../lib/search-store");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("visits-owner"),
  member = await account("visits-member");
const wid = await createWorkspace(owner.id, "Besuche");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const team = (await bootstrap(owner, wid)).spaces[0];
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as { id: string };
const page = async (title: string, html = "", parentId?: string, spaceId = team.id) => {
  const pid = (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind: "document", ...(parentId ? { parentId } : {}) })).id;
  if (html) await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pid, html);
  return pid;
};
const filler = (n: number) => Array.from({ length: n }, (_, i) => `wort${i}`).join(" ");
const DAY = 86_400_000;
const now = Date.now();
// `n` visits, one per hour back from now.
const visit = async (user: Identity, pageId: string, n: number, rowId = "") => {
  for (let i = n - 1; i >= 0; i--) await recordSearchVisit(user, pageId, rowId, now - i * 3_600_000);
};

// Similar matches: "Abstimmung" in the title of both; the first mentions it
// more often in its text, so the text alone puts it first.
const often = await page("Abstimmung Vertrieb", `<p>Abstimmung zum Angebot. ${filler(20)}</p>`);
const rare = await page("Abstimmung Einkauf", `<p>Abstimmung, Abstimmung und noch eine Abstimmung. ${filler(20)}</p>`);
const exact = await page("Abstimmung", `<p>${filler(20)}</p>`);
const body = await page("Protokoll", `<p>Abstimmung Abstimmung Abstimmung ${filler(5)}</p>`);
const parent = await page("Projekte");
const child = await page("Planung", "", parent);
const privateSpace = (await act({ action: "space.create", workspaceId: wid, name: "Privat", private: true })).id;
const secret = await page("Geheime Abstimmung", "<p>Abstimmung</p>", undefined, privateSpace);
const db = await act({ action: "page.create", workspaceId: wid, spaceId: team.id, title: "Termine", kind: "database", parentId: parent });
await command(owner, {
  action: "database.update",
  pageId: db.id,
  version: (await database(db.id)).version,
  fields: [{ id: "title", name: "Name", type: "text" }],
  views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
});
const record = (await act({ action: "row.create", pageId: db.id, cells: { title: "Abstimmung Marketing" } })).id;
await refreshSearchIndex();
await refreshSearchStats(true);
const titles = async (q: string, as: Identity, options = {}) => (await searchWorkspace(as, wid, q, options)).map((h) => h.title);

test("without visits: exact title, then title prefixes, text-only hits last", async () => {
  const order = await titles("abstimmung", member);
  assert.equal(order[0], "Abstimmung");
  assert.ok(order.indexOf("Abstimmung Einkauf") < order.indexOf("Abstimmung Vertrieb"), order.join(" | "));
  assert.equal(order[order.length - 1], "Protokoll");
  assert.ok(!order.includes("Geheime Abstimmung"), "a private page of someone else stays out");
});

test("a page I open often ranks above a rarely opened one with a similar match", async () => {
  await visit(member, often, 8);
  await visit(member, rare, 1);
  // A month ago weighs little.
  await recordSearchVisit(member, rare, "", now - 30 * DAY);
  const order = await titles("abstimmung", member);
  assert.ok(order.indexOf("Abstimmung Vertrieb") < order.indexOf("Abstimmung Einkauf"), order.join(" | "));
  // The exact title without visits stays near the top (first two).
  assert.ok(order.indexOf("Abstimmung") <= 1, order.join(" | "));
});

test("a text-only hit never passes title matches, however often visited", async () => {
  await visit(member, body, VISITS_KEPT);
  const order = await titles("abstimmung", member);
  assert.equal(order[order.length - 1], "Protokoll", order.join(" | "));
});

test("visits are per person: someone else's ranking does not change, nor can they read them", async () => {
  const order = await titles("abstimmung", owner);
  assert.equal(order[0], "Abstimmung");
  assert.ok(order.indexOf("Abstimmung Einkauf") < order.indexOf("Abstimmung Vertrieb"), order.join(" | "));
  const ownerRecent = await recentlyVisited(owner, wid);
  assert.ok(!ownerRecent.some((r) => [often, rare, body].includes(r.id)), "the member's visits are not the owner's");
  // Only the person's own rows are ever read.
  const stored = await all<{ user_id: string }>("SELECT DISTINCT user_id FROM search_visits");
  assert.deepEqual(stored.map((s) => s.user_id), [member.id]);
});

test("records count: an opened record rises and is listed as visited", async () => {
  const before = await titles("abstimmung", member);
  await visit(member, db.id, 6, record);
  const after = await titles("abstimmung", member);
  assert.ok(after.indexOf("Abstimmung Marketing") < before.indexOf("Abstimmung Marketing"), `${before.join(" | ")} → ${after.join(" | ")}`);
  const recent = await recentlyVisited(member, wid);
  const hit = recent.find((r) => r.rowId === record);
  assert.ok(hit);
  assert.equal(hit.title, "Abstimmung Marketing");
  assert.equal(hit.pageTitle, "Termine");
  assert.equal(hit.kind, "row");
  assert.ok(hit.updatedAt && !Number.isNaN(Date.parse(hit.updatedAt)));
});

test("hits carry their last change", async () => {
  const hits = await searchWorkspace(member, wid, "abstimmung");
  assert.ok(hits.every((h) => h.updatedAt && !Number.isNaN(Date.parse(h.updatedAt))));
  assert.equal(hits.find((h) => h.rowId === record)?.updatedAt?.slice(0, 10), new Date().toISOString().slice(0, 10));
});

test("sorting by last change or creation", async () => {
  await run("UPDATE pages SET updated_at='2020-01-01 00:00:00' WHERE id=?", exact);
  const edited = await titles("abstimmung", member, { sort: "edited" });
  assert.equal(edited[edited.length - 1], "Abstimmung");
  const created = await titles("abstimmung", member, { sort: "created" });
  assert.equal(created.length, edited.length);
});

test("recently visited: newest first, only readable pages, not through API tokens", async () => {
  // A visit of a page the person cannot read (any more) is not listed.
  await recordSearchVisit(member, secret, "", now);
  await recordSearchVisit(member, child, "", now + 60_000);
  const recent = await recentlyVisited(member, wid);
  assert.equal(recent[0].id, child);
  assert.ok(!recent.some((r) => r.id === secret));
  for (let i = 1; i < recent.length; i++) assert.ok(recent[i - 1].visitedAt >= recent[i].visitedAt);
  assert.ok((await recentlyVisited(member, wid, { kind: "row" })).every((r) => r.kind === "row"));
  // Integrations do not leave visits.
  const token = { ...member, apiScope: "read" } as Identity;
  await recordSearchVisit(token, exact, "", now + 120_000);
  assert.notEqual((await recentlyVisited(member, wid))[0].id, exact);
});

test("opening a page records it (and the same minute only once)", async () => {
  const pageRow = (await one<Page>("SELECT * FROM pages WHERE id=?", parent))!;
  await visitPage(member, pageRow, "");
  await visitPage(member, pageRow, "");
  const stored = await one<{ visits: string }>("SELECT visits FROM search_visits WHERE user_id=? AND page_id=? AND row_id=''", member.id, parent);
  assert.equal(stored?.visits.split(",").length, 1);
  // At most VISITS_KEPT times per entry.
  await visit(member, parent, VISITS_KEPT + 5);
  const kept = await one<{ visits: string }>("SELECT visits FROM search_visits WHERE user_id=? AND page_id=?", member.id, parent);
  assert.equal(kept?.visits.split(",").length, VISITS_KEPT);
});

test("frecency: recent and frequent count more", () => {
  const minute = (ms: number) => Math.floor(ms / 60_000);
  assert.ok(frecency([minute(now)], now) > frecency([minute(now - 30 * DAY)], now));
  assert.ok(frecency([minute(now), minute(now - DAY)], now) > frecency([minute(now)], now));
  assert.ok(frecency(Array.from({ length: 10 }, () => minute(now)), now) < 1);
});

test("retention: old visits go, at most ENTRIES_KEPT per person", async () => {
  const other = await account("visits-retention");
  await recordSearchVisit(other, often, "", now - (RETENTION_DAYS + 1) * DAY);
  await pruneSearchVisits(undefined, now);
  assert.equal(await one("SELECT 1 FROM search_visits WHERE user_id=?", other.id), undefined);
  for (let i = 0; i < ENTRIES_KEPT + 5; i++)
    await run("INSERT INTO search_visits(user_id,page_id,row_id,visits,last_at) VALUES(?,?,?,?,?)", other.id, often, `fake-${i}`, "1", now - i * 1000);
  await pruneSearchVisits(other.id, now);
  const left = Number((await one<{ n: number }>("SELECT count(*) n FROM search_visits WHERE user_id=?", other.id))?.n);
  assert.equal(left, ENTRIES_KEPT);
  // Records that are gone are dropped by the worker.
  await pruneSearchVisits(undefined, now);
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM search_visits WHERE user_id=?", other.id))?.n), 0);
});

test("leaving the workspace takes the visits along", async () => {
  const guest = await account("visits-leaver");
  await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
  await recordSearchVisit(guest, often);
  const { removeFromWorkspace } = await import("../lib/workspace-lifecycle");
  await removeFromWorkspace(guest.id, wid);
  assert.equal(await one("SELECT 1 FROM search_visits WHERE user_id=?", guest.id), undefined);
});

test("empty query: grouped by day (today, yesterday, then dates)", () => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const at = noon.getTime();
  const groups = groupByDay([{ visitedAt: at - 3 * DAY }, { visitedAt: at }, { visitedAt: at - DAY }, { visitedAt: at - 60_000 }], at);
  assert.deepEqual(groups.map((g) => g.label), ["today", "yesterday", "date"]);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 1, 1]);
  assert.ok(groups[0].items[0].visitedAt > groups[0].items[1].visitedAt);
});

test("path per hit: space, parents, a record's database; stops at what is not readable", () => {
  const p = (id: string, parent_id: string | null, title: string, kind = "document") => ({ id, parent_id, title, icon: "", kind });
  const spaces = [{ id: "s", name: "Team" }];
  const readable = [p("a", null, "A"), p("b", "a", "B"), p("c", "b", "C"), p("d", "c", "D"), p("db", "b", "Termine", "database")];
  assert.deepEqual(hitPath({ id: "b", space_id: "s" }, readable, spaces), ["Team", "A"]);
  assert.deepEqual(hitPath({ id: "db", rowId: "r", space_id: "s" }, readable, spaces), ["Team", "A", "B", "Termine"]);
  // Long paths are shortened in the middle.
  assert.deepEqual(hitPath({ id: "d", space_id: "s" }, readable, spaces, [], 4), ["Team", "A", "B", "C"]);
  assert.deepEqual(hitPath({ id: "d", space_id: "s" }, readable, spaces, [], 3), ["Team", "…", "C"]);
  // A parent the person may not read ends the path (no hidden titles).
  const withoutA = readable.filter((x) => x.id !== "a");
  assert.deepEqual(hitPath({ id: "c", space_id: "s" }, withoutA, spaces), ["Team", "B"]);
});
