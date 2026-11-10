// Workflows (#168, docs/specs/workflows.md): the page kind, the draft,
// activating and pausing, runs through the outbox and the queue, the
// immediate part, the issue's example ("new sub-page → link on the
// overview"), rules opened in the canvas and replaced on activation, test
// and dry runs, who sees run contents, the runner losing rights, the trash,
// limits, schedules, and that nothing happens (≤ 1 index lookup per event)
// while no workflow is active. On SQLite and PostgreSQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workflows-"));
const { id, run, one, all, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { drainWorkflows, claimSteps, sweepLeases } = await import("../lib/workflows/queue");
const { executeStep } = await import("../lib/workflows/engine");
const { workflowGet } = await import("../lib/workflows/commands");
const { triggerLookups } = await import("../lib/workflows/events");
const { processWorkflowSchedules } = await import("../lib/workflows/schedules");
const { workflowRetention } = await import("../lib/workflows/retention");
const { withReadMemo } = await import("../lib/read-memo");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer"),
  guest = await user("guest");
const wid = await createWorkspace(owner.id, "Flows"),
  boot = await bootstrap(owner, wid);
const space = boot.spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const get = async (path: string, who = owner) => {
  const url = new URL(`http://x/api/${path}`);
  return (await withReadMemo(async () => await workflowGet(who, url.pathname.slice(5).split("/"), url))) as any;
};

const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "closed", name: "Closed on", type: "date" },
  { id: "due", name: "Due", type: "date" },
  { id: "owner", name: "Owner", type: "person" },
  { id: "n", name: "Count", type: "number" },
];
const dbId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Tickets" })).id as string;
await act({ action: "database.update", pageId: dbId, version: (await database(dbId)).version, fields, views: (await database(dbId)).views });
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const update = async (rid: string, patch: Record<string, unknown>, who = owner) => await act({ action: "row.update", pageId: dbId, rowId: rid, version: await version(rid), cells: patch }, who);

let seq = 0;
const nid = () => `n_t${String(++seq).padStart(5, "0")}`;
const node = (type: string, config: Record<string, unknown>, label?: string) => ({ id: nid(), type, typeVersion: 1, label: label || `${type.split(".").pop()} ${seq}`, note: "", position: { x: seq * 10, y: 0 }, disabled: false, config });
const chain = (...nodes: ReturnType<typeof node>[]) => ({
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ id: `e_${i + 1}`, from: { node: nodes[i].id, port: (nodes[i] as { port?: string }).port || "out" }, to: { node: n.id, port: "in" } })),
});
async function workflow(title: string, graph: Record<string, unknown>, who = owner, activate = true) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title }, who)).id as string;
  const saved = await act({ action: "workflow.draft", pageId, graph }, who);
  if (activate) {
    const result = await act({ action: "workflow.activate", pageId }, who);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  }
  return { pageId, issues: saved.issues };
}
const runsOf = async (pageId: string) => await all<{ id: string; status: string; error: string | null; mode: string }>("SELECT id,status,error,mode FROM workflow_runs WHERE page_id=? ORDER BY created_at,seq", pageId);

test("the page kind: created with a workflow and a draft; guests get 404, readers no draft", async () => {
  const { pageId } = await workflow("Empty", { nodes: [], edges: [] }, owner, false);
  assert.equal((await one<{ kind: string; icon: string }>("SELECT kind,icon FROM pages WHERE id=?", pageId))!.kind, "workflow");
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "draft");
  const state = await get(`workflows/${pageId}`);
  assert.equal(state.status, "draft");
  assert.equal(state.canEdit, true);
  assert.ok(state.draft.issues.some((i: { code: string }) => i.code === "no_trigger"));
  const read = await get(`workflows/${pageId}`, viewer);
  assert.equal(read.canEdit, false);
  assert.equal(read.draft, null);
  // Guests: not even with a grant.
  await run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", pageId, guest.id, "editor").catch(() => {});
  await assert.rejects(get(`workflows/${pageId}`, guest), /nicht gefunden/);
  await assert.rejects(act({ action: "workflow.draft", pageId, graph: { nodes: [], edges: [] } }, viewer), /Keine Berechtigung/);
  await assert.rejects(act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "x" }, guest));
  // Activating a graph with errors does nothing and says why.
  const refused = await act({ action: "workflow.activate", pageId });
  assert.equal(refused.ok, false);
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "draft");
  // The catalogue.
  assert.ok((await get("workflows/catalog")).nodes.length >= 25);
});

test("the issue's example: a new sub-page is linked on the overview, never twice", async () => {
  const overview = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Docker Compose Sammlung" })).id as string;
  const trigger = node("trigger.page.created", { scope: { kind: "below", pageId: overview, depth: "children" }, kinds: ["document"] }, "Neue Compose-Seite");
  const append = node(
    "action.page.append",
    { page: `{{${trigger.id}.page.parent}}`, where: { kind: "end" }, blocks: [{ type: "bullet", text: `{{${trigger.id}.page.link}} – <b>neu</b>` }], noDuplicate: true },
    "Auf Übersicht eintragen",
  );
  const { pageId } = await workflow("Compose verlinken", chain(trigger, append));
  const child = (await act({ action: "page.create", workspaceId: wid, spaceId: space, parentId: overview, title: "Traefik" }, editor)).id as string;
  // Another page elsewhere does not count.
  await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Elsewhere" });
  await drainWorkflows();
  const runs = await runsOf(pageId);
  assert.deepEqual(runs.map((r) => r.status), ["succeeded"], JSON.stringify(runs));
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", overview))!.html;
  assert.match(html, new RegExp(`href="/#page=${child}"[^>]*>Traefik</a>`));
  // The value stays text: no markup from a value.
  assert.match(html, /&lt;b&gt;neu&lt;\/b&gt;/);
  // A second event for the same page appends nothing (“not twice”).
  const detail = await get(`workflow-runs/${runs[0].id}`);
  assert.equal(detail.contentsVisible, true);
  const appendStep = detail.timeline.find((s: { nodeId: string }) => s.nodeId === append.id);
  assert.equal(appendStep.output.appended, 1);
  await act({ action: "workflow.test", pageId, mode: "test", data: { kind: "page", pageId: child } }, owner);
  await drainWorkflows();
  const again = (await runsOf(pageId)).at(-1)!;
  assert.equal(again.mode, "test");
  const second = await get(`workflow-runs/${again.id}`);
  assert.equal(second.timeline.find((s: { nodeId: string }) => s.nodeId === append.id).output.appended, 0);
  assert.equal(((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", overview))!.html.match(/#page=/g) || []).length, 1);
  // Others see the run, not its contents (§9.3).
  const asEditor = await get(`workflow-runs/${runs[0].id}`, editor);
  assert.equal(asEditor.contentsVisible, false);
  assert.ok(asEditor.timeline.every((s: { output: unknown }) => s.output === null));
  assert.equal((await get(`workflows/${pageId}/runs`, viewer)).runs.length, 2);
  await act({ action: "workflow.pause", pageId });
});

test("an immediate part runs in the write; the rest is queued; own changes do not loop", async () => {
  const trigger = node("trigger.record.changed", { database: dbId, fields: ["status"], to: "Done" });
  const set = node("action.record.update", { values: { closed: "{{$today}}", n: `{{${trigger.id}.record.fields.n | default: 0}}` } });
  const notify = node("notify.person", { to: ["@creator"], title: "Erledigt", message: `{{${trigger.id}.record.title}} ist fertig`, channels: ["inbox"] });
  // Queued: a record in the same database – its "created" event does not
  // trigger this workflow again (own changes), and the immediate part's
  // update triggers nothing.
  const create = node("action.record.create", { database: dbId, values: { title: `Follow-up of {{${trigger.id}.record.title}}`, status: "Open" } });
  const { pageId } = await workflow("Close", chain(trigger, set, notify, create));
  assert.equal((await one<{ inline: number }>("SELECT inline FROM workflow_triggers WHERE page_id=?", pageId))!.inline, 1);
  const rid = (await act({ action: "row.create", pageId: dbId, cells: { title: "Bug", status: "Open", n: 2 } }, editor)).id;
  await update(rid, { status: "Done" });
  // Right away, before any worker ran.
  const now = await cells(rid);
  assert.equal(now.closed, new Date().toISOString().slice(0, 10));
  assert.equal(now.n, 2);
  const note = await one<{ body: string; kind: string; row_id: string }>("SELECT body,kind,row_id FROM notifications WHERE user_id=? AND kind='workflow'", editor.id);
  assert.deepEqual({ ...note }, { body: "Erledigt – Bug ist fertig", kind: "workflow", row_id: rid });
  const [r] = await runsOf(pageId);
  assert.equal(r.status, "running");
  await drainWorkflows();
  assert.equal((await runsOf(pageId))[0].status, "succeeded");
  assert.equal((await all("SELECT id FROM rows WHERE page_id=? AND cells LIKE '%Follow-up of Bug%'", dbId)).length, 1);
  assert.equal((await runsOf(pageId)).length, 1);
  await act({ action: "workflow.pause", pageId });
});

test("a database rule opened in the canvas replaces the rule when activated – never both", async () => {
  await act({
    action: "database.settings",
    pageId: dbId,
    settings: { automations: [{ id: "r1", name: "Closed date", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "set", field: "closed", value: "@today" }] }] },
  });
  const created = await act({ action: "workflow.fromRule", pageId: dbId, automationId: "r1" });
  const page = await one<{ title: string; parent_id: string | null; space_id: string }>("SELECT title,parent_id,space_id FROM pages WHERE id=?", created.id);
  assert.equal(page!.title, "Closed date (Workflow)");
  assert.equal(page!.space_id, space);
  const state = await get(`workflows/${created.id}`);
  assert.deepEqual(state.draft.issues.filter((i: { level: string }) => i.level === "error"), []);
  // Before activation the rule still runs.
  const a = (await act({ action: "row.create", pageId: dbId, cells: { title: "A", status: "Open" } })).id;
  await update(a, { status: "Done" });
  assert.ok((await cells(a)).closed);
  assert.equal((await runsOf(created.id)).length, 0);
  assert.equal((await act({ action: "workflow.activate", pageId: created.id })).ok, true);
  const rule = (await database(dbId)).settings!.automations![0];
  assert.equal(rule.enabled, false);
  assert.equal(rule.workflow, created.id);
  // The form cannot change a replaced rule back.
  await act({ action: "database.settings", pageId: dbId, settings: { automations: [{ ...rule, enabled: true, workflow: undefined }] } });
  assert.equal((await database(dbId)).settings!.automations![0].workflow, created.id);
  const b = (await act({ action: "row.create", pageId: dbId, cells: { title: "B", status: "Open" } })).id;
  await update(b, { status: "Done" });
  assert.equal((await cells(b)).closed, new Date().toISOString().slice(0, 10));
  assert.equal((await runsOf(created.id)).length, 1);
  await act({ action: "workflow.pause", pageId: created.id });
  await act({ action: "database.settings", pageId: dbId, settings: { automations: [] } });
});

test("pause holds open runs, activating continues them on their version; cancelling ends them", async () => {
  const trigger = node("trigger.manual", { inputs: [{ name: "Name", type: "text", required: true }] });
  const create = node("action.record.create", { database: dbId, values: { title: `{{${trigger.id}.inputs.Name}}` } });
  const { pageId } = await workflow("Manual", chain(trigger, create));
  await assert.rejects(act({ action: "workflow.run", pageId, inputs: {} }), /fehlt/);
  await assert.rejects(act({ action: "workflow.run", pageId, inputs: { Name: "x" } }, viewer), /Keine Berechtigung/);
  await act({ action: "workflow.run", pageId, inputs: { Name: "Held one" } }, editor);
  // Dispatch only (the step stays queued), then pause.
  const { dispatchEvents } = await import("../lib/workflows/events");
  await dispatchEvents();
  const [r] = await runsOf(pageId);
  assert.ok(r);
  await act({ action: "workflow.pause", pageId });
  assert.equal((await runsOf(pageId))[0].status, "held");
  assert.equal((await claimSteps(10)).length, 0);
  // A new version meanwhile: the held run finishes on its own.
  const v1 = (await one<{ active_version_id: string }>("SELECT active_version_id FROM workflows WHERE page_id=?", pageId))!.active_version_id;
  await act({ action: "workflow.draft", pageId, graph: chain(trigger, { ...create, config: { database: dbId, values: { title: "v2 {{" + trigger.id + ".inputs.Name}}" } } }) });
  await act({ action: "workflow.activate", pageId });
  assert.notEqual((await one<{ active_version_id: string }>("SELECT active_version_id FROM workflows WHERE page_id=?", pageId))!.active_version_id, v1);
  await drainWorkflows();
  assert.equal((await runsOf(pageId))[0].status, "succeeded");
  assert.ok(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%\"Held one\"%'", dbId));
  // Pausing with "cancel": open runs end.
  await act({ action: "workflow.run", pageId, inputs: { Name: "Cancelled" } });
  await dispatchEvents();
  await act({ action: "workflow.pause", pageId, cancelRuns: true });
  assert.equal((await runsOf(pageId)).at(-1)!.status, "cancelled");
  assert.ok(!(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%Cancelled%'", dbId)));
  // Versions: two activated ones.
  assert.equal((await get(`workflows/${pageId}/versions`)).versions.length, 2);
});

test("the person it runs as loses edit rights: the workflow pauses with the reason", async () => {
  const trigger = node("trigger.record.created", { database: dbId, includeForm: true });
  const find = node("action.record.find", { database: dbId, filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: "status", op: "eq", value: "Open" }] }, limit: 5 });
  const { pageId } = await workflow("Runner", chain(trigger, find), editor);
  await act({ action: "row.create", pageId: dbId, cells: { title: "One", status: "Open" } });
  await drainWorkflows();
  const [first] = await runsOf(pageId);
  assert.equal(first.status, "succeeded");
  const out = (await get(`workflow-runs/${first.id}`, editor)).timeline.find((s: { nodeId: string }) => s.nodeId === find.id).output;
  assert.ok(out.count >= 1);
  await run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, editor.id);
  await act({ action: "row.create", pageId: dbId, cells: { title: "Two" } });
  await drainWorkflows();
  const wf = await one<{ status: string; pause_reason: string }>("SELECT status,pause_reason FROM workflows WHERE page_id=?", pageId);
  assert.equal(wf!.status, "paused");
  assert.match(wf!.pause_reason, /editor.*keine Bearbeitungsrechte/);
  assert.equal((await runsOf(pageId)).length, 1);
  await run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, editor.id);
});

test("test and dry runs run the draft as the tester; dry runs change nothing", async () => {
  const trigger = node("trigger.record.created", { database: dbId });
  const create = node("action.record.create", { database: dbId, values: { title: "From test", owner: "@runner" } });
  const { pageId } = await workflow("Tests", chain(trigger, create), owner, false);
  const rid = (await act({ action: "row.create", pageId: dbId, cells: { title: "Sample" } })).id;
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "record", rowId: rid } }, editor);
  assert.equal(dry.ok, true);
  await drainWorkflows();
  const detail = await get(`workflow-runs/${dry.runId}`, editor);
  assert.equal(detail.status, "succeeded");
  assert.equal(detail.runner.id, editor.id);
  assert.deepEqual(detail.timeline.find((s: { nodeId: string }) => s.nodeId === create.id).output.wouldCreate.cells, { title: "From test", owner: editor.id });
  assert.ok(!(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%From test%'", dbId)));
  const real = await act({ action: "workflow.test", pageId, mode: "test", data: { kind: "sample" } }, editor);
  await drainWorkflows();
  assert.equal((await get(`workflow-runs/${real.runId}`, editor)).status, "succeeded");
  const made = await one<{ created_by: string; cells: string }>("SELECT created_by,cells FROM rows WHERE page_id=? AND cells LIKE '%From test%'", dbId);
  assert.equal(made!.created_by, editor.id);
  // A person who may not see the record cannot test with it.
  await assert.rejects(act({ action: "workflow.test", pageId, data: { kind: "page", pageId: "00000000-0000-4000-8000-000000000000" } }, editor), /nicht gefunden/);
});

test("conditions with the database's operators; stop ends the run", async () => {
  const trigger = node("trigger.record.created", { database: dbId });
  const iff = { ...node("logic.if", { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: `{{${trigger.id}.record.fields.status}}`, op: "eq", value: "Doing" }, { kind: "condition", left: `{{${trigger.id}.record.fields.n}}`, op: "gt", value: "3" }] } }), port: "true" };
  const set = node("logic.set", { values: [{ name: "label", value: `{{${trigger.id}.record.title | upper}}`, type: "text" }] });
  const stop = node("logic.stop", { result: "failed", message: `Nein: {{${set.id}.label}}` });
  const { pageId } = await workflow("Ifs", chain(trigger, iff, set, stop));
  await act({ action: "row.create", pageId: dbId, cells: { title: "low", status: "Doing", n: 1 } });
  await act({ action: "row.create", pageId: dbId, cells: { title: "high", status: "Doing", n: 5 } });
  await drainWorkflows();
  const runs = await runsOf(pageId);
  assert.deepEqual(runs.map((r) => [r.status, r.error]), [["succeeded", null], ["failed", "Nein: HIGH"]]);
  await act({ action: "workflow.pause", pageId });
});

test("trash pauses, restore stays paused; locked pages keep the draft", async () => {
  const trigger = node("trigger.page.created", { scope: { kind: "workspace" } });
  const tag = node("action.page.tag", { page: `{{${trigger.id}.page.id}}`, op: "add", tags: ["auto"] });
  const { pageId } = await workflow("Tagger", chain(trigger, tag));
  const p = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "To tag" })).id;
  await drainWorkflows();
  assert.ok(await one("SELECT 1 FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? AND t.name='auto'", p));
  await act({ action: "page.delete", pageId });
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "paused");
  assert.ok(!(await one("SELECT 1 FROM workflow_triggers WHERE page_id=?", pageId)));
  await act({ action: "page.restore", pageId });
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "paused");
  await act({ action: "page.update", pageId, patch: { locked: true } });
  await assert.rejects(act({ action: "workflow.draft", pageId, graph: chain(trigger) }), /gesperrt/);
  // Activating and pausing stay possible on a locked page.
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  await act({ action: "workflow.pause", pageId });
  // A duplicate copies the draft, never active.
  await act({ action: "page.update", pageId, patch: { locked: false } });
  const copy = (await act({ action: "page.duplicate", pageId })).id as string;
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", copy))?.status, "draft");
  assert.equal((await get(`workflows/${copy}`)).draft.graph.nodes.length, 2);
});

test("schedules fire once per slot, also when the tick runs twice; dates once per record", async () => {
  const trigger = node("trigger.schedule", { freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" });
  const create = node("action.record.create", { database: dbId, values: { title: `Daily {{${trigger.id}.slot.date | date: "yyyy-MM-dd"}}`, due: `{{${trigger.id}.slot.date | add_days: 3}}` } });
  const { pageId } = await workflow("Daily", chain(trigger, create));
  const since = (await one<{ activated_at: number }>("SELECT activated_at FROM workflows WHERE page_id=?", pageId))!.activated_at;
  const tomorrow = since + 86_400_000;
  assert.equal(await processWorkflowSchedules(tomorrow), 1);
  assert.equal(await processWorkflowSchedules(tomorrow), 0);
  await drainWorkflows();
  const day = new Date(tomorrow).toISOString().slice(0, 10);
  const made = await cells((await one<{ id: string }>("SELECT id FROM rows WHERE page_id=? AND cells LIKE ?", dbId, `%Daily ${day}%`))!.id);
  assert.equal(made.due, new Date(Date.parse(day) + 3 * 86_400_000).toISOString().slice(0, 10));
  await act({ action: "workflow.pause", pageId });
  // Date reached, two days before.
  const dateTrigger = node("trigger.record.date", { database: dbId, field: "due", offsetDays: -2, mode: "reached" });
  const notify = node("notify.person", { to: [owner.id], message: `Bald fällig: {{${dateTrigger.id}.record.title}}`, channels: ["inbox"] });
  const dates = await workflow("Reminder", chain(dateTrigger, notify));
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await act({ action: "row.create", pageId: dbId, cells: { title: "Soon", due: soon } });
  await act({ action: "row.create", pageId: dbId, cells: { title: "Later", due: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10) } });
  assert.equal(await processWorkflowSchedules(), 1);
  assert.equal(await processWorkflowSchedules(), 0);
  await drainWorkflows();
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND body='Bald fällig: Soon'", owner.id));
  await act({ action: "workflow.pause", pageId: dates.pageId });
});

test("every two weeks keeps its rhythm when republished or resumed; slots while paused are not made up", async () => {
  const trigger = node("trigger.schedule", { freq: "weekly", interval: 2, weekday: 1, time: "09:00", timeZone: "UTC" });
  const notify = node("notify.person", { to: [owner.id], message: "Alle zwei Wochen", channels: ["inbox"] });
  const graph = chain(trigger, notify);
  const { pageId } = await workflow("Biweekly", graph);
  const at = (iso: string) => Date.parse(iso);
  const activatedAt = async (iso: string) => await run("UPDATE workflows SET activated_at=? WHERE page_id=?", at(iso), pageId);
  // First activated on Monday 2 November 2026, before 09:00.
  await activatedAt("2026-11-02T08:00:00Z");
  assert.equal(await processWorkflowSchedules(at("2026-11-02T10:00:00Z")), 1);
  assert.equal(await processWorkflowSchedules(at("2026-11-09T10:00:00Z")), 0);
  assert.equal(await processWorkflowSchedules(at("2026-11-16T10:00:00Z")), 1);
  // Republished on 24 November with a changed label: still due on the 30th.
  await act({ action: "workflow.draft", pageId, graph: { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], label: "Neu" }] } });
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  await activatedAt("2026-11-24T08:00:00Z");
  assert.equal(await processWorkflowSchedules(at("2026-11-30T10:00:00Z")), 1);
  assert.equal(await processWorkflowSchedules(at("2026-12-07T10:00:00Z")), 0);
  // Paused over the 14th and resumed on the 15th: not made up, the 28th is next.
  await act({ action: "workflow.pause", pageId });
  await act({ action: "workflow.activate", pageId });
  await activatedAt("2026-12-15T08:00:00Z");
  assert.equal(await processWorkflowSchedules(at("2026-12-15T10:00:00Z")), 0);
  assert.equal(await processWorkflowSchedules(at("2026-12-21T10:00:00Z")), 0);
  assert.equal(await processWorkflowSchedules(at("2026-12-28T10:00:00Z")), 1);
  await act({ action: "workflow.pause", pageId });
});

test("page changes are debounced: one event 2 minutes after the last edit", async () => {
  const trigger = node("trigger.page.changed", { scope: { kind: "workspace" }, what: ["title"] });
  const notify = node("notify.person", { to: [owner.id], message: `Umbenannt: {{${trigger.id}.page.title}}`, channels: ["inbox"] });
  const { pageId } = await workflow("Renames", chain(trigger, notify));
  const p = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Draft" })).id;
  await act({ action: "page.update", pageId: p, patch: { title: "Draft 2" } });
  await act({ action: "page.update", pageId: p, patch: { title: "Final" } });
  const events = await all<{ due_at: number; created_at: number }>("SELECT due_at,created_at FROM workflow_events WHERE kind='page.changed' AND page_id=?", p);
  assert.equal(events.length, 1);
  assert.ok(events[0].due_at - Date.now() > 100_000);
  await drainWorkflows();
  assert.equal((await runsOf(pageId)).length, 0);
  await drainWorkflows({ now: () => Date.now() + 3 * 60_000 });
  assert.deepEqual((await runsOf(pageId)).map((r) => r.status), ["succeeded"]);
  assert.ok(await one("SELECT 1 FROM notifications WHERE body='Umbenannt: Final'"));
  // After dispatch the next change makes a new event.
  await act({ action: "page.update", pageId: p, patch: { title: "Final 2" } });
  assert.equal((await all("SELECT 1 FROM workflow_events WHERE kind='page.changed' AND page_id=?", p)).length, 2);
  await act({ action: "workflow.pause", pageId });
});

test("cascades stop at the depth limit; rate limits drop events", async () => {
  // A creates a record in B's database, B one in A's: a loop across workflows.
  const other = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Other" })).id as string;
  const ta = node("trigger.record.created", { database: other });
  const ca = node("action.record.create", { database: dbId, values: { title: "ping" } });
  const tb = node("trigger.record.created", { database: dbId });
  const cb = node("action.record.create", { database: other, values: { title: "pong" } });
  const a = await workflow("Ping", { ...chain(ta, ca), edges: [{ id: "e_1", from: { node: ta.id, port: "out" }, to: { node: ca.id, port: "in" } }] });
  // Not inline: action.record.create runs queued.
  const b = await workflow("Pong", chain(tb, cb));
  await act({ action: "row.create", pageId: other, cells: {} });
  await drainWorkflows();
  const depths = await all<{ depth: number }>("SELECT depth FROM workflow_runs WHERE page_id IN (?,?) ORDER BY depth", a.pageId, b.pageId);
  assert.equal(Math.max(...depths.map((d) => d.depth)), 5);
  assert.equal(depths.length, 6);
  await act({ action: "workflow.pause", pageId: a.pageId });
  await act({ action: "workflow.pause", pageId: b.pageId });
  // Rate limit: a workflow's own lower limit.
  const t = node("trigger.record.created", { database: other });
  const s = node("logic.set", { values: [{ name: "x", value: "1" }] });
  const limited = await workflow("Limited", { ...chain(t, s), settings: { timeZone: "UTC", triggerOnOwnChanges: false, limits: { runsPerMinute: 2 } } });
  for (let i = 0; i < 4; i++) await act({ action: "row.create", pageId: other, cells: {} });
  await drainWorkflows();
  assert.equal((await runsOf(limited.pageId)).length, 2);
  assert.equal((await one<{ throttled: number }>("SELECT throttled FROM workflows WHERE page_id=?", limited.pageId))!.throttled, 2);
  await act({ action: "workflow.pause", pageId: limited.pageId });
});

test("a lost lease cannot commit: the second worker's result counts, effects exactly once", async () => {
  const trigger = node("trigger.manual", {});
  const create = node("action.record.create", { database: dbId, values: { title: "Fenced" } });
  const { pageId } = await workflow("Fence", chain(trigger, create));
  await act({ action: "workflow.run", pageId });
  const { dispatchEvents } = await import("../lib/workflows/events");
  await dispatchEvents();
  const [first] = await claimSteps(1);
  assert.ok(first);
  // The lease runs out (a hung instance); the sweeper puts the step back, another worker takes it.
  assert.equal(await sweepLeases(Date.now() + 10 * 60_000), 1);
  const [second] = await claimSteps(1, Date.now() + 60 * 60_000);
  assert.equal(second.id, first.id);
  assert.notEqual(second.lease_token, first.lease_token);
  await executeStep(first);
  assert.equal((await all("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%Fenced%'", dbId)).length, 0);
  await executeStep(second);
  assert.equal((await all("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%Fenced%'", dbId)).length, 1);
  assert.equal((await runsOf(pageId))[0].status, "succeeded");
  await act({ action: "workflow.pause", pageId });
});

test("no active workflows: at most one index lookup per event", async () => {
  const quiet = await createWorkspace(owner.id, "Quiet");
  const qboot = await bootstrap(owner, quiet);
  const qdb = (await act({ action: "page.create", workspaceId: quiet, spaceId: qboot.spaces[0].id, kind: "database", title: "Q" })).id as string;
  const rid = (await act({ action: "row.create", pageId: qdb, cells: { title: "q" } })).id;
  const before = triggerLookups();
  const n = 20;
  for (let i = 0; i < n; i++) await act({ action: "row.update", pageId: qdb, rowId: rid, version: await version(rid), cells: { title: `q${i}` } });
  const perEvent = (triggerLookups() - before) / n;
  console.log(`workflow trigger lookups per record update without workflows: ${perEvent}`);
  assert.ok(perEvent <= 1, String(perEvent));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_events WHERE workspace_id=?", quiet))!.n), 0);
});

test("retention removes finished runs after the period, keeps open ones", async () => {
  const old = Date.now() - 40 * 86_400_000;
  await run("UPDATE workflow_runs SET finished_at=? WHERE status='succeeded'", old);
  const open = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE status NOT IN ('succeeded','failed','cancelled')"))!.n);
  const result = await transaction(async () => await workflowRetention());
  assert.ok(result.runs > 0);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE status='succeeded'"))!.n), 0);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE status NOT IN ('succeeded','failed','cancelled')"))!.n), open);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_steps s WHERE NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id=s.run_id)"))!.n), 0);
});

test("archives carry draft and versions (imported paused), never runs; exports and snapshots", async () => {
  const { exportArchive, importArchive } = await import("../lib/archive");
  const trigger = node("trigger.record.created", { database: dbId });
  const set = node("logic.set", { values: [{ name: "x", value: "1" }] }, "Archived set");
  const { pageId } = await workflow("Archived", chain(trigger, set));
  await act({ action: "row.create", pageId: dbId, cells: { title: "for the archive" } });
  await drainWorkflows();
  const target = await createWorkspace(owner.id, "Target");
  await importArchive(owner, target, await exportArchive(owner, wid));
  const copy = await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='workflow' AND title='Archived'", target);
  assert.ok(copy);
  const wf = await one<{ status: string; active_version_id: string; runner_id: string | null }>("SELECT status,active_version_id,runner_id FROM workflows WHERE page_id=?", copy!.id);
  assert.equal(wf!.status, "paused");
  assert.ok(wf!.active_version_id);
  assert.equal(wf!.runner_id, null);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE page_id=?", copy!.id))!.n), 0);
  // The database it reacts to came along: the ids follow.
  const version = JSON.parse((await one<{ graph: string }>("SELECT graph FROM workflow_versions WHERE id=?", wf!.active_version_id))!.graph);
  const newDb = await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND kind='database' AND title='Tickets'", target);
  assert.equal(version.nodes[0].config.database, newDb!.id);
  // A manual version and its restore go into the draft.
  const snap = (await act({ action: "page.snapshot", pageId })).id;
  await act({ action: "workflow.draft", pageId, graph: chain(trigger) });
  await act({ action: "snapshot.restore", pageId, snapshotId: snap });
  assert.equal((await get(`workflows/${pageId}`)).draft.graph.nodes.length, 2);
  // Search finds it by its node labels; the Markdown export lists them.
  const { exportMarkdown } = await import("../lib/markdown-export");
  const md = await exportMarkdown(owner, { pageId, format: "markdown", includeSubpages: false });
  assert.match(Buffer.from(md.bytes as Uint8Array).toString("utf8"), /- Archived set/);
  await act({ action: "workflow.pause", pageId });
});
