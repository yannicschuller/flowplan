// Automatic page links of the writing assistant (lib/ai/links.ts,
// lib/ai/link-candidates.ts): which pages are offered (only what the AI may
// read, never the page being written), what reaches the prompt (handles,
// titles, excerpts – no ids), how handles become links (only those offered)
// and that inserted links are real page links: renamed with their page,
// exported as Markdown links – against a provider on this machine.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-links-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_AI_FEATURES;
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { generateHTML, generateJSON } = await import("@tiptap/html/server");
const { EditorState } = await import("@tiptap/pm/state");
const { aiMarkdownToHtml, aiInsertTransaction } = await import("../lib/ai/insert");
const { decodeLinkTargets, expandLinkHandles, linkedTargets, pageLinkHref, LINKS_HEADER } = await import("../lib/ai/links");
const { findLinkCandidates, encodeLinkTargets, linkTerms, LINK_LIMITS } = await import("../lib/ai/link-candidates");
const { writePrompt, summaryPrompt } = await import("../lib/ai/prompts");
const { aiWriteResponse } = await import("../lib/ai/write");
const { aiSummaryResponse } = await import("../lib/ai/summarize");
const { exportMarkdown } = await import("../lib/markdown-export");
const { textBacklinks } = await import("../lib/text-backlinks");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity, Page } from "../lib/types";

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
const sealedSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,encrypted) VALUES(?,?,?,?,?,1)", sealedSpace, wid, "Tresor", "workspace", admin.id);
const html = (page: string, body: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), page);
const storedHtml = (page: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page)!.html);

// The page being written, and pages Ben may link …
const current = createPage(wid, space, admin.id, "Projektnotizen");
html(current, "<p>Wir planen den Umzug ins neue Büro.</p>");
const budget = createPage(wid, space, admin.id, "Umzugsbudget");
html(budget, "<h2>Umzugsbudget</h2><p>Für den Umzug ins neue Büro stehen 20.000 Euro bereit.</p>");
const checklist = createPage(wid, space, admin.id, "Umzug Checkliste");
html(checklist, "<p>Kartons packen, Möbel für den Umzug ins Büro bestellen.</p>");
// … and what must never be offered to him.
const secret = createPage(wid, privateSpace, admin.id, "Umzug Geheimplan");
html(secret, "<p>Umzug Büro GEHEIMINHALT.</p>");
const blocked = createPage(wid, space, admin.id, "Umzug Personalakte");
html(blocked, "<p>Umzug Büro GESPERRTINHALT.</p>");
command(admin, { action: "ai.block", targetId: blocked, kind: "page", blocked: true });
const journal = createPage(wid, space, ben.id, "Tagebuch", "journal");
const day = createPage(wid, space, ben.id, "Umzug Tagebuchtag", "document", journal);
html(day, "<p>Umzug Büro TAGEBUCHINHALT.</p>");
run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
const excluded = createPage(wid, space, admin.id, "Umzug Gehälter");
html(excluded, "<p>Umzug Büro AUSGESCHLOSSENINHALT.</p>");
command(ben, { action: "ai.rule", targetId: excluded, mode: "exclude" });
const trashed = createPage(wid, space, admin.id, "Umzug Archiv");
html(trashed, "<p>Umzug Büro PAPIERKORBINHALT.</p>");
run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed);
const sealed = createPage(wid, sealedSpace, admin.id, "Umzug Tresor");
// End-to-end encrypted: the server keeps no plaintext, but the title is named in the text below.
const FORBIDDEN = ["GEHEIMINHALT", "GESPERRTINHALT", "TAGEBUCHINHALT", "AUSGESCHLOSSENINHALT", "PAPIERKORBINHALT"];
const FORBIDDEN_PAGES = [secret, blocked, day, journal, excluded, trashed, sealed];
const FORBIDDEN_TITLES = ["Umzug Geheimplan", "Umzug Personalakte", "Umzug Tagebuchtag", "Umzug Gehälter", "Umzug Archiv", "Umzug Tresor"];

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });
setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } });
const QUERY = "Schreib eine Einleitung über den Umzug ins neue Büro und das Umzugsbudget.";
const candidates = (user: Identity, query = QUERY, pageId = current) => findLinkCandidates(user, { workspaceId: wid, pageId, query });
const never = new AbortController().signal;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- Retrieval ----

test("only pages the AI may read are offered – never the page being written", async () => {
  const found = await candidates(ben);
  const ids = found.targets.map((t) => t.pageId);
  assert.ok(ids.includes(budget) && ids.includes(checklist), JSON.stringify(found.targets));
  assert.ok(!ids.includes(current), "not the page being written");
  for (const page of FORBIDDEN_PAGES) assert.ok(!ids.includes(page), page);
  const prompt = JSON.stringify(found.prompt);
  for (const word of [...FORBIDDEN, ...FORBIDDEN_TITLES]) assert.ok(!prompt.includes(word), word);
  assert.ok(!UUID.test(prompt), "no ids in what the model sees");
  // Handles P1 … Pn in both lists, the title literally named first.
  assert.deepEqual(found.prompt.map((p) => p.handle), found.targets.map((t, i) => (assert.equal(t.handle, `P${i + 1}`), t.handle)));
  assert.equal(found.targets[0].pageId, budget);
  assert.match(found.prompt[0].excerpt, /20\.000 Euro/);
  assert.ok(!found.prompt[0].excerpt.startsWith("Umzugsbudget"), "the heading repeating the title is left out");
});

test("the owner's private page is offered to the owner – blocked, PIN, trash and encrypted pages to no one", async () => {
  const ids = (await candidates(admin)).targets.map((t) => t.pageId);
  assert.ok(ids.includes(secret), "the owner may read the private space");
  for (const page of [blocked, day, trashed, sealed]) assert.ok(!ids.includes(page), page);
});

test("a page the person cannot read is never offered, even when its title is named", async () => {
  const found = await candidates(ben, "Bitte verlinke Umzug Geheimplan und Umzug Personalakte und Umzug Tresor.");
  const ids = found.targets.map((t) => t.pageId);
  for (const page of FORBIDDEN_PAGES) assert.ok(!ids.includes(page), page);
});

test("the switches: off for the instance, off for the person, nothing without terms", async () => {
  setAi({ features: { links: false } });
  assert.deepEqual(await candidates(ben), { prompt: [], targets: [] });
  setAi({ features: { links: true } });
  command(ben, { action: "ai.settings", features: { links: false } });
  assert.deepEqual(await candidates(ben), { prompt: [], targets: [] });
  command(ben, { action: "ai.settings", features: { links: true } });
  assert.deepEqual(await candidates(ben, "Was ist das?"), { prompt: [], targets: [] });
  assert.ok((await candidates(ben)).targets.length > 0);
});

test("a strict budget: at most eight short candidates", async () => {
  for (let i = 0; i < 20; i++) {
    const page = createPage(wid, space, admin.id, `Umzug Raum ${i}`);
    html(page, `<p>${"Umzug ins neue Büro, Raumplanung und Möbel. ".repeat(40)}</p>`);
  }
  const found = await candidates(ben);
  assert.equal(found.targets.length, LINK_LIMITS.candidates.remote);
  assert.ok(found.prompt.every((p) => p.excerpt.length <= LINK_LIMITS.excerptChars.remote && p.title.length <= LINK_LIMITS.titleChars));
  const local = await findLinkCandidates(ben, { workspaceId: wid, pageId: current, query: QUERY, local: true });
  assert.equal(local.targets.length, LINK_LIMITS.candidates.local);
  assert.ok(local.prompt.every((p) => p.excerpt.length <= LINK_LIMITS.excerptChars.local));
  // The page list in the prompt stays small.
  const prompt = writePrompt({ action: "prompt", instruction: "x", locale: "de", links: found.prompt });
  const block = /<pages>[\s\S]*<\/pages>/.exec(prompt.messages[0].content)![0];
  assert.ok(block.length < 3000, String(block.length));
});

test("search terms of a long text: the most frequent first", () => {
  assert.deepEqual(linkTerms("Der Umzug. Das Büro. Der Umzug ist bald. Umzug!", 2), ["umzug", "buro"]);
});

// ---- Prompt and endpoints ----

test("the writing assistant offers pages by handle only when asked, and names them in a header", async () => {
  mock.answer = () => "Für den Umzug gibt es ein [[P1]].";
  const before = mock.chats.length;
  const response = await aiWriteResponse(ben, { pageId: current, action: "prompt", instruction: QUERY, locale: "de", links: true }, never);
  assert.equal(await response.text(), "Für den Umzug gibt es ein [[P1]].");
  const sent = mock.chats[before];
  assert.match(sent.system, /\[\[P1\]\]/);
  assert.match(sent.system, /Never write page addresses, ids or URLs/);
  assert.match(sent.prompt, /<pages>\nP1: "Umzugsbudget" – /);
  assert.ok(!UUID.test(sent.prompt), "no page ids reach the model");
  for (const word of FORBIDDEN) assert.ok(!sent.prompt.includes(word), word);
  const targets = decodeLinkTargets(response.headers.get(LINKS_HEADER));
  assert.equal(targets[0].pageId, budget);
  assert.equal(targets[0].title, "Umzugsbudget");
  // Without the switch: no pages, no header.
  const plain = await aiWriteResponse(ben, { pageId: current, action: "prompt", instruction: QUERY, locale: "de" }, never);
  await plain.text();
  assert.ok(!mock.chats[mock.chats.length - 1].prompt.includes("<pages>\n"));
  assert.equal(plain.headers.get(LINKS_HEADER), null);
  // A selection action links too.
  const improve = await aiWriteResponse(ben, { pageId: current, action: "improve", text: "Das Umzugsbudget für das Büro ist knap.", locale: "de", links: true }, never);
  await improve.text();
  assert.match(mock.chats[mock.chats.length - 1].prompt, /<pages>[\s\S]*Umzugsbudget[\s\S]*<\/pages>\n\n<text>/);
});

test("voice-note summaries link pages too", async () => {
  mock.answer = () => "## Zusammenfassung\nDer [Umzug](flowplan:P1) kommt.\n## Kernpunkte\n- x\n## Offene Aufgaben\n- Keine";
  const before = mock.chats.length;
  const response = await aiSummaryResponse(ben, { pageId: current, text: "Wir haben über den Umzug ins neue Büro und das Umzugsbudget gesprochen.", locale: "de", links: true }, never);
  await response.text();
  assert.match(mock.chats[before].prompt, /<pages>[\s\S]*Umzugsbudget/);
  assert.ok(decodeLinkTargets(response.headers.get(LINKS_HEADER)).some((t) => t.pageId === budget));
  const prompt = summaryPrompt({ kind: "transcript", content: "x", locale: "de" });
  assert.ok(!(prompt.system ?? "").includes("[[P1]]") && !prompt.messages[0].content.includes("<pages>\n"), "no pages without links");
});

// ---- Handles → links ----

const targets = [
  { handle: "P1", pageId: budget, title: "Umzugsbudget" },
  { handle: "P2", pageId: checklist, title: "Umzug [Checkliste]" },
];

test("only offered handles become page links; invented handles and addresses stay text", () => {
  const out = aiMarkdownToHtml(
    `Siehe [[P1]] und [die Liste](flowplan:P2), [[p1|das Budget]]. Nicht [[P7]], [fremd](flowplan:P9), [direkt](/#page=${secret}), [voll](https://flowplan.example.test/#page=${secret}), [[${secret}]]. Aber [Web](https://example.org).`,
    targets,
  );
  assert.ok(out.includes(`<a href="/#page=${budget}">Umzugsbudget</a>`), out);
  assert.ok(out.includes(`<a href="/#page=${checklist}">die Liste</a>`), out);
  assert.ok(out.includes(`<a href="/#page=${budget}">das Budget</a>`), out);
  assert.ok(!out.includes(`#page=${secret}`), "no address the model wrote itself");
  assert.ok(!out.includes("P7") && !out.includes("flowplan:"), out);
  assert.ok(out.includes("fremd") && out.includes("direkt") && out.includes("voll"), "their words stay");
  assert.ok(out.includes('<a href="https://example.org">Web</a>'));
  // The title's brackets stay text.
  assert.ok(aiMarkdownToHtml("[[P2]]", targets).includes(`<a href="/#page=${checklist}">Umzug [Checkliste]</a>`));
  // Without linking the old rules apply: no handle means anything.
  assert.ok(!aiMarkdownToHtml("[[P1]] [x](flowplan:P1)").includes("<a"));
  assert.deepEqual(linkedTargets("[x](flowplan:P2) [[P1]] [[P2]] [[P9]]", targets).map((t) => t.handle), ["P2", "P1"]);
  assert.equal(expandLinkHandles("[[P9]] und [[P9|Wort]]", targets), " und Wort");
  assert.equal(pageLinkHref("https://example.org", targets), undefined);
  assert.equal(pageLinkHref("flowplan:P3", targets), null);
});

test("the header is checked: handles, page ids and titles only", () => {
  const header = encodeLinkTargets([
    ...targets,
    { handle: "P3", pageId: "javascript:alert(1)", title: "x" },
    { handle: "../P4", pageId: secret, title: "x" },
    { handle: "P5", pageId: secret } as never,
  ]);
  assert.deepEqual(decodeLinkTargets(header), targets);
  assert.deepEqual(decodeLinkTargets("%%%"), []);
  assert.deepEqual(decodeLinkTargets(Buffer.from('{"a":1}').toString("base64")), []);
});

// ---- Inserted: real page links ----

test("inserted links are page links: in backlinks, renamed with their page, in the Markdown export", async () => {
  const schema = documentSchema();
  const state = EditorState.create({ doc: schema.nodeFromJSON(generateJSON("<p>Wir planen den Umzug.</p><p></p>", documentExtensions)) });
  const blocks = schema.nodeFromJSON(generateJSON(aiMarkdownToHtml("Das [[P1]] steht, siehe auch [die Liste](flowplan:P2).", targets), documentExtensions)).content;
  const empty = state.doc.firstChild!.nodeSize + 1;
  const next = state.apply(aiInsertTransaction(state, blocks, { from: empty, to: empty }, "replace")!);
  const links: { text: string; href: string }[] = [];
  next.doc.descendants((node) => {
    const link = node.marks.find((m) => m.type.name === "link");
    if (node.isText && link) links.push({ text: node.text!, href: link.attrs.href });
  });
  assert.deepEqual(links, [
    { text: "Umzugsbudget", href: `/#page=${budget}` },
    { text: "die Liste", href: `/#page=${checklist}` },
  ]);
  // Stored like any edit: the page shows up in the budget's backlinks …
  html(current, generateHTML(next.doc.toJSON(), documentExtensions));
  assert.ok(textBacklinks(ben, one<Page>("SELECT * FROM pages WHERE id=?", budget)!).some((l) => l.id === current));
  // … the link text follows a rename …
  command(admin, { action: "page.update", pageId: budget, patch: { title: "Umzugsbudget 2027" } });
  assert.match(storedHtml(current), new RegExp(`<a[^>]*href="/#page=${budget}"[^>]*>Umzugsbudget 2027</a>`));
  assert.match(storedHtml(current), />die Liste<\/a>/, "own wording stays");
  // … and the Markdown export writes it as a link to the page.
  const { bytes } = await exportMarkdown(ben, { pageId: current, format: "markdown", includeSubpages: false });
  const markdown = Buffer.from(bytes as Uint8Array).toString("utf8");
  assert.ok(markdown.includes(`[Umzugsbudget 2027](<https://flowplan.example.test/#page=${budget}>)`), markdown);
});
