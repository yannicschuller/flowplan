// The full-text search gives the same hits in the same order on SQLite (FTS5,
// trigram tokenizer, bm25) and on PostgreSQL (pg_trgm, BM25 in SQL,
// lib/search-store.ts): one corpus, one set of expectations, run on
// whichever database the test run uses (docs/architecture/database.md §5a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-parity-"));
const { run, id, one } = await import("../lib/db");
const { onPostgres } = await import("./helpers/backend");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { searchWorkspace, termMatches, refreshSearchIndex, MARK_START, MARK_END } = await import("../lib/search-index");
const { searchStoreInfo, refreshSearchStats } = await import("../lib/search-store");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Parity", "parity@example.test");
const me = { id: uid, name: "Parity", email: "parity@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(me.id, "Parität");
const space = (await bootstrap(me, wid)).spaces[0].id;
const pages = new Map<string, string>();
async function page(title: string, html: string) {
  const pid = ((await command(me, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "document" })) as { id: string }).id;
  await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pid, html);
  pages.set(pid, title);
  return pid;
}
const filler = (n: number) => Array.from({ length: n }, (_, i) => `wort${i}`).join(" ");

// German compounds, accents, case.
await page("Projektplanung Q3", "<p>Meilensteine und Budget.</p>");
await page("Notizen", `<p>Die Planung des Umzugs ist offen. ${filler(10)}</p>`);
await page("Übergabe", "<p>Übergänge im Team, Straße und Maße.</p>");
// Frequency and length: three hits beat one; the same hit in a shorter text first.
await page("Inventar", `<p>Kühlschrank hier, Kühlschrank da, noch ein Kühlschrank. ${filler(30)}</p>`);
await page("Küche", `<p>Ein Kühlschrank. ${filler(30)}</p>`);
await page("Keller", `<p>Ein Kühlschrank. ${filler(300)}</p>`);
// French, Chinese, Japanese.
await page("Réunion", "<p>L'élève présente le résumé du café.</p>");
await page("项目计划", "<p>我们的项目计划包括三个阶段，第二阶段是测试。</p>");
await page("会議", "<p>来週の会議の議事録を共有します。</p>");
// Several phrases: a rare one counts more than a common one.
for (let i = 0; i < 6; i++) await page(`Allerlei ${i}`, `<p>gemeinsam ${filler(5)}</p>`);
await page("Seltenes", `<p>einzigartig ${filler(5)}</p>`);
await refreshSearchIndex();
await refreshSearchStats(true);

const titles = async (q: string) => (await searchWorkspace(me, wid, q)).map((h) => h.title);

test("the store in use", async () => {
  const info = await searchStoreInfo();
  assert.equal(info.backend, onPostgres ? "postgres" : "sqlite");
  // With pg_trgm (on every standard PostgreSQL) the trigram indexes are there.
  if (onPostgres) assert.equal(info.trigram, !!(await one("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'")));
  assert.ok(info.entries >= pages.size);
});

test("parts of words, case and diacritics", async () => {
  // "plan" inside "Projektplanung" and "Planung": the title hit first.
  assert.deepEqual(await titles("planung"), ["Projektplanung Q3", "Notizen"]);
  assert.deepEqual(await titles("PROJEKTPLAN"), ["Projektplanung Q3"]);
  assert.deepEqual(await titles("ubergange"), ["Übergabe"]);
  assert.deepEqual(await titles("Uberga"), ["Übergabe"]);
  assert.deepEqual(await titles("strasse"), [], "ß is not ss (FTS5 does not fold it either)");
  assert.deepEqual(await titles("straße"), ["Übergabe"]);
  assert.deepEqual(await titles("eleve"), ["Réunion"]);
  assert.deepEqual(await titles("RÉSUMÉ"), ["Réunion"]);
});

test("Chinese and Japanese without spaces", async () => {
  assert.deepEqual(await titles("项目计划"), ["项目计划"]);
  assert.deepEqual(await titles("第二阶段"), ["项目计划"]);
  assert.deepEqual(await titles("议事录"), [], "simplified ≠ Japanese kanji");
  assert.deepEqual(await titles("議事録"), ["会議"]);
  // Two characters: the short scan (both databases alike).
  assert.deepEqual(await titles("会議"), ["会議"]);
  assert.deepEqual(await titles("测试"), ["项目计划"]);
});

test("BM25: title over text, frequency, length", async () => {
  assert.deepEqual(await titles("kühlschrank"), ["Inventar", "Küche", "Keller"]);
  assert.deepEqual(await titles("kuhlschrank"), ["Inventar", "Küche", "Keller"]);
});

test("snippets mark the hit in the original spelling", async () => {
  const [hit] = await searchWorkspace(me, wid, "ubergange");
  assert.ok(hit.snippet.includes(`${MARK_START}Übergänge${MARK_END}`), hit.snippet);
  const [far] = await searchWorkspace(me, wid, "wort299");
  assert.equal(far.title, "Keller");
  assert.ok(far.snippet.startsWith("…") && far.snippet.includes(`${MARK_START}wort299${MARK_END}`), far.snippet);
  const [cjk] = await searchWorkspace(me, wid, "第二阶段");
  assert.ok(cjk.snippet.includes(`${MARK_START}第二阶段${MARK_END}`), cjk.snippet);
});

test("several phrases: the rarer one weighs more (IDF)", async () => {
  // (The workspace's own example pages may use the words as well.)
  const hits = (await termMatches(wid, ["gemeinsam", "einzigartig"], { limit: 20 })).filter((h) => pages.has(h.page_id));
  assert.equal(hits.length, 7);
  assert.equal(pages.get(hits[0].page_id), "Seltenes");
  assert.ok(hits.slice(1).every((h) => pages.get(h.page_id)!.startsWith("Allerlei")));
});

test("title-only matches (duplicate titles, related pages)", async () => {
  const { textMatch } = await import("../lib/search-store");
  const match = textMatch(["planung", "notiz"], { titleOnly: true });
  const { all } = await import("../lib/db");
  const rows = await all<{ title: string }>(
    `SELECT s.title FROM search_index s JOIN pages p ON p.id=s.page_id WHERE ${match.where} AND p.workspace_id=? ORDER BY ${match.rank}`,
    ...match.whereArgs,
    wid,
    ...match.rankArgs,
  );
  assert.deepEqual(rows.map((r) => r.title).sort(), ["Notizen", "Projektplanung Q3"]);
});
