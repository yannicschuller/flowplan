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
const { act, owner, node, chain, workflow, runsOf, stepsOf, makeDatabase, manual, cells } = S;

const dbId = await makeDatabase("Tickets");
// The runner's other workspace, with a page, a database and a record.
const otherWid = await createWorkspace(owner.id, "Privat");
const otherSpace = (await bootstrap(owner, otherWid)).spaces[0].id as string;
const otherPage = (await act({ action: "page.create", workspaceId: otherWid, spaceId: otherSpace, kind: "document", title: "Fremd" })).id as string;
const otherDb = (await act({ action: "page.create", workspaceId: otherWid, spaceId: otherSpace, kind: "database", title: "Fremde Daten" })).id as string;
const otherRow = (await act({ action: "row.create", pageId: otherDb, cells: {} })).id as string;
const ownRow = (await act({ action: "row.create", pageId: dbId, cells: { title: "Eigen" } })).id as string;

const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;
const input = { inputs: [{ name: "ziel", type: "text", required: false }] };

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
