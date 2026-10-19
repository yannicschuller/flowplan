import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-ask-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { prepareAsk, citedSources, ASK_LIMITS } = await import("../lib/ai/ask");
const { aiComplete } = await import("../lib/ai/run");
const { htmlParagraphs, chunkHtml, chunkParagraphs, questionTerms, rankPassages, selectPassages, ftsQuery, CHUNK_MAX } = await import("../lib/ai/chunks");
const { extractJson, parseJsonAnswer } = await import("../lib/ai/json");
const { citationParts } = await import("../lib/ai/client");
const { processEmbeddings, semanticCandidates, semanticFor, semanticStats, toVector, fromVector } = await import("../lib/ai/semantic");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import { z } from "zod";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  vic = person("Vic"),
  gus = person("Gus");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
run("INSERT INTO members VALUES(?,?,?)", wid, gus.id, "viewer");
run("INSERT INTO workspace_guests VALUES(?,?)", wid, gus.id);
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const privateSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
const html = (page: string, body: string) => run("UPDATE documents SET html=? WHERE page_id=?", body, page);

// What Ben may read …
const plan = createPage(wid, space, admin.id, "Urlaubsplanung");
html(plan, "<h2>Ausflug</h2><p>Der Betriebsausflug findet am 12. Juni in Hamburg statt.</p><p>Treffpunkt ist der Hauptbahnhof um 9 Uhr.</p><h2>Sonstiges</h2><p>Die Kantine bleibt geschlossen.</p>");
const sub = createPage(wid, space, admin.id, "Anreise", "document", plan);
html(sub, "<p>Zum Betriebsausflug fahren wir mit dem Zug nach Hamburg.</p>");
const other = createPage(wid, space, admin.id, "Wartung");
html(other, "<p>Der Server wird am Samstag gewartet.</p>");
const db = createPage(wid, space, admin.id, "Ausflüge", "database");
const trip = command(admin, { action: "row.create", pageId: db, cells: { title: "Betriebsausflug Hamburg", status: "In Arbeit" } }) as { id: string };
// … and what must never reach a prompt for him.
const secretPage = createPage(wid, privateSpace, admin.id, "Geheimprojekt");
html(secretPage, "<p>Betriebsausflug Budget: 5000 Euro GEHEIMBUDGET.</p>");
const blocked = createPage(wid, space, admin.id, "Personalakte");
html(blocked, "<p>Betriebsausflug Abmahnung GESPERRTINHALT.</p>");
command(admin, { action: "ai.block", targetId: blocked, kind: "page", blocked: true });
const journal = createPage(wid, space, ben.id, "Tagebuch", "journal");
const day = createPage(wid, space, ben.id, "Montag", "document", journal);
html(day, "<p>Betriebsausflug war langweilig TAGEBUCHINHALT.</p>");
run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
const excluded = createPage(wid, space, admin.id, "Gehaltsliste");
html(excluded, "<p>Betriebsausflug Zuschuss AUSGESCHLOSSENINHALT.</p>");
command(ben, { action: "ai.rule", targetId: excluded, mode: "exclude" });
const privateRow = command(admin, { action: "row.create", pageId: db, cells: { title: "Betriebsausflug Notiz PRIVATEREINTRAG" } }) as { id: string };
run("UPDATE rows SET access='private' WHERE id=?", privateRow.id);
const trashed = createPage(wid, space, admin.id, "Alt");
html(trashed, "<p>Betriebsausflug 2019 PAPIERKORBINHALT.</p>");
run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed);
const FORBIDDEN = ["GEHEIMBUDGET", "GESPERRTINHALT", "TAGEBUCHINHALT", "AUSGESCHLOSSENINHALT", "PRIVATEREINTRAG", "PAPIERKORBINHALT"];
const FORBIDDEN_PAGES = [secretPage, blocked, day, journal, excluded, trashed];

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });
const ask = (user: Identity, question: string, extra: Record<string, unknown> = {}) => prepareAsk(user, { workspaceId: wid, question, ...extra });

// ---- Pure parts ----

test("documents are split into paragraphs and chunks with their heading", () => {
  const paragraphs = htmlParagraphs("<h1>Titel</h1><p>Eins &amp; zwei</p><ul><li>Punkt A</li><li>Punkt B</li></ul><script>alert(1)</script><p>Drei<br>Vier</p>");
  assert.deepEqual(
    paragraphs.map((p) => p.text),
    ["Titel", "Eins & zwei", "Punkt A", "Punkt B", "Drei", "Vier"],
  );
  assert.equal(paragraphs[0].heading, true);
  const long = "<h2>Kapitel</h2>" + Array.from({ length: 40 }, (_, i) => `<p>Satz ${i} mit etwas Text, der den Absatz füllt und länger wird.</p>`).join("");
  const chunks = chunkHtml(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.startsWith("Kapitel\n")), "every chunk repeats its heading");
  assert.ok(chunks.every((c) => c.length <= CHUNK_MAX + 100));
  // A single huge paragraph is cut at sentence ends.
  const huge = chunkParagraphs([{ text: "Ein Satz. ".repeat(500) }]);
  assert.ok(huge.length > 2 && huge.every((c) => c.length <= CHUNK_MAX));
});

test("question terms skip stop words and short words; FTS queries are quoted", () => {
  assert.deepEqual(questionTerms("Wann ist der Betriebsausflug in Hamburg?"), ["betriebsausflug", "hamburg"]);
  assert.deepEqual(questionTerms("What is the budget for Café Müller?"), ["budget", "cafe", "muller"]);
  assert.equal(ftsQuery(['a"b', "hamburg"]), '"a""b" OR "hamburg"');
});

test("passages are ranked by rare terms and picked within the budget", () => {
  const passages = [
    { key: "a", text: "Hamburg Hamburg Hamburg allgemein", title: "A", sourceRank: 3 },
    { key: "b", text: "Der Betriebsausflug nach Hamburg", title: "B", sourceRank: 2 },
    { key: "c", text: "Nichts Passendes hier", title: "C", sourceRank: 0 },
    { key: "b", text: "Noch mehr zum Betriebsausflug", title: "B", sourceRank: 2 },
  ];
  const ranked = rankPassages(passages, ["betriebsausflug", "hamburg"]);
  assert.equal(ranked[0].key, "b");
  assert.equal(ranked.find((p) => p.key === "c")!.matched, 0);
  assert.ok(ranked.findIndex((p) => p.key === "c") > 0);
  const chosen = selectPassages(ranked, 70, 1, 8);
  assert.ok(chosen.reduce((s, p) => s + p.text.length, 0) <= 70);
  assert.equal(new Set(chosen.map((p) => p.key)).size, chosen.length, "one per source");
  assert.equal(selectPassages(ranked, 10_000, 3, 1).every((p) => p.key === "b"), true, "one source at most");
});

test("JSON answers are parsed robustly and checked strictly", () => {
  assert.deepEqual(extractJson('Hier: ```json\n{"value": "A",}\n```'), { value: "A" });
  assert.deepEqual(extractJson('Siehe [1]. Antwort: {"value": [1, 2], "x": "}"}'), { value: [1, 2], x: "}" });
  assert.throws(() => extractJson("keine Daten"));
  const schema = z.object({ value: z.number() });
  assert.equal(parseJsonAnswer('{"value": "drei"}', schema).ok, false);
  assert.deepEqual(parseJsonAnswer('{"value": 3}', schema), { ok: true, value: { value: 3 } });
});

test("citations link only to existing sources", () => {
  const sources = [
    { n: 1, pageId: "p", title: "A", kind: "document" },
    { n: 2, pageId: "q", title: "B", kind: "document" },
  ];
  assert.deepEqual(citationParts("Am 12. Juni [1][2], nicht [7]. Siehe [1, 2].", sources), [
    { text: "Am 12. Juni " },
    { cite: 1 },
    { cite: 2 },
    { text: ", nicht [7]. Siehe " },
    { cite: 1 },
    { cite: 2 },
    { text: "." },
  ]);
  assert.deepEqual(citedSources("x [2] y [9]", sources), [2]);
});

test("vectors are stored normalized as 32-bit floats", () => {
  const v = fromVector(toVector([3, 4]));
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
});

// ---- Retrieval with permissions ----

test("ask needs the feature: off, guests, API tokens and the person's switch refuse", async () => {
  await assert.rejects(ask(ben, "Betriebsausflug?"), /ausgeschaltet/);
  setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } });
  await assert.rejects(ask(gus, "Betriebsausflug?"), /Gäste/);
  const { token } = command(ben, { action: "token.create", name: "Skript", scope: "read" }) as { token: string };
  await assert.rejects(ask(identityFromApiToken(`Bearer ${token}`)!, "Betriebsausflug?"), /API-Token/);
  setAi({ features: { ask: false } });
  await assert.rejects(ask(ben, "Betriebsausflug?"), /ausgeschaltet/);
  setAi({ features: { ask: true } });
  command(vic, { action: "ai.settings", features: { ask: false } });
  await assert.rejects(ask(vic, "Betriebsausflug?"), /ausgeschaltet/);
  command(vic, { action: "ai.settings", features: { ask: true } });
});

test("excluded, hidden, blocked, PIN and trashed content never reaches the prompt or the sources", async () => {
  const prepared = await ask(ben, "Wann ist der Betriebsausflug?");
  assert.equal(prepared.nothing, false);
  const prompt = prepared.messages.map((m) => m.content).join("\n");
  assert.match(prompt, /12\. Juni in Hamburg/);
  assert.match(prompt, /Frage: Wann ist der Betriebsausflug\?/);
  for (const word of FORBIDDEN) assert.ok(!prompt.includes(word), word);
  const ids = prepared.sources.map((s) => s.pageId);
  for (const page of FORBIDDEN_PAGES) assert.ok(!ids.includes(page), page);
  assert.ok(!prepared.sources.some((s) => s.rowId === privateRow.id));
  assert.ok(ids.includes(plan) && ids.includes(sub));
  assert.ok(prepared.sources.some((s) => s.rowId === trip.id && s.pageTitle === "Ausflüge"));
  // Numbered 1…n, in the order they appear in the prompt.
  prepared.sources.forEach((s, i) => assert.equal(s.n, i + 1));
  assert.ok(prompt.indexOf('nr="1"') < prompt.indexOf('nr="2"'));
  assert.match(prepared.system, /Dazu habe ich nichts gefunden/);
  // What the model receives is exactly that.
  mock.answer = () => "Am 12. Juni in Hamburg [1].";
  const before = mock.chats.length;
  const answer = await aiComplete(ben, "ask", { system: prepared.system, messages: prepared.messages }, { workspaceId: wid });
  assert.equal(answer, "Am 12. Juni in Hamburg [1].");
  const sent = mock.chats[before];
  for (const word of FORBIDDEN) assert.ok(!sent.prompt.includes(word), word);
});

test("the owner's own private content is found for the owner only", async () => {
  const forAdmin = await ask(admin, "Betriebsausflug Budget GEHEIMBUDGET");
  const prompt = forAdmin.messages.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("GEHEIMBUDGET"), "the owner may read the private space");
  assert.ok(prompt.includes("PRIVATEREINTRAG"), "and the own private record");
  assert.ok(!prompt.includes("GESPERRTINHALT"), "a page closed to the AI stays closed for its owner too");
  const forBen = await ask(ben, "Betriebsausflug Budget GEHEIMBUDGET");
  const benPrompt = forBen.messages.map((m) => m.content).join("\n");
  assert.ok(!benPrompt.slice(0, benPrompt.indexOf("Frage:")).includes("GEHEIMBUDGET"));
  assert.ok(!forBen.sources.some((s) => s.pageId === secretPage));
});

test("nothing found: no provider call, an honest answer", async () => {
  const prepared = await ask(ben, "Quantenkryptographie Raumfahrtbehörde");
  assert.equal(prepared.nothing, true);
  assert.deepEqual(prepared.sources, []);
  const stopwordsOnly = await ask(ben, "Was ist das?");
  assert.equal(stopwordsOnly.nothing, true);
});

test("scope: a page and its sub-pages, or one space", async () => {
  const onlySub = await ask(ben, "Betriebsausflug Hamburg", { scope: { kind: "page", pageId: sub } });
  assert.deepEqual([...new Set(onlySub.sources.map((s) => s.pageId))], [sub]);
  const tree = await ask(ben, "Betriebsausflug Hamburg", { scope: { kind: "page", pageId: plan } });
  assert.deepEqual(new Set(tree.sources.map((s) => s.pageId)), new Set([plan, sub]));
  await assert.rejects(ask(ben, "Betriebsausflug", { scope: { kind: "page", pageId: secretPage } }), /Berechtigung|nicht gefunden/);
  await assert.rejects(ask(ben, "Betriebsausflug", { scope: { kind: "space", spaceId: privateSpace } }), /Berechtigung/);
  const inSpace = await ask(admin, "Betriebsausflug", { scope: { kind: "space", spaceId: privateSpace } });
  assert.deepEqual([...new Set(inSpace.sources.map((s) => s.pageId))], [secretPage]);
});

test("a short follow-up uses the previous question's terms; history is trimmed", async () => {
  const history = [
    { role: "user" as const, content: "Wann ist der Betriebsausflug?" },
    { role: "assistant" as const, content: "Am 12. Juni [1]." },
  ];
  const followUp = await ask(ben, "Und wo?", { history });
  assert.equal(followUp.nothing, false);
  assert.equal(followUp.messages.length, 3);
  assert.equal(followUp.messages[0].role, "user");
  const long = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "x".repeat(10_000) }));
  const trimmed = await ask(ben, "Betriebsausflug Hamburg?", { history: long });
  assert.ok(trimmed.messages.length <= ASK_LIMITS.historyMessages + 1);
  assert.ok(trimmed.messages.slice(0, -1).every((m) => m.content.length <= ASK_LIMITS.historyChars));
  assert.equal(trimmed.messages[0].role, "user");
});

test("the prompt stays within the passage budget", async () => {
  const big = createPage(wid, space, admin.id, "Handbuch");
  html(big, Array.from({ length: 300 }, (_, i) => `<p>Kapitel ${i}: Betriebsausflug Regeln und Hinweise, ausführlich beschrieben für alle Teams.</p>`).join(""));
  const prepared = await ask(ben, "Betriebsausflug Regeln");
  const prompt = prepared.messages[prepared.messages.length - 1].content;
  assert.ok(prompt.length < ASK_LIMITS.passageChars + 4000, String(prompt.length));
  assert.ok(prepared.sources.length <= ASK_LIMITS.maxSources);
});

// ---- Semantic search ----

// Meaning as three dimensions: travel, money, servers.
const meaning = (text: string) => {
  const t = text.toLowerCase();
  return [/(ausflug|reise|hamburg|zug|trip)/.test(t) ? 1 : 0, /(budget|euro|zuschuss|geld)/.test(t) ? 1 : 0, /(server|wartung)/.test(t) ? 1 : 0.01];
};

test("semantic search stays off until switched on with an embedding model", async () => {
  assert.equal((await processEmbeddings()).embedded, 0);
  assert.equal(semanticStats().active, false);
  setAi({ provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "embed" } });
  assert.equal((await processEmbeddings()).embedded, 0, "an embedding model alone is not enough");
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM ai_embeddings")!.n, 0);
});

test("embeddings: readable content only, never PIN journals, blocked pages or the trash; incremental", async () => {
  mock.vector = meaning;
  setAi({ semanticSearch: true });
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const step = await processEmbeddings(500);
    total += step.embedded;
    if (!step.pending) break;
  }
  assert.ok(total > 0);
  const embedded = new Set((await import("../lib/db")).all<{ page_id: string }>("SELECT DISTINCT page_id FROM ai_embeddings").map((r) => r.page_id));
  assert.ok(embedded.has(plan) && embedded.has(sub) && embedded.has(db));
  for (const page of [blocked, day, journal, trashed]) assert.ok(!embedded.has(page), page);
  // Personal rules and permissions apply at query time, not when embedding.
  assert.ok(embedded.has(excluded) && embedded.has(secretPage));
  const sentTexts = mock.embeds.flat().join("\n");
  for (const word of ["GESPERRTINHALT", "TAGEBUCHINHALT", "PAPIERKORBINHALT"]) assert.ok(!sentTexts.includes(word), word);
  // Only hashes are stored, never the text.
  const stored = (await import("../lib/db")).all<{ hash: string }>("SELECT hash FROM ai_embeddings");
  assert.ok(stored.every((r) => /^[0-9a-f]{32}$/.test(r.hash)));
  // Nothing changed: nothing is embedded again.
  assert.equal((await processEmbeddings(500)).embedded, 0);
  // One paragraph changes: only that chunk is embedded again.
  html(other, "<p>Der Server wird am Sonntag gewartet.</p>");
  const step = await processEmbeddings(500);
  assert.equal(step.embedded, 1);
  // Closing a page to the AI removes its vectors.
  command(admin, { action: "ai.block", targetId: other, kind: "page", blocked: true });
  await processEmbeddings(500);
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM ai_embeddings WHERE page_id=?", other)!.n, 0);
  command(admin, { action: "ai.block", targetId: other, kind: "page", blocked: false });
  const stats = semanticStats();
  assert.equal(stats.active, true);
  assert.ok(stats.bytes >= stats.chunks * 3 * 4);
});

test("meaning finds passages without shared words – and still respects every rule", async () => {
  assert.ok(semanticFor(ben, wid));
  const hits = await semanticCandidates(ben, wid, "Reise");
  assert.ok(hits.length > 0);
  const prepared = await ask(ben, "Reise");
  assert.equal(prepared.nothing, false, "found by meaning only");
  assert.equal(prepared.semantic, true);
  const prompt = prepared.messages.map((m) => m.content).join("\n");
  assert.match(prompt, /Hamburg/);
  for (const word of FORBIDDEN) assert.ok(!prompt.includes(word), word);
  const money = await ask(ben, "Geld");
  const moneyPrompt = money.messages.map((m) => m.content).join("\n");
  assert.ok(!moneyPrompt.includes("GEHEIMBUDGET") && !moneyPrompt.includes("AUSGESCHLOSSENINHALT"));
  for (const page of FORBIDDEN_PAGES) assert.ok(!money.sources.some((s) => s.pageId === page), page);
});

test("people with their own provider do not use the instance's embeddings", () => {
  setAi({ userProviders: true });
  command(vic, { action: "ai.provider", provider: { kind: "openai", baseUrl: "https://api.example.com/v1", model: "x", embeddingModel: "" }, apiKey: "sk-vic-0123456789" });
  command(vic, { action: "ai.settings", source: "user" });
  assert.equal(semanticFor(vic, wid), null);
  assert.ok(semanticFor(ben, wid));
});

test("switching semantic search off removes all vectors", async () => {
  setAi({ semanticSearch: false });
  const step = await processEmbeddings();
  assert.ok(step.removed > 0);
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM ai_embeddings")!.n, 0);
  assert.equal(semanticFor(ben, wid), null);
});
