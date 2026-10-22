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

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const privateSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
const html = (page: string, body: string) => run("UPDATE documents SET html=? WHERE page_id=?", body, page);
const link = (page: string) => `<a href="#page=${page}">Link</a>`;

const target = createPage(wid, space, admin.id, "Zielseite");
const open = createPage(wid, space, admin.id, "Projektplan Alpha");
html(open, `<p>Siehe ${link(target)}.</p>`);
const shared = createPage(wid, space, admin.id, "Notizen");
html(shared, `<p>Auch hier: ${link(target)}.</p>`);
const backlink = createPage(wid, space, admin.id, "Übersicht");
html(backlink, `<p>Zum Plan: ${link(open)}.</p>`);
const similar = createPage(wid, space, admin.id, "Projektplan Alpha 2");
const unrelated = createPage(wid, space, admin.id, "Kantine");
html(unrelated, "<p>Mittagessen um zwölf.</p>");
const secret = createPage(wid, privateSpace, admin.id, "Projektplan Alpha geheim");
html(secret, `<p>Geheim: ${link(open)}.</p>`);
const trashed = createPage(wid, space, admin.id, "Projektplan Alpha alt");
html(trashed, `<p>Alt: ${link(open)}.</p>`);
run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed);
const db = createPage(wid, space, admin.id, "Aufgaben", "database");
const row = (title: string, tags: string[]) => (command(admin, { action: "row.create", pageId: db, cells: { title, tags } }) as { id: string }).id;
const r1 = row("Logo entwerfen", ["Design", "Produkt"]);
const r2 = row("Farben wählen", ["Design"]);
const r3 = row("Server aufsetzen", ["Entwicklung"]);
const r4 = row("Logo entwerfen", []);

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });

test("without AI: links, backlinks, shared links and titles – only what the person may read", () => {
  const { items, semantic } = relatedPages(ben, open);
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
  assert.ok(relatedPages(admin, open).items.some((i) => i.pageId === secret));
});

test("records: same tags, hidden records stay hidden", () => {
  const { items } = relatedPages(ben, db, r1);
  const ids = items.map((i) => i.rowId);
  assert.ok(ids.includes(r2), "shares a tag");
  assert.ok(!ids.includes(r3));
  assert.equal(items.find((i) => i.rowId === r2)!.pageTitle, "Aufgaben");
  assert.ok(!items.some((i) => !i.rowId && i.pageId === db), "not its own database");
  run("UPDATE rows SET access='private' WHERE id=?", r2);
  assert.ok(!relatedPages(ben, db, r1).items.some((i) => i.rowId === r2));
  run("UPDATE rows SET access='' WHERE id=?", r2);
});

test("with meaning search: neighbours by meaning, only what the AI may read", async () => {
  // Meaning: one dimension for "plan", one for food.
  mock.vector = (text) => [/(projektplan|meilenstein|zielseite|roadmap)/i.test(text) ? 1 : 0, /(mittag|kantine|essen)/i.test(text) ? 1 : 0, 0.05];
  const roadmap = createPage(wid, space, admin.id, "Roadmap");
  html(roadmap, "<p>Die Meilensteine für das nächste Jahr.</p>");
  const blockedPlan = createPage(wid, space, admin.id, "Roadmap Personal");
  html(blockedPlan, "<p>Meilensteine der Personalplanung.</p>");
  command(admin, { action: "ai.block", targetId: blockedPlan, kind: "page", blocked: true });
  setAi({ enabled: true, semanticSearch: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "embed" } });
  for (let i = 0; i < 20; i++) if (!(await processEmbeddings(500)).pending) break;
  const calls = mock.embeds.length;
  const { items, semantic } = relatedPages(ben, open);
  assert.equal(semantic, true);
  assert.equal(mock.embeds.length, calls, "no provider call: stored vectors only");
  const byMeaning = items.filter((i) => i.reasons.includes("meaning")).map((i) => i.pageId);
  assert.ok(byMeaning.includes(roadmap));
  assert.ok(!byMeaning.includes(unrelated));
  assert.ok(!items.some((i) => i.pageId === blockedPlan), "closed to the AI");
  // The person's own rule excludes the page from meaning search.
  command(ben, { action: "ai.rule", targetId: roadmap, mode: "exclude" });
  assert.ok(!relatedPages(ben, open).items.some((i) => i.pageId === roadmap));
  // AI off: back to links and titles.
  setAi({ enabled: false });
  assert.equal(relatedPages(ben, open).semantic, false);
});

test("duplicate hint: similar titles among readable pages or records of a database", () => {
  assert.equal(normalizeTitle("  Café-Plan  2026! "), "cafe plan 2026");
  assert.equal(titleSimilarity("Projektplan Alpha", "projektplan alpha"), 1);
  assert.ok(titleSimilarity("Projektplan Alpha", "Projektplan Alpha 2") > 0.8);
  assert.ok(titleSimilarity("Projektplan Alpha", "Kantine") < 0.3);
  const pages = similarTitles(ben, { workspaceId: wid, title: "Projektplan Alpha" }).map((i) => i.pageId);
  assert.ok(pages.includes(open) && pages.includes(similar));
  assert.ok(!pages.includes(secret) && !pages.includes(trashed));
  assert.ok(!similarTitles(ben, { workspaceId: wid, title: "Projektplan Alpha", excludePageId: open }).some((i) => i.pageId === open));
  assert.deepEqual(similarTitles(ben, { workspaceId: wid, title: "abc" }), [], "too short");
  const records = similarTitles(ben, { workspaceId: wid, title: "Logo entwerfen", databaseId: db, excludeRowId: r4 });
  assert.deepEqual(
    records.map((r) => r.rowId),
    [r1],
  );
  const stranger = person("Sam");
  assert.throws(() => similarTitles(stranger, { workspaceId: wid, title: "Projektplan Alpha" }));
});
