// Workflows against prompt injection and foreign input: targets stay in the
// workflow's own workspace although the runner belongs to others too (the
// nodes resolve a page, database or record from a placeholder – a form
// answer, an e-mail, an AI answer). The same on SQLite and PostgreSQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-injection-"));
const { one } = await import("../lib/db");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const S = await import("./helpers/workflow-setup");
const { act, owner, node, edge, chain, workflow, runsOf, stepsOf, makeDatabase, manual, cells } = S;

const dbId = await makeDatabase("Tickets");
// The runner's other workspace, with a page, a database and a record.
const otherWid = await createWorkspace(owner.id, "Privat");
const otherSpace = (await bootstrap(owner, otherWid)).spaces[0].id as string;
const otherPage = (await act({ action: "page.create", workspaceId: otherWid, spaceId: otherSpace, kind: "document", title: "Fremd" })).id as string;
const otherDb = (await act({ action: "page.create", workspaceId: otherWid, spaceId: otherSpace, kind: "database", title: "Fremde Daten" })).id as string;
const otherRow = (await act({ action: "row.create", pageId: otherDb, cells: {} })).id as string;
const ownRow = (await act({ action: "row.create", pageId: dbId, cells: { title: "Eigen" } })).id as string;

const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;
const { untrustedTargetIssues, untrustedOrigin, needsUntrustedSetting } = await import("../lib/workflows/provenance");
const { parseGraph } = await import("../lib/workflows/graph");
const graphOf = (g: { nodes: unknown[]; edges: unknown[] }, settings: Record<string, unknown> = {}) => parseGraph({ ...g, settings: { timeZone: "UTC", ...settings } });
const codes = (g: ReturnType<typeof graphOf>) => untrustedTargetIssues(g).map((i) => `${i.level}:${i.code}:${i.nodeId}:${i.params?.node}`);
const input = { inputs: [{ name: "ziel", type: "text", required: false }] };

test("provenance: outside data choosing recipients or targets is found directly and through the nodes in between", () => {
  const hook = node("trigger.webhook", { mode: "signed" }, "Webhook");
  // Directly: a webhook body as the e-mail recipient.
  const mail = node("notify.email", { to: [`{{${hook.id}.body.email}}`], subject: "s", message: "m" }, "Mail");
  assert.deepEqual(codes(graphOf(chain(hook, mail))), [`error:untrusted_recipients:${mail.id}:Webhook`]);
  // Through "Set values" and $trigger.
  const set = node("logic.set", { values: [{ name: "to", value: "{{$trigger.body.to}}", type: "text" }] }, "Setzen");
  const person = node("notify.person", { to: [`{{${set.id}.to}}`], title: "t", message: "", channels: ["inbox"] }, "Melden");
  assert.deepEqual(codes(graphOf(chain(hook, set, person))), [`error:untrusted_recipients:${person.id}:Webhook`]);
  // Through a search whose filter uses the e-mail's subject: the found record is chosen from outside.
  const inbox = node("trigger.mail.received", { address: "x" }, "Posteingang");
  const find = node("action.record.find", { database: dbId, filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: "title", op: "eq", value: `{{${inbox.id}.mail.subject}}` }] }, limit: 1 }, "Suchen");
  const update = node("action.record.update", { record: `{{${find.id}.first.id}}`, values: { title: "x" } }, "Ändern");
  assert.deepEqual(codes(graphOf(chain(inbox, find, update))), [`error:untrusted_target:${update.id}:Posteingang`]);
  // Through an AI answer two steps back and a loop's $item.
  const manual = node("trigger.manual", {}, "Start");
  const ai = node("ai.extract", { text: "x", fields: [{ name: "people", type: "list", description: "" }] }, "KI");
  const loop = node("logic.foreach", { list: `{{${ai.id}.fields.people}}` }, "Je Person");
  const each = node("notify.person", { to: ["{{$item}}"], title: "t", message: "", channels: ["inbox"] }, "Jede");
  const looped = graphOf({ nodes: [manual, ai, loop, each], edges: [edge(manual, ai), edge(ai, loop), edge(loop, each, "item")] });
  assert.deepEqual(codes(looped), [`error:untrusted_recipients:${each.id}:KI`]);
  assert.deepEqual(untrustedOrigin(looped, each.id, ["{{$item}}"]), { nodeId: ai.id, kind: "ai" });
  // The approvers and a task's assignee and page count as well; an HTTP answer is outside data.
  const http = node("http.request", { method: "GET", url: "https://api.example.com/x" }, "Abruf");
  const approve = node("logic.approval", { approvers: [`{{${http.id}.json.boss}}`] }, "Freigabe");
  const task = node("action.task.create", { target: "page", page: `{{${http.id}.json.page}}`, text: "t", assignee: [`{{${http.id}.json.who}}`] }, "Aufgabe");
  assert.deepEqual(codes(graphOf(chain(manual, http, approve, task))), [`error:untrusted_recipients:${approve.id}:Abruf`, `error:untrusted_target:${task.id}:Abruf`, `error:untrusted_recipients:${task.id}:Abruf`]);
});

test("provenance: what Flowplan decides stays allowed – ids of created records, fixed values, members, the comment's author", () => {
  const form = node("trigger.form.submitted", { database: dbId }, "Formular");
  // The record a node creates is chosen by its database, not by the values it writes.
  const create = node("action.record.create", { database: dbId, values: { title: `{{${form.id}.answers.title}}`, owner: "@actor" } }, "Anlegen");
  const update = node("action.record.update", { record: `{{${create.id}.record.id}}`, values: { status: "Open" } }, "Ändern");
  const tellOwner = node("notify.person", { to: [`{{${create.id}.record.fields.owner}}`], title: `Neu: {{${form.id}.answers.title}}`, message: "", channels: ["inbox"] }, "Melden");
  // The submitted record itself (empty: the triggering one), a fixed person.
  const own = node("action.record.update", { record: "", values: { status: "Doing" } }, "Eigener");
  assert.deepEqual(codes(graphOf(chain(form, create, update, tellOwner, own))), []);
  // A property the node wrote from the answers is outside data; one it left alone on the form's record too.
  const fromAnswer = node("action.record.create", { database: dbId, values: { owner: `{{${form.id}.answers.who}}` } }, "Aus Antwort");
  const tellAnswer = node("notify.person", { to: [`{{${fromAnswer.id}.record.fields.owner}}`], title: "t", message: "", channels: ["inbox"] }, "Melden 2");
  const tellField = node("notify.person", { to: [`{{${own.id}.record.fields.mail}}`, "field:owner"], title: "t", message: "", channels: ["inbox"] }, "Melden 3");
  assert.deepEqual(codes(graphOf(chain(form, own, fromAnswer, tellAnswer, tellField))), [`error:untrusted_recipients:${tellAnswer.id}:Formular`, `error:untrusted_recipients:${tellField.id}:Formular`]);
  // A comment: its text is outside data, its author and page are not.
  const comment = node("trigger.comment.created", {}, "Kommentar");
  const author = node("notify.person", { to: [`{{${comment.id}.actor}}`], title: `{{${comment.id}.comment.text}}`, message: "", channels: ["inbox"] }, "Autor");
  const append = node("action.page.append", { page: `{{${comment.id}.page}}`, where: { kind: "end" }, blocks: [{ type: "paragraph", text: `{{${comment.id}.comment.text}}` }] }, "Anhängen");
  const steered = node("action.page.tag", { page: `{{${comment.id}.comment.text}}`, op: "add", tags: ["x"] }, "Gesteuert");
  assert.deepEqual(codes(graphOf(chain(comment, author, append, steered))), [`error:untrusted_target:${steered.id}:Kommentar`]);
  // With the setting the same findings are warnings; disabled nodes do not count.
  const hook = node("trigger.webhook", { mode: "signed" }, "Webhook");
  const mail = node("notify.email", { to: [`{{${hook.id}.body.email}}`], subject: "s", message: "m" }, "Mail");
  assert.deepEqual(codes(graphOf(chain(hook, mail), { untrustedTargets: true })), [`warning:ai_to_recipients:${mail.id}:Webhook`]);
  assert.deepEqual(codes(graphOf(chain(hook, { ...mail, disabled: true }))), []);
  assert.equal(needsUntrustedSetting(graphOf(chain(hook, mail))), true);
  assert.equal(needsUntrustedSetting(graphOf(chain(hook, mail), { untrustedTargets: true })), false);
});

test("the check: outside data as recipient keeps a workflow from being activated until the setting allows it; dry runs still work; active versions keep running, marked", async () => {
  const t = node("trigger.manual", input, "Start");
  const ai = node("http.request", { method: "GET", url: "https://api.example.com/wer" }, "Abruf");
  const tell = node("notify.person", { to: [`{{${ai.id}.json.who}}`], title: "t", message: "", channels: ["inbox"] }, "Melden");
  const { pageId, issues } = await workflow("Unsicher", chain(t, ai, tell), owner, false);
  assert.ok(issues.some((i) => i.code === "untrusted_recipients" && i.level === "error" && i.nodeId === tell.id), JSON.stringify(issues));
  const refused = await act({ action: "workflow.activate", pageId });
  assert.equal(refused.ok, false);
  // A dry run shows what would happen; a real test run is refused like activating.
  assert.equal((await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "sample" } })).ok, true);
  assert.equal((await act({ action: "workflow.test", pageId, mode: "test", data: { kind: "sample" } })).ok, false);
  // With the setting: a warning, it activates.
  const allowed = { ...chain(t, ai, tell), settings: { timeZone: "UTC", untrustedTargets: true } };
  const saved = await act({ action: "workflow.draft", pageId, graph: allowed });
  assert.ok(saved.issues.some((i: { code: string; level: string }) => i.code === "ai_to_recipients" && i.level === "warning"));
  assert.ok(!saved.issues.some((i: { level: string; code: string }) => i.level === "error" && i.code.startsWith("untrusted")));
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  // An active version from before the rule: it keeps running and is marked;
  // activating it again needs the setting.
  const old = node("trigger.manual", input, "Alt");
  const oldTell = node("notify.person", { to: [`{{${old.id}.inputs.ziel}}`], title: "t", message: "", channels: ["inbox"] }, "Alt melden");
  const hook = node("trigger.webhook", { mode: "signed" }, "Webhook");
  const hookTell = node("notify.person", { to: [`{{${hook.id}.body.who}}`], title: "Hallo", message: "", channels: ["inbox"] }, "Webhook melden");
  const { pageId: legacy } = await workflow("Vorher aktiviert", chain(old, oldTell));
  const graph = { format: "flowplan.workflow", version: 1, settings: { timeZone: "UTC", triggerOnOwnChanges: false, limits: {} }, ...chain(hook, hookTell) };
  const version = (await one<{ active_version_id: string }>("SELECT active_version_id FROM workflows WHERE page_id=?", legacy))!.active_version_id;
  const { run } = await import("../lib/db");
  await run("UPDATE workflow_versions SET graph=? WHERE id=?", JSON.stringify(graph), version);
  const state = await S.get(`workflows/${legacy}`);
  assert.equal(state.status, "active");
  assert.equal(state.active.needsUntrustedSetting, true);
  await act({ action: "workflow.draft", pageId: legacy, graph });
  assert.equal((await act({ action: "workflow.activate", pageId: legacy })).ok, false);
  assert.equal((await S.get(`workflows/${legacy}`)).status, "active", "the running version is left alone");
  await act({ action: "workflow.draft", pageId: legacy, graph: { ...graph, settings: { ...graph.settings, untrustedTargets: true } } });
  assert.equal((await act({ action: "workflow.activate", pageId: legacy })).ok, true);
  assert.equal((await S.get(`workflows/${legacy}`)).active.needsUntrustedSetting, false);
});

test("targets from placeholders stay in the workflow's workspace: pages, databases and records of another one are refused", async () => {
  const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;
  const cases: [string, Record<string, unknown>][] = [
    ["action.page.append", { page: "", where: { kind: "end" }, blocks: [{ type: "paragraph", text: "eingeschleust" }] }],
    ["action.page.create", { parent: "", title: "Neu", blocks: [], tags: [] }],
    ["action.page.tag", { page: "", op: "add", tags: ["x"] }],
    ["action.task.create", { target: "page", page: "", text: "Aufgabe" }],
    ["action.record.update", { record: "", values: { title: "überschrieben" } }],
  ];
  for (const [type, config] of cases) {
    const t = node("trigger.manual", input, "Start");
    const key = type === "action.page.create" ? "parent" : type === "action.record.update" ? "record" : "page";
    const n = node(type, { ...config, [key]: `{{${t.id}.inputs.ziel}}` }, "Ziel");
    const { pageId } = await workflow(`Ziel ${type}`, chain(t, n));
    const target = type === "action.record.update" ? otherRow : otherPage;
    await manual(pageId, { ziel: target });
    await drainWorkflows();
    const r = await lastRun(pageId);
    assert.equal(r.status, "failed", type);
    assert.equal(r.error_kind, "permission", type);
    assert.match((await stepsOf(r.id)).find((s) => s.node_id === n.id)!.error || "", /anderen Arbeitsbereich/, type);
    // Even a dry run does not resolve into the other workspace.
    const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { ziel: target } } } });
    await drainWorkflows();
    assert.equal((await one<{ status: string }>("SELECT status FROM workflow_runs WHERE id=?", dry.runId))!.status, "failed", type);
  }
  assert.doesNotMatch(await html(otherPage), /eingeschleust|Aufgabe/);
  assert.equal((await cells(otherRow)).title, undefined);
  assert.equal(await one("SELECT 1 FROM pages WHERE title='Neu' AND workspace_id=?", otherWid), undefined);
  // In the own workspace the same workflow works.
  const t = node("trigger.manual", input, "Start");
  const u = node("action.record.update", { record: `{{${t.id}.inputs.ziel}}`, values: { title: "geändert" } }, "Ziel");
  const { pageId } = await workflow("Ziel eigen", chain(t, u));
  await manual(pageId, { ziel: ownRow });
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "succeeded");
  assert.equal((await cells(ownRow)).title, "geändert");
});

test("record search and creation only in the own workspace; a notification links no page of another one", async () => {
  const t = node("trigger.manual", input, "Start");
  const find = node("action.record.find", { database: `{{${t.id}.inputs.ziel}}`, filter: { kind: "group", join: "and", rules: [] }, limit: 5 }, "Suchen");
  const { pageId } = await workflow("Suchen fremd", chain(t, find));
  await manual(pageId, { ziel: otherDb });
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "failed");
  const t2 = node("trigger.manual", input, "Start");
  const note = node("notify.person", { to: ["@runner"], title: "Hinweis", message: "", link: `{{${t2.id}.inputs.ziel}}`, channels: ["inbox"] }, "Melden");
  const { pageId: notifyId } = await workflow("Link fremd", chain(t2, note));
  await act({ action: "workflow.run", pageId: notifyId, inputs: { ziel: otherRow } }, S.editor);
  await drainWorkflows();
  assert.equal((await lastRun(notifyId)).status, "succeeded");
  const sent = await one<{ page_id: string | null; row_id: string | null }>("SELECT page_id,row_id FROM notifications WHERE user_id=? AND body LIKE 'Hinweis%' ORDER BY created_at DESC LIMIT 1", owner.id);
  assert.deepEqual(sent, { page_id: null, row_id: null });
});
