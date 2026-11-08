// Workflows wave 3 (#168, docs/specs/workflows.md §10.6–10.8, §11): the six
// templates with their gaps, the AI builder with fixed mock answers (ten
// sentences), JSON export and import with reference mapping and without
// secrets, workflows paused after an instance move, the REST routes and
// their token rules, the MCP tools, the workflow button on a page and who
// may press it. On SQLite and PostgreSQL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-api-"));
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_AI;
const { run, one, all } = await import("../lib/db");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { startOllamaMock } = await import("./helpers/ai-mock");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { handleMcpMessage, mcpToolNames } = await import("../lib/mcp");
const { workflowTemplates, TEMPLATE_IDS, missingGaps, fillTokens } = await import("../lib/workflows/templates");
const { checkGraph, parseGraph } = await import("../lib/workflows/graph");
const { aiDraftWorkflow, sanitizeAiGraph } = await import("../lib/workflows/ai-builder");
const { workflowPost } = await import("../lib/workflows/rest");
const { pauseMovedWorkflows } = await import("../lib/instance-move-pull");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const S = await import("./helpers/workflow-setup");
const { act, get, owner, editor, viewer, guest, node, edge, chain, workflow, runsOf, stepsOf, makeDatabase, wid, space } = S;
import type { Field, Identity } from "../lib/types";
import type { WorkflowGraph } from "../lib/workflows/graph";

const admin = { ...owner, isAdmin: true };
const mock = await startOllamaMock();
after(() => mock.close());
await act({ action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } }, admin);

const ticketFields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "category", name: "Kategorie", type: "select", options: ["Bug", "Frage", "Wunsch"] },
  { id: "owner", name: "Owner", type: "person" },
  { id: "due", name: "Due", type: "date" },
  { id: "doneAt", name: "Done at", type: "date" },
  { id: "body", name: "Body", type: "text" },
];
const dbId = await makeDatabase("Tickets", ticketFields);
await act({ action: "form.update", pageId: dbId, enabled: true, internal: true });
const overview = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Docker Compose Sammlung" })).id as string;
const reports = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Berichte" })).id as string;
const de = (a: string) => a;
const fieldsOf = (id: string) => (id === dbId ? ticketFields : undefined);
const ctx = { t: de, timeZone: "Europe/Berlin", fields: fieldsOf };
const newWorkflowPage = async (title: string, who: Identity = owner) => (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title }, who)).id as string;

/* ---------- Templates ---------- */

test("each of the six templates fills its gaps, checks without errors and activates", async () => {
  const templates = workflowTemplates(de);
  assert.deepEqual(templates.map((x) => x.id), [...TEMPLATE_IDS]);
  for (const tpl of templates) {
    const pageId = await newWorkflowPage(tpl.name);
    // The e-mail template needs an address that goes to this workflow (made by an owner).
    const address = tpl.id === "mail-ticket" ? ((await act({ action: "inbound.save", workspaceId: wid, pageId, label: "Support", senders: ["kunde@example.com"] })) as { id: string }).id : "";
    const answers: Record<string, unknown> = {
      overview,
      database: dbId,
      due: "due",
      assignee: "owner",
      status: "status",
      done: "Done",
      category: "category",
      routing: { Bug: editor.id, Frage: owner.id },
      lead: owner.id,
      doneDate: "doneAt",
      parent: reports,
      address,
      description: "body",
    };
    assert.deepEqual(missingGaps(tpl.gaps, answers), [], tpl.id);
    assert.ok(missingGaps(tpl.gaps, {}).length > 0, `${tpl.id} asks for something`);
    const graph = tpl.build(answers, ctx);
    assert.deepEqual(checkGraph(parseGraph(graph)).filter((i) => i.level === "error"), [], tpl.id);
    const saved = await act({ action: "workflow.draft", pageId, graph });
    assert.deepEqual(saved.issues.filter((i: { level: string }) => i.level === "error"), [], `${tpl.id}: ${JSON.stringify(saved.issues)}`);
    const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "sample" } });
    assert.equal(dry.ok, true, tpl.id);
    await drainWorkflows();
    const dryRun = await one<{ status: string; error: string | null }>("SELECT status,error FROM workflow_runs WHERE id=?", dry.runId);
    assert.equal(dryRun!.status, "succeeded", `${tpl.id}: ${dryRun!.error} ${JSON.stringify(await stepsOf(dry.runId))}`);
    const activated = await act({ action: "workflow.activate", pageId });
    assert.equal(activated.ok, true, `${tpl.id}: ${JSON.stringify(activated.issues)}`);
  }
  await drainWorkflows();
});

test("the issue's template runs end to end: a new sub-page is linked on the overview with a summary", async () => {
  mock.answer = () => "Ein Reverse Proxy mit automatischen Zertifikaten.";
  const tpl = workflowTemplates(de).find((x) => x.id === "subpages-overview")!;
  const target = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Übersicht 2" })).id as string;
  const { pageId } = await workflow("Unterseiten verlinken", tpl.build({ overview: target, summary: true }, ctx));
  await act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: target, kind: "document", title: "Traefik" });
  await drainWorkflows();
  const [r] = await runsOf(pageId);
  assert.equal(r.status, "succeeded", r.error || "");
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", target))!.html;
  assert.match(html, /Traefik/);
  assert.match(html, /Reverse Proxy/);
});

test("the triage template routes by category without a router per option it does not know", async () => {
  const tpl = workflowTemplates(de).find((x) => x.id === "form-triage")!;
  const graph = tpl.build({ database: dbId, category: "category", assignee: "owner", routing: { Bug: editor.id, Unbekannt: owner.id }, lead: owner.id }, ctx);
  const sw = graph.nodes.find((n) => n.type === "logic.switch")!;
  assert.deepEqual((sw.config.cases as { value: string }[]).map((c) => c.value), ["Bug"]);
  const plain = tpl.build({ database: dbId, category: "category", lead: owner.id }, ctx);
  assert.ok(!plain.nodes.some((n) => n.type === "logic.switch"));
  assert.deepEqual(checkGraph(plain).filter((i) => i.level === "error"), []);
});

test("gap tokens of an import are filled anywhere, also in keys and inside strings", () => {
  const g = parseGraph({
    nodes: [
      { id: "n_trigger1", type: "trigger.record.created", label: "T", config: { database: "$ask:db" } },
      { id: "n_update1", type: "action.record.update", label: "U", config: { values: { "$ask:f": "x" } } },
      { id: "n_notify1", type: "notify.person", label: "N", config: { to: ["field:$ask:p"] } },
    ],
    edges: [],
  });
  const filled = fillTokens(g, { db: dbId, f: "title", p: "owner" });
  assert.equal(filled.nodes[0].config.database, dbId);
  assert.deepEqual(filled.nodes[1].config.values, { title: "x" });
  assert.deepEqual(filled.nodes[2].config.to, ["field:owner"]);
});

/* ---------- AI builder ---------- */

// Ten sentences and what the (mock) model answers to each.
const sentences: [string, (p: string) => unknown][] = [
  [
    "Wenn unter Docker Compose Sammlung eine Seite entsteht, trage sie mit einem Satz Beschreibung auf der Übersicht ein",
    () => ({
      title: "Compose verlinken",
      nodes: [
        { id: "1", type: "trigger.page.created", label: "Neue Seite", config: { scope: { kind: "below", pageId: overview, depth: "children" }, kinds: ["document"] } },
        { id: "2", type: "ai.summarize", label: "Ein Satz", config: { text: "{{1.page.text}}", length: "sentence" } },
        { id: "3", type: "action.page.append", label: "Eintragen", config: { page: overview, blocks: [{ type: "bullet", text: "{{1.page.link}} – {{2.summary}}" }], noDuplicate: true } },
      ],
      edges: [{ from: "1", to: "2" }, { from: "2", to: "3", port: "out" }],
    }),
  ],
  ["Erinnere die Verantwortlichen zwei Tage vor Fälligkeit", () => ({ nodes: [{ id: "a", type: "trigger.record.date", config: { database: dbId, field: "due", offsetDays: -2, time: "09:00" } }, { id: "b", type: "notify.person", config: { to: ["field:owner"], title: "Bald fällig: {{a.record.title}}" } }], edges: [{ from: "a", to: "b" }] })],
  ["Wenn ein Ticket erledigt ist, setze das Erledigt-Datum auf heute", () => ({ nodes: [{ id: "t", type: "trigger.record.done", config: { database: dbId } }, { id: "u", type: "action.record.update", config: { values: { doneAt: "@today" } } }], edges: [{ from: "t", to: "u" }] })],
  [
    "Ordne jede Formularantwort mit KI einer Kategorie zu",
    () => ({ nodes: [{ id: "f", type: "trigger.form.submitted", config: { database: dbId } }, { id: "c", type: "ai.classify", config: { text: "{{f.record.title}}", source: "field", database: dbId, field: "category" } }, { id: "u", type: "action.record.update", config: { values: { category: "{{c.category}}" } } }], edges: [{ from: "f", to: "c" }, { from: "c", to: "u", port: "out" }] }),
  ],
  ["Jeden Freitag um 15 Uhr eine Zusammenfassung der Woche", () => ({ nodes: [{ id: "s", type: "trigger.schedule", config: { freq: "weekly", weekday: 5, time: "15:00" } }, { id: "f", type: "action.record.find", config: { database: dbId, filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: "doneAt", op: "in_relative", value: "this_week" }] } } }, { id: "p", type: "action.page.create", config: { parent: reports, title: "Woche", blocks: [{ type: "paragraph", text: "{{f.count}} erledigt" }] } }], edges: [{ from: "s", to: "f" }, { from: "f", to: "p" }] })],
  ["Wenn ein Bug angelegt wird, benachrichtige mich", () => ({ nodes: [{ id: "t", type: "trigger.record.created", config: { database: dbId } }, { id: "i", type: "logic.if", config: { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: "{{t.record.fields.category}}", op: "eq", value: "Bug" }] } } }, { id: "n", type: "notify.person", config: { to: ["@runner"], title: "Neuer Bug" } }], edges: [{ from: "t", to: "i" }, { from: "i", to: "n", port: "true" }] })],
  ["Ein Knopf, der ein Ticket mit dem eingegebenen Titel anlegt", () => ({ nodes: [{ id: "m", type: "trigger.manual", config: { inputs: [{ name: "Titel", type: "text", required: true }] } }, { id: "c", type: "action.record.create", config: { database: dbId, values: { title: "{{m.inputs.Titel}}" } } }], edges: [{ from: "m", to: "c" }] })],
  // Invented ids, an unknown node type, a property that does not exist.
  ["Wenn ein Kommentar kommt, hänge ihn an die Seite Protokoll an", () => ({ nodes: [{ id: "k", type: "trigger.comment.created", config: {} }, { id: "x", type: "code.javascript", config: { code: "rm -rf /" } }, { id: "a", type: "action.page.append", config: { page: "00000000-0000-4000-8000-000000000000", blocks: [{ type: "paragraph", text: "{{k.comment.text}}" }] } }], edges: [{ from: "k", to: "x" }, { from: "k", to: "a" }] })],
  ["Wenn sich der Status ändert und Wartezeit, dann warte einen Tag und frag Anna um Freigabe", () => ({ nodes: [{ id: "t", type: "trigger.record.changed", config: { database: dbId, fields: ["status", "nope"] } }, { id: "w", type: "logic.wait", config: { mode: "duration", amount: 1, unit: "days" } }, { id: "a", type: "logic.approval", config: { approvers: ["@runner"], message: "Okay?" } }, { id: "n", type: "notify.person", config: { to: ["@actor"], title: "Genehmigt" } }], edges: [{ from: "t", to: "w" }, { from: "w", to: "a" }, { from: "a", to: "n", port: "approved" }, { from: "a", to: "n", port: "nonsense" }] })],
  ["Lege für jede neue Mail im Postfach ein Ticket an", () => ({ nodes: [{ id: 1, type: "trigger.mail.received", config: {} }, { id: 2, type: "ai.extract", config: { text: "{{1.mail.text}}", fields: [{ name: "title" }] } }, { id: 3, type: "action.record.create", config: { database: dbId, values: { title: "{{2.fields.title}}", invented: "x" } } }], edges: [{ from: 1, to: 2 }, { from: 2, to: 3 }] })],
];

test("the AI builder turns ten sentences into valid drafts and never activates them", async () => {
  const pageId = await newWorkflowPage("KI-Entwurf");
  const before = await get(`workflows/${pageId}`);
  for (const [sentence, answer] of sentences) {
    mock.answer = (req) => JSON.stringify(answer(req.prompt));
    const out = await aiDraftWorkflow(owner, { pageId, prompt: sentence, locale: "de" });
    const graph = parseGraph(out.graph);
    const errors = checkGraph(graph).filter((i) => i.level === "error" && i.code !== "invalid_config");
    assert.deepEqual(errors, [], `${sentence}: ${JSON.stringify(errors)}`);
    assert.equal(graph.nodes.filter((n) => n.type.startsWith("trigger.")).length, 1, sentence);
    assert.ok(graph.nodes.every((n) => /^n_ai\d{4}$/.test(n.id)));
    // Sent: the sentence and the metadata, fenced.
    assert.ok(mock.chats.at(-1)!.prompt.includes(sentence));
  }
  // The invented page id is cleared, the unknown type and the wrong port dropped.
  mock.answer = (req) => JSON.stringify(sentences[7][1](req.prompt));
  const comment = await aiDraftWorkflow(owner, { pageId, prompt: sentences[7][0], locale: "de" });
  assert.deepEqual(comment.dropped, ["code.javascript"]);
  assert.equal(comment.graph.nodes.find((n: { type: string }) => n.type === "action.page.append")!.config.page, "");
  assert.ok(comment.gaps.length >= 1);
  mock.answer = (req) => JSON.stringify(sentences[8][1](req.prompt));
  const approval = await aiDraftWorkflow(owner, { pageId, prompt: sentences[8][0], locale: "de" });
  assert.equal(approval.graph.edges.length, 3);
  assert.deepEqual(approval.graph.nodes[0].config.fields, ["status"]);
  mock.answer = (req) => JSON.stringify(sentences[9][1](req.prompt));
  const mail = await aiDraftWorkflow(owner, { pageId, prompt: sentences[9][0], locale: "de" });
  assert.deepEqual(Object.keys(mail.graph.nodes[2].config.values as object), ["title"]);
  // Nothing written, nothing activated.
  const afterwards = await get(`workflows/${pageId}`);
  assert.equal(afterwards.status, "draft");
  assert.deepEqual(afterwards.draft.graph, before.draft.graph);
});

test("the AI builder sees only what the person and the AI may read", async () => {
  // A private space of the owner: the editor's prompt must not name it.
  const { id } = await import("../lib/db");
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", privateSpace, wid, "Privat", "", "private", owner.id);
  const secret = (await act({ action: "page.create", workspaceId: wid, spaceId: privateSpace, kind: "document", title: "Geheimes Gehaltsdokument" })).id as string;
  const pageId = await newWorkflowPage("KI des Editors", editor);
  mock.answer = () => JSON.stringify({ nodes: [{ id: "1", type: "trigger.page.created", config: { scope: { kind: "below", pageId: secret } } }], edges: [] });
  const out = await aiDraftWorkflow(editor, { pageId, prompt: "Wenn unter dem Gehaltsdokument etwas entsteht", locale: "de" });
  const prompt = mock.chats.at(-1)!.prompt;
  assert.ok(!prompt.includes("Geheimes Gehaltsdokument"));
  assert.ok(!prompt.includes(secret));
  assert.ok(prompt.includes("Docker Compose Sammlung"));
  // The id it was not given is cleared.
  assert.equal((out.graph.nodes[0].config.scope as { pageId: string }).pageId, "");
  // Viewers and guests cannot use it.
  await assert.rejects(() => aiDraftWorkflow(viewer, { pageId, prompt: "Irgendwas bauen", locale: "de" }), /Berechtigung|nicht gefunden/);
  await assert.rejects(() => aiDraftWorkflow(guest, { pageId, prompt: "Irgendwas bauen", locale: "de" }), /nicht gefunden/);
});

test("sanitizing an answer without a usable node fails clearly", () => {
  assert.throws(() => sanitizeAiGraph({ nodes: [{ id: "1", type: "nope" }], edges: [] }, { databases: [], pages: [], spaces: [], chatHooks: [] }), /keinen brauchbaren/);
});

/* ---------- Export, import, instance move ---------- */

test("export → import elsewhere: references mapped by title and name, secrets never in the file, a draft", async () => {
  const t = node("trigger.record.created", { database: dbId }, "Neu");
  const http = node("http.request", { method: "POST", url: "https://api.example.com/hook", bodyKind: "json", body: '{"t":"{{' + t.id + '.record.title}}"}', credential: "" }, "Melden");
  const tell = node("notify.person", { to: [editor.id, "field:owner"], title: "{{" + t.id + ".record.fields.category}}" }, "Sagen");
  const upd = node("action.record.update", { values: { category: "Bug", body: "x" } }, "Setzen");
  const hook = node("trigger.webhook", { mode: "signed" }, "Webhook");
  const { pageId } = await workflow("Export", { nodes: [t, http, tell, upd, hook], edges: [edge(t, http), edge(http, tell), edge(tell, upd)] }, owner, false);
  const cred = await act({ action: "workflow.credential.set", pageId, name: "GitHub-Token", kind: "bearer", host: "api.example.com", secret: { token: "ghp_SUPERSECRET123" } });
  const graph = (await get(`workflows/${pageId}`)).draft.graph as WorkflowGraph;
  graph.nodes.find((n) => n.id === http.id)!.config.credential = cred.id;
  await act({ action: "workflow.draft", pageId, graph });
  const hookView = await act({ action: "workflow.hook", pageId, nodeId: hook.id });
  const file = await get(`workflows/${pageId}/export`);
  const text = JSON.stringify(file);
  assert.equal(file.format, "flowplan.workflow");
  assert.equal(file.source.instance, "https://flowplan.example.test");
  assert.ok(!text.includes("ghp_SUPERSECRET123"));
  assert.ok(!text.includes(hookView.hook.secret));
  assert.ok(!text.includes(hookView.hook.url.split("/").pop()));
  assert.deepEqual(file.references[cred.id], { kind: "credential", title: "GitHub-Token", credentialKind: "bearer", host: "api.example.com" });
  assert.equal(file.references[dbId].kind, "database");
  assert.equal(file.references[editor.id].kind, "person");
  // Readers export what runs – nothing yet.
  await assert.rejects(() => get(`workflows/${pageId}/export`, viewer), /noch nicht aktiviert/);

  // Another workspace (the other instance's view): the database by title, its properties by name.
  const other = await createWorkspace(owner.id, "Woanders");
  const otherSpace = (await bootstrap(owner, other)).spaces[0].id as string;
  const otherDb = (await act({ action: "page.create", workspaceId: other, spaceId: otherSpace, kind: "database", title: "Tickets" })).id as string;
  const { database } = await import("../lib/api");
  const renamed: Field[] = [
    { id: "t2", name: "Title", type: "text" },
    { id: "k2", name: "Kategorie", type: "select", options: ["Bug", "Frage"] },
    { id: "o2", name: "Owner", type: "person" },
  ];
  await act({ action: "database.update", pageId: otherDb, version: (await database(otherDb)).version, fields: renamed, views: (await database(otherDb)).views });
  const preview = (await workflowPost(owner, ["workflows", "import"], { workspaceId: other, spaceId: otherSpace, data: file, preview: true })) as { unresolved: { id: string; kind: string }[] };
  const kinds = preview.unresolved.map((u) => u.kind).sort();
  // The editor is no member there, the credential and the body property stay open.
  assert.deepEqual(kinds, ["credential", "field", "person"]);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=? AND kind='workflow'", other))!.n), 0, "a preview writes nothing");
  const imported = (await workflowPost(owner, ["workflows", "import"], { workspaceId: other, spaceId: otherSpace, data: JSON.parse(text) })) as { id: string; unresolved: unknown[] };
  const state = await get(`workflows/${imported.id}`);
  assert.equal(state.status, "draft");
  const g = state.draft.graph as WorkflowGraph;
  assert.equal(g.nodes.find((n) => n.type === "trigger.record.created")!.config.database, otherDb);
  assert.deepEqual(g.nodes.find((n) => n.type === "notify.person")!.config.to, ["field:o2"]);
  assert.equal(g.nodes.find((n) => n.type === "notify.person")!.config.title, `{{${t.id}.record.fields.k2}}`);
  assert.deepEqual(g.nodes.find((n) => n.type === "action.record.update")!.config.values, { k2: "Bug" });
  assert.equal(g.nodes.find((n) => n.type === "http.request")!.config.credential, "");
  assert.equal(await one("SELECT 1 FROM workflow_credentials WHERE page_id=?", imported.id), undefined);
  assert.equal(await one("SELECT 1 FROM workflow_hooks WHERE page_id=?", imported.id), undefined);
  // A mapping chosen by the person wins.
  const mapped = (await workflowPost(owner, ["workflows", "import"], { workspaceId: wid, spaceId: space, data: file, mapping: { [dbId]: dbId, [editor.id]: viewer.id } })) as { id: string };
  assert.deepEqual((await get(`workflows/${mapped.id}`)).draft.graph.nodes.find((n: { type: string }) => n.type === "notify.person").config.to, [viewer.id, "field:owner"]);
});

test("imports refuse what is not a workflow, a newer format and pages the person cannot read", async () => {
  const pageId = await newWorkflowPage("Ziel");
  await assert.rejects(() => act({ action: "workflow.import", pageId, data: { hello: "world" } }), /Keine Workflow-Datei/);
  await assert.rejects(() => act({ action: "workflow.import", pageId, data: { format: "flowplan.workflow", version: 99, graph: { nodes: [], edges: [] } } }), /neueren Flowplan-Version/);
  // A bare graph is fine; an id of a page in another workspace is cleared.
  const foreign = await createWorkspace(owner.id, "Fremd");
  const foreignPage = (await act({ action: "page.create", workspaceId: foreign, spaceId: (await bootstrap(owner, foreign)).spaces[0].id, kind: "document", title: "Fremd" })).id as string;
  const bare = { nodes: [{ id: "n_aaaaaa", type: "trigger.manual", label: "Los", config: {} }, { id: "n_bbbbbb", type: "action.page.append", label: "Anhängen", config: { page: foreignPage, blocks: [{ type: "paragraph", text: "x" }] } }], edges: [{ id: "e_1", from: { node: "n_aaaaaa", port: "out" }, to: { node: "n_bbbbbb", port: "in" } }] };
  const out = await act({ action: "workflow.import", pageId, data: bare });
  assert.equal(out.ok, true);
  assert.equal((await get(`workflows/${pageId}`)).draft.graph.nodes[1].config.page, "");
  // Not over an existing draft unless asked; never as a viewer.
  await assert.rejects(() => act({ action: "workflow.import", pageId, data: bare }), /nicht leer/);
  await assert.rejects(() => act({ action: "workflow.import", pageId, data: bare, replace: true }, viewer), /Berechtigung|nicht gefunden/);
  assert.equal((await get(`workflows/${pageId}`)).status, "draft");
});

test("after an instance move, active workflows arrive paused with their runs held", { skip: !!process.env.DATABASE_URL && "the move copies a SQLite file" }, async () => {
  const t = node("trigger.manual", {}, "Start");
  const w = node("logic.wait", { mode: "duration", amount: 1, unit: "days" }, "Warten");
  const { pageId } = await workflow("Umzug", chain(t, w));
  await S.manual(pageId);
  await drainWorkflows();
  assert.equal((await runsOf(pageId))[0].status, "waiting");
  const copy = join(process.env.FLOWPLAN_DATA_DIR!, "moved.sqlite");
  await run(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  assert.ok(existsSync(copy));
  assert.ok(pauseMovedWorkflows(copy) >= 1);
  const { DatabaseSync } = await import("node:sqlite");
  const moved = new DatabaseSync(copy, { readOnly: true });
  const wf = moved.prepare("SELECT status,pause_reason FROM workflows WHERE page_id=?").get(pageId) as { status: string; pause_reason: string };
  assert.equal(wf.status, "paused");
  assert.match(wf.pause_reason, /Instanzumzug/);
  assert.equal((moved.prepare("SELECT status FROM workflow_runs WHERE page_id=?").get(pageId) as { status: string }).status, "held");
  assert.equal(moved.prepare("SELECT 1 FROM workflow_triggers WHERE page_id=?").get(pageId), undefined);
  assert.equal((moved.prepare("SELECT COUNT(*) n FROM workflows WHERE status='active'").get() as { n: number }).n, 0);
  moved.close();
});

/* ---------- REST and tokens ---------- */

async function tokenFor(user: Identity, scope: "read" | "write") {
  const { token } = (await act({ action: "token.create", name: `T ${scope}`, scope }, user)) as { token: string };
  return (await identityFromApiToken(`Bearer ${token}`))!;
}
const ownerWrite = await tokenFor(owner, "write");
const ownerRead = await tokenFor(owner, "read");

test("REST: a write token drafts, tests, activates and starts; read tokens and approvals by token are refused", async () => {
  const pageId = await newWorkflowPage("REST");
  const t = node("trigger.manual", { inputs: [{ name: "Titel", type: "text", required: true }] }, "Start");
  const c = node("action.record.create", { database: dbId, values: { title: `{{${t.id}.inputs.Titel}}` } }, "Anlegen");
  const draft = (await workflowPost(ownerWrite, ["workflows", pageId, "draft"], { graph: chain(t, c) })) as { ok: boolean; issues: unknown[] };
  assert.equal(draft.ok, true);
  const tested = (await workflowPost(ownerWrite, ["workflows", pageId, "test"], { mode: "dry", data: { kind: "custom", output: { inputs: { Titel: "Probe" } } } })) as { ok: boolean; runId: string };
  assert.equal(tested.ok, true);
  const activated = (await workflowPost(ownerWrite, ["workflows", pageId, "activate"], { note: "per API" })) as { ok: boolean; number: number };
  assert.equal(activated.ok, true);
  assert.equal(activated.number, 1);
  const started = (await workflowPost(ownerWrite, ["workflows", pageId, "run"], { inputs: { Titel: "Per API" } })) as { ok: boolean };
  assert.equal(started.ok, true);
  await drainWorkflows();
  const live = (await runsOf(pageId)).filter((r) => r.mode === "live");
  assert.equal(live.length, 1);
  assert.equal(live[0].status, "succeeded");
  const event = await one<{ payload: string }>("SELECT payload FROM workflow_events WHERE kind='manual' AND scope_id=? ORDER BY created_at DESC LIMIT 1", pageId);
  assert.equal(JSON.parse(event!.payload).source, "api");
  // Read tokens: the command refuses them (the POST handler before that).
  await assert.rejects(() => workflowPost(ownerRead, ["workflows", pageId, "pause"], {}), /nur lesen/);
  await assert.rejects(() => workflowPost(ownerWrite, ["workflow-approvals", "00000000-0000-4000-8000-000000000000"], { decision: "approved" }), /nur angemeldet/);
  const paused = (await workflowPost(ownerWrite, ["workflows", pageId, "pause"], { cancelRuns: true })) as { ok: boolean };
  assert.equal(paused.ok, true);
  assert.equal((await get(`workflows/${pageId}`)).status, "paused");
  assert.equal(await workflowPost(ownerWrite, ["workflows", pageId, "unknown"], {}), undefined);
});

/* ---------- MCP ---------- */

let rpcId = 0;
async function call(user: Identity, name: string, args: Record<string, unknown>) {
  const answer = (await handleMcpMessage(user, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })) as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };
  if (answer.error) return { error: true, text: answer.error.message, json: null };
  const text = answer.result!.content[0].text;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!answer.result!.isError, text, json: json as any };
}

test("MCP: the workflow tools read, draft, test and start – never activate or approve", async () => {
  const names = mcpToolNames(ownerWrite);
  for (const n of ["list_workflows", "get_workflow", "get_workflow_catalog", "save_workflow_draft", "test_workflow", "run_workflow", "list_workflow_runs", "get_workflow_run"]) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /activate|approv/.test(n)));
  const readNames = mcpToolNames(ownerRead);
  assert.deepEqual(readNames.filter((n) => n.includes("workflow")).sort(), ["get_workflow", "get_workflow_catalog", "get_workflow_run", "list_workflow_runs", "list_workflows"]);

  const catalog = await call(ownerRead, "get_workflow_catalog", {});
  assert.ok(catalog.json, catalog.text.slice(0, 300));
  assert.ok(catalog.json.nodes.some((n: { type: string }) => n.type === "trigger.manual"));
  // A new workflow page with a draft.
  const t = node("trigger.manual", {}, "Los");
  const c = node("action.record.create", { database: dbId, values: { title: "Per MCP" } }, "Anlegen");
  const saved = await call(ownerWrite, "save_workflow_draft", { workspaceId: wid, spaceId: space, title: "MCP-Workflow", graph: chain(t, c) });
  assert.equal(saved.error, false, saved.text);
  const pageId = saved.json.pageId as string;
  assert.deepEqual(saved.json.issues.filter((i: { level: string }) => i.level === "error"), []);
  assert.equal((await get(`workflows/${pageId}`)).status, "draft", "a draft, never active");
  // The same page again.
  const again = await call(ownerWrite, "save_workflow_draft", { pageId, graph: chain(t, c) });
  assert.equal(again.json.pageId, pageId);
  assert.equal((await call(ownerWrite, "save_workflow_draft", { graph: chain(t, c) })).error, true);
  // Read tokens cannot write.
  assert.equal((await call(ownerRead, "save_workflow_draft", { pageId, graph: chain(t, c) })).error, true);
  const listed = await call(ownerRead, "list_workflows", { workspaceId: wid });
  assert.ok(listed.json.workflows.some((w: { pageId: string }) => w.pageId === pageId));
  const read = await call(ownerRead, "get_workflow", { pageId });
  assert.equal(read.error, false);
  assert.equal(read.json.draft, null, "a read token sees no draft");
  const full = await call(ownerWrite, "get_workflow", { pageId });
  assert.ok(full.json.draft, full.text.slice(0, 500));
  assert.equal(full.json.draft.graph.nodes.length, 2);
  assert.equal(full.json.draft.state, undefined);
  // Test (dry by default).
  const tested = await call(ownerWrite, "test_workflow", { pageId });
  assert.equal(tested.json.ok, true, tested.text);
  await drainWorkflows();
  const runs = await call(ownerRead, "list_workflow_runs", { pageId, mode: "test" });
  assert.equal(runs.json.runs[0].mode, "dry");
  const detail = await call(ownerRead, "get_workflow_run", { runId: runs.json.runs[0].id });
  assert.equal(detail.json.status, "succeeded");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=? AND cells LIKE '%Per MCP%'", dbId))!.n), 0, "dry runs write nothing");
  // Not active: run_workflow refuses; activated by a person, it starts.
  assert.equal((await call(ownerWrite, "run_workflow", { pageId })).error, true);
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  const started = await call(ownerWrite, "run_workflow", { pageId, inputs: {} });
  assert.equal(started.json.ok, true, started.text);
  await drainWorkflows();
  assert.equal((await runsOf(pageId)).filter((r) => r.mode === "live")[0].status, "succeeded");
  assert.equal((await call(ownerRead, "run_workflow", { pageId })).error, true);
});

/* ---------- The workflow button on a page ---------- */

test("the workflow button: editors by default, members who see its page when allowed, never guests", async () => {
  const t = node("trigger.manual", { inputs: [{ name: "Notiz", type: "text", required: false }], who: "editors" }, "Knopf");
  const c = node("action.record.create", { database: dbId, values: { title: `{{${t.id}.inputs.Notiz}}` } }, "Anlegen");
  const { pageId } = await workflow("Knopf-Workflow", chain(t, c));
  // The workflow page is only shared with the owner (a private space); the host page is readable by all.
  const { id } = await import("../lib/db");
  const hidden = id();
  await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", hidden, wid, "Nur ich", "", "private", owner.id);
  await act({ action: "page.move", pageId, spaceId: hidden, parentId: null });
  const host = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Mit Knopf" })).id as string;
  const noButton = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Ohne Knopf" })).id as string;
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>Start:</p><div data-workflow-button="${pageId}" data-label="Los" class="workflow-button-block">Los</div>`, host);
  const info = await get(`workflows/${pageId}/start?host=${host}`, viewer);
  assert.equal(info.may, false, "editors only");
  assert.equal(info.title, null, "the title stays with those who read the workflow");
  await assert.rejects(() => act({ action: "workflow.run", pageId, source: "block", host, inputs: {} }, viewer), /Berechtigung/);
  // Switched to members: the viewer may start it from the page with the button.
  const graph = (await get(`workflows/${pageId}`)).draft.graph as WorkflowGraph;
  graph.nodes[0].config.who = "members";
  await S.redraft(pageId, graph);
  assert.equal((await get(`workflows/${pageId}/start?host=${host}`, viewer)).may, true);
  const started = await act({ action: "workflow.run", pageId, source: "block", host, inputs: { Notiz: "vom Knopf" } }, viewer);
  assert.equal(started.ok, true);
  await drainWorkflows();
  const live = (await runsOf(pageId)).filter((r) => r.mode === "live").at(-1)!;
  assert.equal(live.status, "succeeded");
  const trigger = (await stepsOf(live.id))[0];
  assert.equal(JSON.parse(trigger.output!).startedBy.id, viewer.id);
  // Not from a page without the button, not without a page, never as a guest or with a read token.
  await assert.rejects(() => act({ action: "workflow.run", pageId, source: "block", host: noButton, inputs: {} }, viewer), /nicht gefunden/);
  await assert.rejects(() => act({ action: "workflow.run", pageId, inputs: {} }, viewer), /nicht gefunden/);
  await assert.rejects(() => get(`workflows/${pageId}/start?host=${host}`, guest), /nicht gefunden/);
  await assert.rejects(() => act({ action: "workflow.run", pageId, source: "block", host, inputs: {} }, guest), /nicht gefunden/);
  const viewerRead = await tokenFor(viewer, "read");
  await assert.rejects(() => act({ action: "workflow.run", pageId, source: "block", host, inputs: {} }, viewerRead), /nur lesen/);
  // The list says which workflows a button can start.
  const list = await get(`workflows?workspaceId=${wid}`);
  assert.equal(list.workflows.find((w: { pageId: string }) => w.pageId === pageId).manual, true);
  void all;
});
