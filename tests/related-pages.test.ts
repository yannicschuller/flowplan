import { nowText } from "../lib/db-driver/dialect";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-related-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { relatedPages, similarTitles, titleSimilarity, normalizeTitle } = await import("../lib/related-pages");
const { processEmbeddings } = await import("../lib/ai/semantic");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben");
const wid = await createWorkspace(admin.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const privateSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
const html = async (page: string, body: string) => await run("UPDATE documents SET html=? WHERE page_id=?", body, page);
const link = (page: string) => `<a href="#page=${page}">Link</a>`;

const target = await createPage(wid, space, admin.id, "Zielseite");
const open = await createPage(wid, space, admin.id, "Projektplan Alpha");
await html(open, `<p>Siehe ${link(target)}.</p>`);
const shared = await createPage(wid, space, admin.id, "Notizen");
await html(shared, `<p>Auch hier: ${link(target)}.</p>`);
const backlink = await createPage(wid, space, admin.id, "Übersicht");
await html(backlink, `<p>Zum Plan: ${link(open)}.</p>`);
const similar = await createPage(wid, space, admin.id, "Projektplan Alpha 2");
const unrelated = await createPage(wid, space, admin.id, "Kantine");
await html(unrelated, "<p>Mittagessen um zwölf.</p>");
const secret = await createPage(wid, privateSpace, admin.id, "Projektplan Alpha geheim");
await html(secret, `<p>Geheim: ${link(open)}.</p>`);
const trashed = await createPage(wid, space, admin.id, "Projektplan Alpha alt");
await html(trashed, `<p>Alt: ${link(open)}.</p>`);
await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), trashed);
const db = await createPage(wid, space, admin.id, "Aufgaben", "database");
const row = async (title: string, tags: string[]) => ((await command(admin, { action: "row.create", pageId: db, cells: { title, tags } })) as { id: string }).id;
const r1 = await row("Logo entwerfen", ["Design", "Produkt"]);
const r2 = await row("Farben wählen", ["Design"]);
const r3 = await row("Server aufsetzen", ["Entwicklung"]);
const r4 = await row("Logo entwerfen", []);

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = async (settings: Record<string, unknown>) => await command(admin, { action: "admin.ai", settings });

test("without AI: links, backlinks, shared links and titles – only what the person may read", async () => {
  const { items, semantic } = await relatedPages(ben, open);
  assert.equal(semantic, false);
  const ids = items.map((i) => i.pageId);
  const reasons = (page: string) => items.find((i) => i.pageId === page)?.reasons || [];
  assert.ok(reasons(target).includes("link"));
  assert.ok(reasons(backlink).includes("backlink"));
  assert.ok(reasons(shared).includes("shared-links"));
  assert.ok(reasons(similar).includes("title"));
  assert.ok(!ids.includes(open), "not the page itself");
  assert.ok(!ids.includes(secret), "pages the person cannot read never show");
  assert.ok(!ids.includes(trashed), "nor the trash");
  assert.ok(!ids.includes(unrelated));
  // Strong links come first.
  assert.ok(ids.indexOf(target) < ids.indexOf(similar));
  // The owner sees the private backlink.
  assert.ok((await relatedPages(admin, open)).items.some((i) => i.pageId === secret));
});

test("records: same tags, hidden records stay hidden", async () => {
  const { items } = await relatedPages(ben, db, r1);
  const ids = items.map((i) => i.rowId);
  assert.ok(ids.includes(r2), "shares a tag");
  assert.ok(!ids.includes(r3));
  assert.equal(items.find((i) => i.rowId === r2)!.pageTitle, "Aufgaben");
  assert.ok(!items.some((i) => !i.rowId && i.pageId === db), "not its own database");
  await run("UPDATE rows SET access='private' WHERE id=?", r2);
  assert.ok(!(await relatedPages(ben, db, r1)).items.some((i) => i.rowId === r2));
  await run("UPDATE rows SET access='' WHERE id=?", r2);
});

test("with meaning search: neighbours by meaning, only what the AI may read", async () => {
  // Meaning: one dimension for "plan", one for food.
  mock.vector = (text) => [/(projektplan|meilenstein|zielseite|roadmap)/i.test(text) ? 1 : 0, /(mittag|kantine|essen)/i.test(text) ? 1 : 0, 0.05];
  const roadmap = await createPage(wid, space, admin.id, "Roadmap");
  await html(roadmap, "<p>Die Meilensteine für das nächste Jahr.</p>");
  const blockedPlan = await createPage(wid, space, admin.id, "Roadmap Personal");
  await html(blockedPlan, "<p>Meilensteine der Personalplanung.</p>");
  await command(admin, { action: "ai.block", targetId: blockedPlan, kind: "page", blocked: true });
  await setAi({ enabled: true, semanticSearch: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "embed" } });
  for (let i = 0; i < 20; i++) if (!(await processEmbeddings(500)).pending) break;
  const calls = mock.embeds.length;
  const { items, semantic } = await relatedPages(ben, open);
  assert.equal(semantic, true);
  assert.equal(mock.embeds.length, calls, "no provider call: stored vectors only");
  const byMeaning = items.filter((i) => i.reasons.includes("meaning")).map((i) => i.pageId);
  assert.ok(byMeaning.includes(roadmap));
  assert.ok(!byMeaning.includes(unrelated));
  assert.ok(!items.some((i) => i.pageId === blockedPlan), "closed to the AI");
  // The person's own rule excludes the page from meaning search.
  await command(ben, { action: "ai.rule", targetId: roadmap, mode: "exclude" });
  assert.ok(!(await relatedPages(ben, open)).items.some((i) => i.pageId === roadmap));
  // AI off: back to links and titles.
  await setAi({ enabled: false });
  assert.equal((await relatedPages(ben, open)).semantic, false);
});

test("duplicate hint: similar titles among readable pages or records of a database", async () => {
  assert.equal(normalizeTitle("  Café-Plan  2026! "), "cafe plan 2026");
  assert.equal(titleSimilarity("Projektplan Alpha", "projektplan alpha"), 1);
  assert.ok(titleSimilarity("Projektplan Alpha", "Projektplan Alpha 2") > 0.8);
  assert.ok(titleSimilarity("Projektplan Alpha", "Kantine") < 0.3);
  const pages = (await similarTitles(ben, { workspaceId: wid, title: "Projektplan Alpha" })).map((i) => i.pageId);
  assert.ok(pages.includes(open) && pages.includes(similar));
  assert.ok(!pages.includes(secret) && !pages.includes(trashed));
  assert.ok(!(await similarTitles(ben, { workspaceId: wid, title: "Projektplan Alpha", excludePageId: open })).some((i) => i.pageId === open));
  assert.deepEqual(await similarTitles(ben, { workspaceId: wid, title: "abc" }), [], "too short");
  const records = await similarTitles(ben, { workspaceId: wid, title: "Logo entwerfen", databaseId: db, excludeRowId: r4 });
  assert.deepEqual(
    records.map((r) => r.rowId),
    [r1],
  );
  const stranger = await person("Sam");
  await assert.rejects(async () => await similarTitles(stranger, { workspaceId: wid, title: "Projektplan Alpha" }));
});

test("titles in Chinese relate by their words, two-character ones too", async () => {
  const invoice = await createPage(wid, space, admin.id, "上海发票");
  const summary = await createPage(wid, space, admin.id, "发票汇总");
  const other = await createPage(wid, space, admin.id, "会议记录");
  const related = await relatedPages(ben, invoice);
  const reasons = (page: string) => related.items.find((i) => i.pageId === page)?.reasons || [];
  assert.ok(reasons(summary).includes("title"));
  assert.ok(!reasons(other).length);
});

test("records: a multi-select property hidden by a read rule never makes records related", async () => {
  const hiddenDb = await createPage(wid, space, admin.id, "Kandidaten", "database");
  const { database } = await import("../lib/api");
  const d = await database(hiddenDb);
  await command(admin, {
    action: "database.update",
    pageId: hiddenDb,
    version: d.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "verdict", name: "Einstufung", type: "multiselect", options: ["Absage", "Zusage"], access: { read: "owners" } },
    ],
    views: d.views,
  });
  const add = async (title: string, verdict: string[]) => ((await command(admin, { action: "row.create", pageId: hiddenDb, cells: { title, verdict } })) as { id: string }).id;
  const a = await add("Quokka", ["Absage"]);
  const b = await add("Narwal", ["Absage"]);
  const tagged = (items: { rowId?: string; reasons: string[] }[]) => items.some((i) => i.rowId === b && i.reasons.includes("tags"));
  assert.equal(tagged((await relatedPages(ben, hiddenDb, a)).items), false);
  assert.equal(tagged((await relatedPages(admin, hiddenDb, a)).items), true);
});

test("records: their own sub-pages are structure, not related pages", async () => {
  const sub = ((await command(admin, { action: "page.create", workspaceId: wid, spaceId: space, parentId: db, parentRowId: r1, title: "Logo entwerfen Skizzen" })) as { id: string }).id;
  const loose = await createPage(wid, space, admin.id, "Logo entwerfen Ideen");
  const pages = (await relatedPages(ben, db, r1)).items.filter((i) => !i.rowId).map((i) => i.pageId);
  assert.ok(!pages.includes(sub), "not a sub-page of the record itself");
  assert.ok(pages.includes(loose), "other pages with a similar title still show");
  // From another record the sub-page is an ordinary page.
  assert.ok((await relatedPages(ben, db, r4)).items.some((i) => !i.rowId && i.pageId === sub));
});
