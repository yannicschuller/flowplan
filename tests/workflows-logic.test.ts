// Workflows wave 2 (#168, docs/specs/workflows.md §6.3, §8.6, §8.7): switch,
// for each (sequential, parallel, nested, the item limit, a clean abort at
// the step limit), wait (persisted, across a restart and daylight saving),
// approvals (from the notification, first decision wins, deadline, only
// signed in, the run goes on as the person it runs as), errors per node,
// retry from the failed node, messages to the person responsible, the
// auto-pause (also the 50 % rule), cancelling. On SQLite and PostgreSQL.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-logic-"));
const { run, one, all } = await import("../lib/db");
const { drainWorkflows, claimSteps } = await import("../lib/workflows/queue");
const { executeStep } = await import("../lib/workflows/engine");
const { waitTarget } = await import("../lib/workflows/nodes/logic");
const { flushNotices, checkFailureRate } = await import("../lib/workflows/notices");
const S = await import("./helpers/workflow-setup");
const { act, get, owner, editor, viewer, guest, node, edge, chain, workflow, runsOf, stepsOf, outputOf, manual, opsNotices, makeDatabase, cells } = S;

const dbId = await makeDatabase("Tickets");
const manualTrigger = (inputs: { name: string; type?: string }[] = []) => node("trigger.manual", { inputs: inputs.map((i) => ({ type: "text", required: false, ...i })) }, "Start");
const lastRun = async (pageId: string) => (await runsOf(pageId)).at(-1)!;

test("switch: the first matching case wins, else default; it runs in the immediate part", async () => {
  const t = manualTrigger([{ name: "kind" }]);
  const sw = node("logic.switch", { value: `{{${t.id}.inputs.kind}}`, cases: [{ id: "a", label: "Bug", op: "eq", value: "bug" }, { id: "b", label: "Frage", op: "contains", value: "frag" }] }, "Unterscheiden");
  const a = node("logic.set", { values: [{ name: "x", value: "A", type: "text" }] }, "A");
  const b = node("logic.set", { values: [{ name: "x", value: "B", type: "text" }] }, "B");
  const d = node("logic.set", { values: [{ name: "x", value: "D", type: "text" }] }, "D");
  const { pageId } = await workflow("Switch", { nodes: [t, sw, a, b, d], edges: [edge(t, sw), edge(sw, a, "case:a"), edge(sw, b, "case:b"), edge(sw, d, "default")] });
  for (const [kind, expected] of [["bug", "A"], ["eine Frage", "B"], ["sonst", "D"]]) {
    await manual(pageId, { kind });
    await drainWorkflows();
    const r = await lastRun(pageId);
    assert.equal(r.status, "succeeded");
    const ran = (await stepsOf(r.id)).map((s) => s.node_id);
    assert.ok(ran.includes(expected === "A" ? a.id : expected === "B" ? b.id : d.id), `${kind} → ${expected}`);
    assert.equal(ran.filter((x) => [a.id, b.id, d.id].includes(x)).length, 1);
  }
  // Duplicate case ids are refused by the check.
  const bad = { nodes: [t, { ...sw, config: { value: "x", cases: [{ id: "a", op: "eq", value: "1" }, { id: "a", op: "eq", value: "2" }] } }], edges: [edge(t, sw)] };
  const issues = (await act({ action: "workflow.validate", pageId, graph: bad })).issues;
  assert.ok(issues.some((i: { code: string }) => i.code === "duplicate_case"));
});

test("for each: 100 records one after the other within the step limit, results collected, $item/$index", async () => {
  for (let i = 0; i < 100; i++) await act({ action: "row.create", pageId: dbId, cells: { title: `R${i}`, n: i } });
  const t = manualTrigger();
  const find = node("action.record.find", { database: dbId, filter: { kind: "group", join: "and", rules: [] }, limit: 100 }, "Finden");
  const loop = node("logic.foreach", { list: `{{${find.id}.records}}`, limit: 100 }, "Für jedes");
  const set = node("logic.set", { values: [{ name: "label", value: "{{$index}}: {{$item.title}}", type: "text" }] }, "Beschriften");
  const after = node("logic.set", { values: [{ name: "total", value: `{{${loop.id}.count}}`, type: "number" }] }, "Danach");
  const { pageId, issues } = await workflow("Loop 100", { nodes: [t, find, loop, set, after], edges: [edge(t, find), edge(find, loop), edge(loop, set, "item"), edge(loop, after, "done")] });
  assert.ok(!issues.some((i) => i.level === "error"), JSON.stringify(issues));
  await manual(pageId);
  await drainWorkflows({ maxRounds: 5000 });
  const r = await lastRun(pageId);
  assert.equal(r.status, "succeeded", r.error || "");
  assert.ok(r.steps <= 200, `steps ${r.steps}`);
  const done = await outputOf(r.id, loop.id);
  assert.equal(done.count, 100);
  assert.equal(done.results.length, 100);
  assert.match(done.results[3].label, /^3: R/);
  assert.equal((await outputOf(r.id, after.id)).total, 100);
  // Sequential: one item at a time (iterations ran in order).
  const order = (await stepsOf(r.id)).filter((s) => s.node_id === set.id).map((s) => Number(s.iteration));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test("for each: more items than the limit are cut (warning); above the step limit the run ends cleanly", async () => {
  const t = manualTrigger();
  const make = node("logic.set", { values: [{ name: "list", value: '{{$run.id | replace: "-", ","}}', type: "text" }] }, "Liste");
  const loop = node("logic.foreach", { list: `{{${t.id}.inputs.items}}`, limit: 5, mode: "parallel", parallel: 3 }, "Fünf");
  const body = node("logic.set", { values: [{ name: "v", value: "{{$item}}", type: "auto" }] }, "Körper");
  const { pageId } = await workflow("Loop cut", { nodes: [t, loop, body, make], edges: [edge(t, loop), edge(loop, body, "item"), edge(loop, make, "done")] });
  // Inputs of a manual trigger are text: a test run carries a real list.
  const test1 = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { items: [1, 2, 3, 4, 5, 6, 7, 8] } } } });
  await drainWorkflows();
  const out = await outputOf(test1.runId, loop.id);
  assert.equal(out.count, 5);
  assert.match(out.warning, /Gekürzt auf 5/);
  assert.equal((await runsOf(pageId)).at(-1)!.status, "succeeded");
  // Two body nodes × 150 items > 200 steps: failed with "limit", nothing half-open.
  const big = node("logic.foreach", { list: `{{${t.id}.inputs.items}}`, limit: 150 }, "Viele");
  const b1 = node("logic.set", { values: [{ name: "a", value: "1", type: "text" }] }, "Eins");
  const b2 = node("logic.set", { values: [{ name: "b", value: "2", type: "text" }] }, "Zwei");
  await act({ action: "workflow.draft", pageId, graph: { nodes: [t, big, b1, b2], edges: [edge(t, big), edge(big, b1, "item"), edge(b1, b2)] } });
  const test2 = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { items: Array.from({ length: 150 }, (_, i) => i) } } } });
  await drainWorkflows({ maxRounds: 5000 });
  const r = (await one<{ status: string; error_kind: string; error: string }>("SELECT status,error_kind,error FROM workflow_runs WHERE id=?", test2.runId))!;
  assert.equal(r.status, "failed");
  assert.equal(r.error_kind, "limit");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_steps WHERE run_id=? AND status IN ('queued','running','waiting')", test2.runId))!.n), 0);
});

test("for each: nested two levels; edges may not leave a body; a third level is refused", async () => {
  const t = manualTrigger();
  const outer = node("logic.foreach", { list: `{{${t.id}.inputs.rows}}`, limit: 10 }, "Außen");
  const inner = node("logic.foreach", { list: "{{$item.cells}}", limit: 10, mode: "parallel" }, "Innen");
  const cell = node("logic.set", { values: [{ name: "v", value: "{{$index}}={{$item}}", type: "text" }] }, "Zelle");
  const end = node("logic.set", { values: [{ name: "n", value: `{{${inner.id}.count}}`, type: "number" }] }, "Zeilenende");
  const { pageId } = await workflow("Nested", { nodes: [t, outer, inner, cell, end], edges: [edge(t, outer), edge(outer, inner, "item"), edge(inner, cell, "item"), edge(inner, end, "done")] }, owner, false);
  const r = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { rows: [{ cells: ["a", "b"] }, { cells: ["c"] }, { cells: [] }] } } } });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  await drainWorkflows();
  const out = await outputOf(r.runId, outer.id);
  assert.equal(out.count, 3);
  assert.deepEqual(out.results.map((x: { n: number }) => x.n), [2, 1, 0]);
  const cellsRun = (await stepsOf(r.runId)).filter((s) => s.node_id === cell.id).map((s) => [s.iteration, JSON.parse(s.output!).v]);
  assert.deepEqual(cellsRun.sort(), [["0.0", "0=a"], ["0.1", "1=b"], ["1.0", "0=c"]]);
  // An edge out of the body, $item outside, and three levels: errors.
  const leak = node("logic.set", { values: [{ name: "x", value: "{{$item}}", type: "text" }] }, "Leck");
  const issues = (await act({ action: "workflow.validate", pageId, graph: { nodes: [t, outer, inner, cell, end, leak], edges: [edge(t, outer), edge(outer, inner, "item"), edge(inner, cell, "item"), edge(cell, leak), edge(t, leak)] } })).issues.map((i: { code: string }) => i.code);
  assert.ok(issues.includes("loop_entry") || issues.includes("loop_exit"), issues.join());
  const third = node("logic.foreach", { list: "{{$item}}", limit: 2 }, "Dritte");
  const deep = (await act({ action: "workflow.validate", pageId, graph: { nodes: [t, outer, inner, third, cell], edges: [edge(t, outer), edge(outer, inner, "item"), edge(inner, third, "item"), edge(third, cell, "item")] } })).issues.map((i: { code: string }) => i.code);
  assert.ok(deep.includes("loop_depth"), deep.join());
  const outside = (await act({ action: "workflow.validate", pageId, graph: { nodes: [t, leak], edges: [edge(t, leak)] } })).issues.map((i: { code: string }) => i.code);
  assert.ok(outside.includes("item_outside_loop"));
});

test("wait: the target in the workflow's time zone – days across daylight saving, next working day, until a date", () => {
  const zone = "Europe/Berlin";
  // Saturday 28 March 2026, 10:00 in Berlin (CET, +01:00); the clocks go forward that night.
  const sat = Date.parse("2026-03-28T09:00:00Z");
  assert.equal(new Date(waitTarget({ mode: "duration", amount: 1, unit: "days" }, null, zone, sat)).toISOString(), "2026-03-29T08:00:00.000Z", "10:00 the next day (CEST)");
  assert.equal(waitTarget({ mode: "duration", amount: 24, unit: "hours" }, null, zone, sat) - sat, 24 * 3600_000, "hours are real time");
  assert.equal(new Date(waitTarget({ mode: "next", amount: 1, unit: "hours", time: "09:00", weekdays: true }, null, zone, sat)).toISOString(), "2026-03-30T07:00:00.000Z", "Monday 9:00 CEST");
  assert.equal(new Date(waitTarget({ mode: "until", amount: 1, unit: "hours", time: "08:30" }, "2026-10-25", zone, sat)).toISOString(), "2026-10-25T07:30:00.000Z", "after the switch back (CET)");
  assert.equal(new Date(waitTarget({ mode: "until", amount: 1, unit: "hours" }, "2026-04-01T12:00:00Z", zone, sat)).toISOString(), "2026-04-01T12:00:00.000Z");
  assert.throws(() => waitTarget({ mode: "until", amount: 1, unit: "hours" }, "morgen", zone, sat), /kein Datum/);
});

test("wait: the step waits in the database, survives a restart (another worker takes it up) and goes on when due", async () => {
  const t = manualTrigger();
  const wait = node("logic.wait", { mode: "duration", amount: 2, unit: "hours" }, "Zwei Stunden");
  const after = node("action.record.create", { database: dbId, values: { title: "nach dem Warten" } }, "Danach");
  const { pageId } = await workflow("Wait", chain(t, wait, after));
  await manual(pageId);
  await drainWorkflows();
  const r = await lastRun(pageId);
  assert.equal(r.status, "waiting");
  const step = (await stepsOf(r.id)).find((s) => s.node_id === wait.id)!;
  assert.equal(step.status, "waiting");
  assert.ok(step.due_at > Date.now() + 7_000_000);
  // Nothing is due yet: no worker holds it.
  assert.equal((await claimSteps(4)).length, 0);
  // "Restart": the in-memory state is irrelevant – a later claim (any instance) at the due time continues.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600_000 + 1000 });
  try {
    const claimed = await claimSteps(4);
    assert.equal(claimed.length, 1);
    for (const s of claimed) await executeStep(s);
    await drainWorkflows();
  } finally {
    mock.timers.reset();
  }
  const done = await lastRun(pageId);
  assert.equal(done.status, "succeeded");
  assert.ok((await outputOf(done.id, wait.id)).waitedUntil);
  assert.ok(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%nach dem Warten%'", dbId));
  // Dry runs do not wait.
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "sample" } });
  await drainWorkflows();
  assert.equal((await outputOf(dry.runId, wait.id)).skipped, true);
});

test("approval: requested by notification, the first decision wins, the run goes on as the person it runs as", async () => {
  const t = manualTrigger([{ name: "who" }]);
  const ask = node("logic.approval", { approvers: [editor.id, viewer.id, `{{${t.id}.inputs.who}}`], message: "Darf {{$runner.name}} das?" }, "Freigabe");
  const yes = node("action.record.create", { database: dbId, values: { title: "genehmigt" } }, "Ja");
  const no = node("action.record.create", { database: dbId, values: { title: "abgelehnt" } }, "Nein");
  // Activated by the editor: runs as the editor.
  const { pageId } = await workflow("Approve", { nodes: [t, ask, yes, no], edges: [edge(t, ask), edge(ask, yes, "approved"), edge(ask, no, "rejected")] }, editor);
  await manual(pageId, { who: guest.id }, editor);
  await drainWorkflows();
  const r = await lastRun(pageId);
  assert.equal(r.status, "waiting");
  const approval = (await one<{ id: string; approvers: string; message: string }>("SELECT id,approvers,message FROM workflow_approvals WHERE run_id=?", r.id))!;
  // Guests never approve; members who see the workflow page do.
  assert.deepEqual(JSON.parse(approval.approvers).sort(), [editor.id, viewer.id].sort());
  assert.equal(approval.message, "Darf editor das?");
  assert.ok((await opsNotices(viewer.id)).some((n) => n.page_id === pageId && /Freigabe erbeten/.test(n.body)));
  assert.equal((await opsNotices(guest.id)).length, 0);
  // Listed for the approver, open.
  const mine = await get("workflow-approvals", viewer);
  assert.ok(mine.approvals.some((a: { id: string; canDecide: boolean }) => a.id === approval.id && a.canDecide));
  // Not with an API token, not by someone else.
  await assert.rejects(act({ action: "workflow.approve", approvalId: approval.id, decision: "approved" }, { ...viewer, apiScope: "write" }), /angemeldet/);
  await assert.rejects(act({ action: "workflow.approve", approvalId: approval.id, decision: "approved" }, owner), /nicht eingetragen/);
  await act({ action: "workflow.approve", approvalId: approval.id, decision: "approved", comment: "ok" }, viewer);
  await assert.rejects(act({ action: "workflow.approve", approvalId: approval.id, decision: "rejected" }, editor), /schon entschieden/);
  await drainWorkflows();
  const done = await lastRun(pageId);
  assert.equal(done.status, "succeeded");
  const out = await outputOf(done.id, ask.id);
  assert.equal(out.decidedBy.id, viewer.id);
  assert.equal(out.comment, "ok");
  // The record was created as the editor (who it runs as), not the viewer (who cannot write).
  const created = await one<{ created_by: string }>("SELECT created_by FROM rows WHERE page_id=? AND cells LIKE '%genehmigt%'", dbId);
  assert.equal(created?.created_by, editor.id);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.approved' AND resource_id=?", pageId));
});

test("approval: deadline → timeout port; cancelling a run cancels its approval; dry runs assume a decision", async () => {
  const t = manualTrigger();
  const ask = node("logic.approval", { approvers: [owner.id], message: "?", deadline: { amount: 2, unit: "hours" }, onTimeout: "timeout" }, "Mit Frist");
  const late = node("logic.set", { values: [{ name: "x", value: "zu spät", type: "text" }] }, "Zu spät");
  const { pageId } = await workflow("Deadline", { nodes: [t, ask, late], edges: [edge(t, ask), edge(ask, late, "timeout")] });
  await manual(pageId);
  await drainWorkflows();
  const r = await lastRun(pageId);
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600_000 + 5000 });
  try {
    await drainWorkflows();
  } finally {
    mock.timers.reset();
  }
  assert.equal((await one<{ status: string }>("SELECT status FROM workflow_runs WHERE id=?", r.id))!.status, "succeeded");
  assert.equal((await one<{ decision: string }>("SELECT decision FROM workflow_approvals WHERE run_id=?", r.id))!.decision, "timeout");
  assert.ok((await stepsOf(r.id)).some((s) => s.node_id === late.id));
  // Cancel while waiting.
  await manual(pageId);
  await drainWorkflows();
  const open = await lastRun(pageId);
  assert.equal(open.status, "waiting");
  assert.equal((await act({ action: "workflow.run.cancel", runId: open.id })).cancelled, true);
  assert.equal((await one<{ decision: string }>("SELECT decision FROM workflow_approvals WHERE run_id=?", open.id))!.decision, "cancelled");
  const view = (await get(`workflows/${pageId}/approvals`)).approvals.find((a: { runId: string }) => a.runId === open.id);
  assert.equal(view.canDecide, false);
  // A dry run assumes "rejected" when asked.
  const ask2 = node("logic.approval", { approvers: [owner.id], message: "?" }, "Frei");
  const no = node("logic.set", { values: [{ name: "x", value: "nein", type: "text" }] }, "Nein");
  await act({ action: "workflow.draft", pageId, graph: { nodes: [t, ask2, no], edges: [edge(t, ask2), edge(ask2, no, "rejected")] } });
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", assume: "rejected", data: { kind: "sample" } });
  await drainWorkflows();
  assert.equal((await outputOf(dry.runId, ask2.id)).assumed, true);
  assert.ok((await stepsOf(dry.runId)).some((s) => s.node_id === no.id));
});

test("errors per node: retries, the error port, continue; retry from the failed node; messages to the person responsible", async () => {
  const t = manualTrigger([{ name: "row" }]);
  // Updating a record that does not exist: a validation error (no retry).
  const upd = node("action.record.update", { record: `{{${t.id}.inputs.row}}`, database: dbId, values: { title: "x" } }, "Ändern", { onError: { retry: 0, then: "port" } });
  const caught = node("logic.set", { values: [{ name: "e", value: `{{${"" }${"upd"}}}`, type: "text" }] }, "Fehler");
  caught.config = { values: [{ name: "e", value: `{{${upd.id}.kind}}`, type: "text" }] };
  const { pageId } = await workflow("Errors", { nodes: [t, upd, caught], edges: [edge(t, upd), edge(upd, caught, "error")] });
  await manual(pageId, { row: "00000000-0000-4000-8000-000000000000" });
  await drainWorkflows();
  let r = await lastRun(pageId);
  assert.equal(r.status, "succeeded");
  assert.equal((await outputOf(r.id, caught.id)).e, "validation");
  // "continue": goes on with an empty output.
  await S.redraft(pageId, { nodes: [t, { ...upd, onError: { retry: 0, then: "continue" } }, caught], edges: [edge(t, upd), edge(upd, caught)] });
  await manual(pageId, { row: "00000000-0000-4000-8000-000000000000" });
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "succeeded");
  // "fail": the run fails; the person it runs as hears it once (first failure after a success).
  await S.redraft(pageId, { nodes: [t, { ...upd, onError: { retry: 0, then: "fail" } }], edges: [edge(t, upd)] });
  const before = (await opsNotices(owner.id)).length;
  const row = (await act({ action: "row.create", pageId: dbId, cells: { title: "später" } })).id as string;
  // The record exists only in another database at first: the step fails…
  await manual(pageId, { row: "00000000-0000-4000-8000-000000000001" });
  await drainWorkflows();
  r = await lastRun(pageId);
  assert.equal(r.status, "failed");
  const notes = await opsNotices(owner.id);
  assert.equal(notes.length, before + 1);
  assert.match(notes.at(-1)!.body, /fehlgeschlagen/);
  // A second failure within the hour: no new message, but a summary later.
  await manual(pageId, { row: "00000000-0000-4000-8000-000000000001" });
  await drainWorkflows();
  assert.equal((await opsNotices(owner.id)).length, before + 1);
  await flushNotices(Date.now() + 3_700_000);
  assert.match((await opsNotices(owner.id)).at(-1)!.body, /1 Läufe fehlgeschlagen/);
  // Retry from the failed node: the same step again (after fixing the data: the step reads the run's input).
  const failed = await lastRun(pageId);
  const failedStep = (await stepsOf(failed.id)).find((s) => s.status === "failed")!;
  await run("UPDATE workflow_steps SET output=? WHERE run_id=? AND node_id=?", JSON.stringify({ inputs: { row } }), failed.id, t.id);
  await assert.rejects(act({ action: "workflow.run.retry", runId: failed.id, fromNode: t.id }), /fehlgeschlagenen Knoten/);
  await assert.rejects(act({ action: "workflow.run.retry", runId: failed.id }, viewer), /Keine Berechtigung/);
  await act({ action: "workflow.run.retry", runId: failed.id, fromNode: failedStep.node_id });
  await drainWorkflows();
  assert.equal((await one<{ status: string }>("SELECT status FROM workflow_runs WHERE id=?", failed.id))!.status, "succeeded");
  assert.equal((await stepsOf(failed.id)).find((s) => s.id === failedStep.id)!.attempt, 1);
  assert.equal((await cells(row)).title, "x");
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.run.retried' AND resource_id=?", pageId));
  await assert.rejects(act({ action: "workflow.run.retry", runId: failed.id }), /Nur fehlgeschlagene/);
});

test("auto-pause: more than half of the last 20 runs in an hour failed; the responsible people hear it", async () => {
  const t = manualTrigger([{ name: "ok" }]);
  const gate = node("logic.if", { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: `{{${t.id}.inputs.ok}}`, op: "eq", value: "1" }] } }, "Gut?");
  const stop = node("logic.stop", { result: "failed", message: "schlecht" }, "Schlecht");
  const { pageId } = await workflow("Flaky", { nodes: [t, gate, stop], edges: [edge(t, gate), edge(gate, stop, "false")] }, editor);
  // Alternating (never 10 in a row): 6 good, then 7 bad among 13.
  for (const ok of ["1", "0", "1", "0", "1", "0", "1", "0", "1", "0", "1", "0"]) {
    await manual(pageId, { ok }, editor);
    await drainWorkflows();
  }
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "active");
  assert.equal(await checkFailureRate(pageId), false);
  await manual(pageId, { ok: "0" }, editor);
  await drainWorkflows();
  const wf = (await one<{ status: string; pause_reason: string }>("SELECT status,pause_reason FROM workflows WHERE page_id=?", pageId))!;
  assert.equal(wf.status, "auto_paused");
  assert.match(wf.pause_reason, /Hälfte/);
  // The runner (editor) and the workspace's owner are told.
  assert.ok((await opsNotices(editor.id)).some((n) => n.page_id === pageId && /automatisch pausiert/.test(n.body)));
  assert.ok((await opsNotices(owner.id)).some((n) => n.page_id === pageId && /automatisch pausiert/.test(n.body)));
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.auto_paused' AND resource_id=?", pageId));
  // Reactivating: "resumed".
  await act({ action: "workflow.activate", pageId }, editor);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='workflow.resumed' AND resource_id=?", pageId));
});

test("pause with “cancel running runs” cancels waiting runs and their approvals; without it they are held", async () => {
  const t = manualTrigger();
  const ask = node("logic.approval", { approvers: [owner.id], message: "?" }, "Warte");
  const { pageId } = await workflow("Pause", chain(t, ask));
  await manual(pageId);
  await manual(pageId);
  await drainWorkflows();
  await act({ action: "workflow.pause", pageId });
  assert.deepEqual((await runsOf(pageId)).map((r) => r.status), ["held", "held"]);
  await act({ action: "workflow.activate", pageId });
  await act({ action: "workflow.pause", pageId, cancelRuns: true });
  assert.deepEqual((await runsOf(pageId)).map((r) => r.status), ["cancelled", "cancelled"]);
  assert.deepEqual((await all<{ decision: string }>("SELECT decision FROM workflow_approvals WHERE page_id=?", pageId)).map((a) => a.decision), ["cancelled", "cancelled"]);
});

test("conditions: date and yes/no placeholders as compare value, decimal comma (If, Switch, Find records)", async () => {
  const { evaluateConditions } = await import("../lib/workflows/nodes/logic");
  const scope = { values: { n_a: { due: "2026-11-01", flag: true, off: false, price: 1234.5, name: "Ann" }, $today: "2026-11-09", $now: "2026-11-09T10:00:00.000Z" }, timeZone: "Europe/Berlin", locale: "de" as const };
  const c = (left: string, op: string, value?: string, extra: object = {}) =>
    evaluateConditions({ kind: "group", join: "and", rules: [{ kind: "condition", left, op, value, ...extra } as never] }, scope as never, scope.timeZone);
  assert.equal(await c("{{n_a.due}}", "before", "{{$today}}"), true);
  assert.equal(await c("{{n_a.due}}", "after", "{{$today}}"), false);
  assert.equal(await c("{{n_a.due}}", "on_or_before", "{{$now}}"), true);
  assert.equal(await c("{{$today}}", "after", "{{n_a.due}}"), true);
  assert.equal(await c("{{n_a.due}}", "eq", "{{n_a.due}}"), true);
  assert.equal(await c("{{n_a.due}}", "between", "{{n_a.due}}", { to: "{{$today}}" }), true);
  assert.equal(await c("{{n_a.flag}}", "eq", "{{n_a.flag}}"), true);
  assert.equal(await c("{{n_a.flag}}", "eq", "{{n_a.off}}"), false);
  assert.equal(await c("{{n_a.off}}", "eq", "false"), true);
  // Text around a placeholder stays text in the workflow's language.
  assert.equal(await c("Fällig 01.11.2026", "eq", "Fällig {{n_a.due}}"), true);
  assert.equal(await c("{{n_a.name}}", "eq", "ann"), true);
  // A decimal comma in the compare value counts as on the left side.
  assert.equal(await c("{{n_a.price}}", "gt", "1000,5"), true);
  assert.equal(await c("{{n_a.price}}", "lt", "1000,5"), false);
  assert.equal(await c("{{n_a.price}}", "between", "1000,5", { to: "2000,25" }), true);
  assert.equal(await c("{{n_a.price}}", "gt", "1000.5"), true);

  // Switch with a date placeholder as a case value.
  const t = manualTrigger();
  const sw = node("logic.switch", { value: "2020-01-01", cases: [{ id: "a", label: "Früher", op: "before", value: "{{$today}}" }] }, "Wann");
  const a = node("logic.set", { values: [{ name: "x", value: "A", type: "text" }] }, "A");
  const d = node("logic.set", { values: [{ name: "x", value: "D", type: "text" }] }, "D");
  const sp = await workflow("Switch date", { nodes: [t, sw, a, d], edges: [edge(t, sw), edge(sw, a, "case:a"), edge(sw, d, "default")] });
  await manual(sp.pageId);
  await drainWorkflows();
  assert.ok((await stepsOf((await lastRun(sp.pageId)).id)).some((s) => s.node_id === a.id));

  // Find records: due before today, and a number with a decimal comma.
  const dates = await makeDatabase("Fristen", [{ id: "title", name: "Title", type: "text" }, { id: "due", name: "Due", type: "date" }, { id: "n", name: "Count", type: "number" }] as never);
  await act({ action: "row.create", pageId: dates, cells: { title: "old", due: "2020-01-01", n: 2.5 } });
  await act({ action: "row.create", pageId: dates, cells: { title: "future", due: "2099-01-01", n: 1 } });
  const t2 = manualTrigger();
  const before = node("action.record.find", { database: dates, filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: "due", op: "before", value: "{{$today}}" }] }, limit: 10 }, "Alt");
  const more = node("action.record.find", { database: dates, filter: { kind: "group", join: "and", rules: [{ kind: "condition", left: "n", op: "gt", value: "1,5" }] }, limit: 10 }, "Mehr");
  const fp = await workflow("Find date", chain(t2, before, more));
  await manual(fp.pageId);
  await drainWorkflows();
  const r = await lastRun(fp.pageId);
  assert.equal(r.status, "succeeded");
  assert.equal(((await outputOf(r.id, before.id)) as { count: number }).count, 1);
  assert.equal(((await outputOf(r.id, more.id)) as { count: number }).count, 1);
});
