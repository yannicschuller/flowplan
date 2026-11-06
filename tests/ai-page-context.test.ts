// #134 and #135 against a stub model (tests/helpers/ai-mock.ts):
// - page links in writing-assistant answers: long lists ("all Docker Compose
//   pages") get a title index besides the few handle candidates, plain list
//   items are resolved against readable titles (unique matches only), and
//   conversational preambles never reach the document;
// - "KI fragen" with "Diese Seite": the open page goes along in full (read
//   rights and AI rules checked, cut with a note), and the conversation can
//   be put into the page as suggested changes – block by block, code blocks
//   line by line, accepted or rejected one by one, never overwritten.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-page-context-"));
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
const { generateJSON } = await import("@tiptap/html/server");
const { EditorState } = await import("@tiptap/pm/state");
const { Node: PMNode } = await import("@tiptap/pm/model");
const Y = await import("yjs");
const { yDocToProsemirrorJSON } = await import("y-prosemirror");
const { aiMarkdownToHtml } = await import("../lib/ai/insert");
const { cleanAnswer, stripChatter, writePrompt } = await import("../lib/ai/prompts");
const { aiWriteResponse } = await import("../lib/ai/write");
const { findLinkCandidates, resolveLinkTitles, asksForPageList, LINK_LIMITS } = await import("../lib/ai/link-candidates");
const { decodeLinkTargets, LINKS_HEADER } = await import("../lib/ai/links");
const { applyTitleLinks, listTitleCandidates, normalizeTitle } = await import("../lib/ai/title-links");
const { prepareAsk, ASK_LIMITS } = await import("../lib/ai/ask");
const { applyPageEdits, diffHunks, pageBlocks, pageOutline, parsePageEdits, snapshotOf } = await import("../lib/ai/page-edits");
const { suggestPageEdits, PAGE_EDIT_SYSTEM } = await import("../lib/ai/page-edit");
const { resolveSuggestions, suggestionGroups } = await import("../lib/suggestions");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import type { Node as PMNodeType } from "@tiptap/pm/model";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  vic = person("Vic");
const wid = createWorkspace(admin.id, "Homelab");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const privateSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
const html = (page: string, body: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), page);

const mock = await startOllamaMock();
after(() => mock.close());
command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
const never = new AbortController().signal;
const schema = documentSchema();
const parse = (markdown: string) => PMNode.fromJSON(schema, generateJSON(aiMarkdownToHtml(markdown, null, { raw: true }), documentExtensions)).content;
const docOf = (body: string) => PMNode.fromJSON(schema, generateJSON(body, documentExtensions));
const author = { id: ben.id, name: "Ben (KI)" };

// ---- #134: links in long lists ----

// Twelve Docker Compose pages – more than the eight candidates the prompt
// offers by handle – and pages that must not be linked.
const SERVICES = ["n8n", "Flowplan", "fredy", "openwebui", "it-tools", "Mailflow", "Pocketid", "Paperless", "Immich", "Vaultwarden", "Uptime Kuma", "Gitea"];
const servicePages = new Map<string, string>();
for (const name of SERVICES) {
  const page = createPage(wid, space, admin.id, name === "it-tools" ? "🛠️ IT-Tools" : name === "Pocketid" ? "PocketID" : name);
  html(page, `<p>Docker Compose Stack für ${name}.</p><pre><code class="language-yaml">services:\n  ${name.toLowerCase().replace(/\s/g, "")}:\n    image: ${name.toLowerCase()}</code></pre>`);
  servicePages.set(name, page);
}
const overview = createPage(wid, space, admin.id, "Homelab Übersicht");
// Two pages called "Notizen": never guessed between.
createPage(wid, space, admin.id, "Notizen");
createPage(wid, space, admin.id, "notizen");
// Ben cannot read this one; it is not linked for him even when named exactly.
const secret = createPage(wid, privateSpace, admin.id, "Geheimer Stack");
html(secret, "<p>Docker Compose GEHEIM.</p>");
const blocked = createPage(wid, space, admin.id, "Gesperrter Stack");
html(blocked, "<p>Docker Compose gesperrt.</p>");
command(admin, { action: "ai.block", targetId: blocked, kind: "page", blocked: true });

test("cause of #134: only eight pages are offered by handle, the rest arrive as plain text", async () => {
  const instruction = "Liste alle Docker-Compose-Seiten mit Links auf.";
  assert.ok(asksForPageList(instruction));
  assert.ok(asksForPageList("List all pages about Docker Compose with links"));
  assert.ok(!asksForPageList("Schreib eine Einleitung über den Umzug."));
  // Before: at most eight pages by handle – all the model could link.
  const plain = await findLinkCandidates(ben, { workspaceId: wid, pageId: overview, query: "Liste alle Docker Compose Seiten mit Links auf." });
  assert.equal(plain.targets.length, LINK_LIMITS.candidates.remote, "the budget of the handle list");
  assert.deepEqual(plain.index, [], "no index without a list request");
  // And "Docker-Compose-Seiten" as one word found even fewer.
  assert.ok((await findLinkCandidates(ben, { workspaceId: wid, pageId: overview, query: instruction })).targets.length < LINK_LIMITS.candidates.remote);
  // With the list request: every other matching page by title.
  const listed = await findLinkCandidates(ben, { workspaceId: wid, pageId: overview, query: instruction, list: true });
  const offered = new Set([...listed.targets.map((t) => t.title), ...listed.index]);
  for (const name of SERVICES) assert.ok([...offered].some((title) => normalizeTitle(title) === normalizeTitle(name === "it-tools" ? "IT-Tools" : name)), name);
  for (const title of ["Geheimer Stack", "Gesperrter Stack"]) assert.ok(!offered.has(title), title);
  assert.ok(listed.index.length <= LINK_LIMITS.index.remote);
});

test("the writing assistant sends the title index for list requests; titles come back as links", async () => {
  // The stub links two pages by handle and names the others as plain titles,
  // with a preamble and a sign-off.
  mock.answer = (request) => {
    const handle = (title: string) => request.prompt.split("\n").find((l) => l.includes(`: "${title}"`))?.split(":")[0];
    const items = SERVICES.map((name) => {
      const h = handle(name);
      return h ? `- [[${h}]]` : `- ${name === "it-tools" ? "it-tools" : name === "Pocketid" ? "**Pocketid** – Login" : name}`;
    });
    return ["Sure! Here are all Docker Compose pages:", "", ...items, "", "Let me know if you need anything else."].join("\n");
  };
  const before = mock.chats.length;
  const response = await aiWriteResponse(ben, { pageId: overview, action: "prompt", instruction: "Liste alle Docker-Compose-Seiten mit Links auf.", locale: "de", links: true }, never);
  const answer = await response.text();
  const sent = mock.chats[before];
  assert.match(sent.system, /Include every page from <pages> and <index>/);
  assert.match(sent.prompt, /<index>\n"/);
  assert.ok(!sent.prompt.includes("GEHEIM") && !sent.prompt.includes("Gesperrter Stack"));
  const targets = decodeLinkTargets(response.headers.get(LINKS_HEADER));
  // What the browser does once the answer is complete (components/ai-writer.tsx).
  const titles = listTitleCandidates(answer);
  const resolved = resolveLinkTitles(ben, { workspaceId: wid, pageId: overview, titles });
  const linked = applyTitleLinks(answer, resolved, targets);
  const out = aiMarkdownToHtml(linked.markdown, linked.targets);
  for (const name of SERVICES) assert.ok(out.includes(`href="/#page=${servicePages.get(name)}"`), `${name} is a link: ${out}`);
  // No conversation in the document, no bullet "Sure".
  assert.ok(!/Sure|Here are|Let me know/.test(out), out);
  assert.ok(out.includes("<strong>"), "the bold start stays bold");
});

test("plain titles resolve only to one page the person and the AI may read", () => {
  const resolve = (titles: string[], user = ben) => resolveLinkTitles(user, { workspaceId: wid, pageId: overview, titles });
  const found = resolve(["it-tools", "POCKETID", "Pocket ID", "  n8n.", "Notizen", "Geheimer Stack", "Gesperrter Stack", "Homelab Übersicht", "Unbekannt"]);
  const byText = new Map(found.map((r) => [r.text, r.pageId]));
  assert.equal(byText.get("it-tools"), servicePages.get("it-tools"), "emoji and case do not matter");
  assert.equal(byText.get("POCKETID"), servicePages.get("Pocketid"));
  assert.equal(byText.get("Pocket ID"), servicePages.get("Pocketid"), "without spaces when nothing else matches");
  assert.equal(byText.get("  n8n."), servicePages.get("n8n"));
  assert.ok(!byText.has("Notizen"), "two pages with that title: none is guessed");
  assert.ok(!byText.has("Geheimer Stack") && !byText.has("Gesperrter Stack"), "unreadable and AI-blocked pages stay text");
  assert.ok(!byText.has("Homelab Übersicht"), "never the page being written");
  assert.ok(!byText.has("Unbekannt"));
  // The owner of the private space may read it.
  assert.equal(new Map(resolve(["Geheimer Stack"], admin).map((r) => [r.text, r.pageId])).get("Geheimer Stack"), secret);
  // Links switched off for the person: nothing.
  command(ben, { action: "ai.settings", features: { links: false } });
  assert.deepEqual(resolve(["n8n"]), []);
  command(ben, { action: "ai.settings", features: { links: true } });
});

test("list items: whole item, bold start or text before a dash; links and code stay as they are", () => {
  const markdown = ["- n8n", "- **Gitea** – Git", "- Immich – Fotos", "- [Flowplan](https://flowplan.org)", "- `fredy`", "```", "- Paperless", "```", "Kein Listeneintrag: Mailflow"].join("\n");
  assert.deepEqual(listTitleCandidates(markdown), ["n8n", "Gitea", "Immich – Fotos", "Immich"]);
  const out = applyTitleLinks(
    markdown,
    [
      { text: "n8n", pageId: servicePages.get("n8n")!, title: "n8n" },
      { text: "Gitea", pageId: servicePages.get("Gitea")!, title: "Gitea" },
      { text: "Immich", pageId: servicePages.get("Immich")!, title: "Immich" },
    ],
    [{ handle: "P1", pageId: servicePages.get("n8n")!, title: "n8n" }],
  );
  assert.equal(out.markdown.split("\n")[0], "- [n8n](flowplan:P1)", "an offered page keeps its handle");
  assert.equal(out.markdown.split("\n")[1], "- **[Gitea](flowplan:P2)** – Git");
  assert.equal(out.markdown.split("\n")[2], "- [Immich](flowplan:P3) – Fotos");
  assert.equal(out.markdown.split("\n")[6], "- Paperless", "code stays code");
  assert.deepEqual(out.targets.map((t) => t.handle), ["P1", "P2", "P3"]);
  // Handles beyond P99 work.
  const many = applyTitleLinks("- n8n", [{ text: "n8n", pageId: servicePages.get("n8n")!, title: "n8n" }], [{ handle: "P120", pageId: overview, title: "x" }]);
  assert.match(aiMarkdownToHtml(many.markdown, many.targets), new RegExp(`href="/#page=${servicePages.get("n8n")}"`));
});

test("conversational preambles and sign-offs never reach the document", () => {
  assert.equal(cleanAnswer("Sure\n\n- n8n\n- fredy"), "- n8n\n- fredy");
  assert.equal(cleanAnswer("- Sure\n- n8n\n- fredy"), "- n8n\n- fredy", "not as a bullet of its own");
  assert.equal(cleanAnswer("Sicher! Hier ist die Liste:\n\n- n8n"), "- n8n");
  assert.equal(cleanAnswer("Sicher!\n\n- n8n"), "- n8n");
  assert.equal(cleanAnswer("Sure – here are all Docker Compose pages\n\n- n8n"), "- n8n");
  assert.equal(cleanAnswer("Gerne, hier ist der Text:\nDer Text."), "Der Text.");
  assert.equal(cleanAnswer("- n8n\n\nIch hoffe, das hilft!"), "- n8n");
  assert.equal(cleanAnswer("- n8n\n\nLet me know if you need anything else."), "- n8n");
  assert.equal(cleanAnswer("- n8n\n\nMöchtest du noch Beschreibungen ergänzen?"), "- n8n");
  // Content that only starts like chatter stays.
  assert.equal(cleanAnswer("Klar, das machen wir so.\nDann geht es weiter."), "Klar, das machen wir so.\nDann geht es weiter.");
  assert.equal(cleanAnswer("Natürlich gewachsene Strukturen sind wichtig."), "Natürlich gewachsene Strukturen sind wichtig.");
  assert.equal(cleanAnswer("Hallo Team,\n\nder Umzug ist fertig.\n\nWenn ihr noch Fragen habt, meldet euch."), "Hallo Team,\n\nder Umzug ist fertig.\n\nWenn ihr noch Fragen habt, meldet euch.");
  assert.equal(stripChatter("Sure!"), "Sure!", "an answer of nothing but chatter stays");
  assert.ok(!writePrompt({ action: "prompt", instruction: "x", locale: "de" }).system!.includes("Include every page"), "no list rules without an index");
});

// ---- #135: "Diese Seite" ----

const COMPOSE = "services:\n  db:\n    image: postgres:15\n  app:\n    image: flowplan\n    ports:\n      - 3000:3000";
const stack = createPage(wid, space, admin.id, "Compose Stack");
html(
  stack,
  `<h2>Datenbank</h2><p>Wir nutzen Postgres als Datenbank.</p><ul><li><p>Backup täglich</p></li><li><p>Monitoring mit Uptime Kuma</p></li></ul><pre><code class="language-yaml">${COMPOSE}</code></pre><p>Ende der Seite.</p>`,
);

test("“This page” goes along in full as source 1 – only what the person and the AI may read", async () => {
  const prepared = await prepareAsk(ben, { workspaceId: wid, question: "Welche Postgres-Version nutzt der Stack?", page: { pageId: stack } });
  assert.equal(prepared.nothing, false);
  assert.equal(prepared.sources[0].pageId, stack);
  assert.equal(prepared.sources[0].kind, "page");
  assert.deepEqual(prepared.page, { pageId: stack, truncated: false });
  const prompt = prepared.messages[prepared.messages.length - 1].content;
  assert.match(prompt, /<quelle nr="1" art="aktuelle-seite" titel="Compose Stack">/);
  assert.ok(prompt.includes("image: postgres:15"), "code blocks go along");
  assert.ok(prompt.includes("Backup täglich"), "lists go along");
  assert.equal(prepared.sources.filter((s) => s.pageId === stack).length, 1, "not found a second time by the search");
  // Even a question that finds nothing has the page.
  const lonely = await prepareAsk(ben, { workspaceId: wid, question: "Was steht hier?", page: { pageId: stack } });
  assert.equal(lonely.nothing, false);
  // Pages the person may not read, or the AI may not: refused.
  await assert.rejects(prepareAsk(ben, { workspaceId: wid, question: "Was steht hier?", page: { pageId: secret } }), /Berechtigung|nicht gefunden/);
  await assert.rejects(prepareAsk(ben, { workspaceId: wid, question: "Was steht hier?", page: { pageId: blocked } }), /für die KI gesperrt/);
});

test("a long page is cut to fit the model, with a note", async () => {
  const long = createPage(wid, space, admin.id, "Langes Protokoll");
  html(long, Array.from({ length: 900 }, (_, i) => `<p>Absatz ${i}: ${"Protokolltext ".repeat(8)}</p>`).join(""));
  const prepared = await prepareAsk(ben, { workspaceId: wid, question: "Fass zusammen", page: { pageId: long } });
  assert.deepEqual(prepared.page, { pageId: long, truncated: true });
  const prompt = prepared.messages[prepared.messages.length - 1].content;
  assert.match(prompt, /gekürzt="ja"/);
  assert.match(prompt, /Die Seite ist länger; der Rest fehlt hier/);
  // Ollama counts as a model on the own server: the small budget.
  const body = /<quelle nr="1"[^>]*>\n([\s\S]*?)\n\n\[…/.exec(prompt)![1];
  assert.ok(body.length <= ASK_LIMITS.pageChars.local, String(body.length));
});

// ---- #135: suggested changes ----

const storedDoc = (pageId: string) => {
  const row = one<{ state: Uint8Array }>("SELECT state FROM documents WHERE page_id=?", pageId)!;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row.state);
  const doc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
  ydoc.destroy();
  return doc;
};
const suggestionsIn = (doc: PMNodeType) => {
  const out: { kind: string; text: string; id: string; block: string }[] = [];
  doc.descendants((node, _pos, parent) => {
    const mark = node.marks.find((m) => m.type.name === "suggestion");
    if (node.isText && mark) out.push({ kind: mark.attrs.kind, text: node.text!, id: mark.attrs.id, block: parent!.type.name });
    return true;
  });
  return out;
};

test("the page as numbered blocks: every text block with a handle, code fenced", () => {
  const outline = pageOutline(storedDoc(stack), 10_000);
  assert.equal(outline.truncated, false);
  assert.match(outline.text, /^\[B1\] ## Datenbank$/m);
  assert.match(outline.text, /^\[B3\] - Backup täglich$/m);
  assert.match(outline.text, /^\[B5\] ```yaml\nservices:/m);
  assert.equal(outline.blocks.length, 6);
  const short = pageOutline(storedDoc(stack), 60);
  assert.equal(short.truncated, true);
  assert.ok(short.blocks.length < 6);
});

test("edit tags are read robustly; anything else is ignored", () => {
  const edits = parsePageEdits(
    'Hier:\n```xml\n<edit op="replace" block="B2">\nNeuer Text\n</edit>\n<edit op=insert_after block=[B3]>- Neu</edit>\n<EDIT OP="delete" BLOCK="B6"/>\n<edit op="explode" block="B1">x</edit>\n<edit op="replace">ohne Block</edit>\n```',
  );
  assert.deepEqual(edits, [
    { op: "replace", handle: "B2", content: "Neuer Text" },
    { op: "insert_after", handle: "B3", content: "- Neu" },
    { op: "delete", handle: "B6", content: "" },
  ]);
});

test("word and line differences", () => {
  assert.deepEqual(diffHunks("Wir nutzen Postgres als Datenbank.", "Wir nutzen PostgreSQL 16 als Datenbank."), [{ oldFrom: 11, oldTo: 19, newFrom: 11, newTo: 24 }]);
  assert.deepEqual(diffHunks("a\nb\nc\n", "a\nB\nc\n", "lines"), [{ oldFrom: 2, oldTo: 4, newFrom: 2, newTo: 4 }]);
  assert.deepEqual(diffHunks("gleich", "gleich"), []);
});

test("applying: words, a code block line by line, a new list item, a deletion – all as suggestions", () => {
  const doc = storedDoc(stack);
  const blocks = pageBlocks(doc).map(snapshotOf);
  const code = COMPOSE.replace("postgres:15", "postgres:16");
  const result = applyPageEdits(
    doc,
    [
      { op: "replace", handle: "B2", content: "Wir nutzen **PostgreSQL 16** als Datenbank." },
      { op: "replace", handle: "B5", content: "```yaml\n" + code + "\n```" },
      { op: "insert_after", handle: "B4", content: "- Updates mit Watchtower" },
      { op: "delete", handle: "B6", content: "" },
      { op: "replace", handle: "B99", content: "gibt es nicht" },
    ],
    blocks,
    { parse, author, now: 1 },
  );
  assert.equal(result.applied, 4);
  assert.deepEqual(result.failed, [{ handle: "B99", op: "replace", reason: "not-found" }]);
  const marks = suggestionsIn(result.doc);
  assert.ok(marks.some((m) => m.kind === "delete" && m.text === "Postgres" && m.block === "paragraph"));
  assert.ok(marks.some((m) => m.kind === "insert" && m.text === "PostgreSQL 16"));
  // The code block: only the changed line.
  assert.deepEqual(
    marks.filter((m) => m.block === "codeBlock").map((m) => [m.kind, m.text]),
    [
      ["delete", "    image: postgres:15\n"],
      ["insert", "    image: postgres:16\n"],
    ],
  );
  assert.ok(marks.some((m) => m.kind === "insert" && m.text === "Updates mit Watchtower"));
  assert.ok(marks.some((m) => m.kind === "delete" && m.text === "Ende der Seite."));
  // One suggestion per edit: four ids.
  assert.equal(new Set(marks.map((m) => m.id)).size, 4);
  // The new item is an item of the same list.
  const list = result.doc.child(2);
  assert.equal(list.type.name, "bulletList");
  assert.equal(list.childCount, 3);
  // Nothing was overwritten: the old text is all still there.
  for (const text of ["Wir nutzen Postgres", "postgres:15", "Ende der Seite."]) assert.ok(result.doc.textContent.replace(/PostgreSQL 16 /, "").includes(text) || result.doc.textContent.includes(text), text);

  // Accepting and rejecting one by one (lib/suggestions.ts).
  let state = EditorState.create({ doc: result.doc });
  const groups = suggestionGroups(state.doc);
  const codeId = groups.find((g) => g.text.includes("postgres:16"))!.id;
  state = state.apply(resolveSuggestions(state, true, (a) => a.id === codeId));
  assert.ok(state.doc.textContent.includes("postgres:16") && !state.doc.textContent.includes("postgres:15"), "the code block's change accepted");
  const itemId = groups.find((g) => g.text === "Updates mit Watchtower")!.id;
  state = state.apply(resolveSuggestions(state, false, (a) => a.id === itemId));
  assert.equal(state.doc.child(2).childCount, 2, "a rejected new list item leaves no empty item");
  const endId = groups.find((g) => g.text === "Ende der Seite.")!.id;
  state = state.apply(resolveSuggestions(state, true, (a) => a.id === endId));
  assert.ok(!state.doc.textContent.includes("Ende der Seite."));
  assert.equal(state.doc.lastChild!.type.name, "codeBlock", "an accepted deletion leaves no empty paragraph");
  // Rejecting everything that is left restores the original wording.
  state = state.apply(resolveSuggestions(state, false, () => true));
  assert.ok(state.doc.textContent.includes("Wir nutzen Postgres als Datenbank."));
});

test("a block that changed meanwhile, or text found twice, is not guessed", () => {
  const doc = docOf("<p>Gleich</p><p>Gleich</p><p>Anders</p>");
  const snapshots = pageBlocks(doc).map(snapshotOf);
  const later = docOf("<p>Neu oben</p><p>Gleich</p><p>Gleich</p><p>Anders geändert</p>");
  const result = applyPageEdits(
    later,
    [
      { op: "replace", handle: "B1", content: "Eins" },
      { op: "replace", handle: "B3", content: "Drei" },
    ],
    snapshots,
    { parse, author },
  );
  assert.equal(result.applied, 0);
  assert.deepEqual(result.failed.map((f) => f.reason), ["not-found", "not-found"]);
  // A block with an id that was edited meanwhile: "changed".
  const withId = docOf('<p data-block-id="abc12345">Alt</p>');
  const edited = docOf('<p data-block-id="abc12345">Alt, inzwischen bearbeitet</p>');
  const changed = applyPageEdits(edited, [{ op: "replace", handle: "B1", content: "Neu" }], pageBlocks(withId).map(snapshotOf), { parse, author });
  assert.deepEqual(changed.failed.map((f) => f.reason), ["changed"]);
  // Moved but unchanged: found by its id.
  const moved = docOf('<p>Davor</p><p data-block-id="abc12345">Alt</p>');
  const found = applyPageEdits(moved, [{ op: "replace", handle: "B1", content: "Neu" }], pageBlocks(withId).map(snapshotOf), { parse, author });
  assert.equal(found.applied, 1);
});

test("“Suggest as changes”: the stub model's edits land in the stored page as suggestions", async () => {
  mock.answer = (request) =>
    request.system === PAGE_EDIT_SYSTEM
      ? `<edit op="replace" block="B5">\n\`\`\`yaml\n${COMPOSE.replace("postgres:15", "postgres:16")}\n\`\`\`\n</edit>\n<edit op="replace" block="B42">gibt es nicht</edit>`
      : "OK";
  const before = mock.chats.length;
  const history = [
    { role: "user" as const, content: "Stell den Stack auf Postgres 16 um." },
    { role: "assistant" as const, content: "So sieht der Codeblock dann aus:\n\n```yaml\n" + COMPOSE.replace("postgres:15", "postgres:16") + "\n```" },
  ];
  const result = await suggestPageEdits(ben, { workspaceId: wid, pageId: stack, history }, never);
  assert.deepEqual(result, { proposed: 1, applied: 1, failed: 0, reasons: [] }, "a handle that was never offered is dropped");
  const sent = mock.chats[before];
  assert.match(sent.prompt, /\[B5\] ```yaml/);
  assert.match(sent.prompt, /Stell den Stack auf Postgres 16 um/);
  const marks = suggestionsIn(storedDoc(stack));
  assert.deepEqual(marks.map((m) => [m.kind, m.text]), [
    ["delete", "    image: postgres:15\n"],
    ["insert", "    image: postgres:16\n"],
  ]);
  const name = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", stack)!.html;
  assert.match(name, /data-suggestion-name="Ben \(KI\)"/);
  // Nothing proposed: nothing changes.
  mock.answer = () => "<none/>";
  assert.deepEqual(await suggestPageEdits(ben, { workspaceId: wid, pageId: stack, history }, never), { proposed: 0, applied: 0, failed: 0, reasons: [] });
});

test("suggested changes need edit rights, an unlocked document and a page the AI may read", async () => {
  mock.answer = () => '<edit op="delete" block="B1"></edit>';
  const history = [{ role: "user" as const, content: "Lösch die Überschrift." }];
  const calls = mock.chats.length;
  await assert.rejects(suggestPageEdits(vic, { workspaceId: wid, pageId: stack, history }, never), /Berechtigung/);
  await assert.rejects(suggestPageEdits(ben, { workspaceId: wid, pageId: secret, history }, never), /Berechtigung|nicht gefunden/);
  await assert.rejects(suggestPageEdits(ben, { workspaceId: wid, pageId: blocked, history }, never), /für die KI gesperrt/);
  const locked = createPage(wid, space, admin.id, "Gesperrt zum Lesen");
  run("UPDATE pages SET locked=1 WHERE id=?", locked);
  await assert.rejects(suggestPageEdits(ben, { workspaceId: wid, pageId: locked, history }, never), /gesperrt/);
  assert.equal(mock.chats.length, calls, "no request reached the model");
});
