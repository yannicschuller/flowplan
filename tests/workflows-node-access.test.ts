// The same record, field, PIN and E2EE rules in dry, test and live runs:
// a dry "update record" shows no private record or hidden field (#502),
// page nodes refuse a journal behind a PIN for a placeholder id (#503), the
// immediate part's "field:" recipients follow the runner's read rules (#509).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-node-access-"));
const { run, one, all } = await import("../lib/db");
const { database } = await import("../lib/api");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { rollJournal } = await import("../lib/journal");
const { htmlState } = await import("../lib/document-server");
const S = await import("./helpers/workflow-setup");
const { act, owner, editor, node, chain, workflow, runsOf, outputOf, get, fields, makeDatabase, wid, space } = S;

const html = async (p: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", p))?.html || "";
type Step = { nodeId: string; status: string; output?: Record<string, unknown> | null; error?: string | null };
async function stepOf(runId: string, nodeId: string, who = editor) {
  const d = await get(`workflow-runs/${runId}`, who);
  return { run: d, step: (d.timeline as Step[]).find((s) => s.nodeId === nodeId) };
}

/* ---------- #502: dry "update record" and the record and field rules ---------- */

test("#502: a dry run shows no private record and no field hidden from the runner", async () => {
  const dbFields = [...fields, { id: "secret", name: "Secret", type: "text", access: { read: "owners" } }];
  const dbId = await makeDatabase("Private records", dbFields as never);
  const priv = (await act({ action: "row.create", pageId: dbId, cells: { title: "PRIVATE-TITLE", body: "PRIVATE-BODY", secret: "PRIVATE-SECRET" } })).id as string;
  await act({ action: "row.access", pageId: dbId, rowId: priv, access: "private", grants: [] });
  const vis = (await act({ action: "row.create", pageId: dbId, cells: { title: "Visible", secret: "FIELD-RULE-VALUE" } })).id as string;
  const t = node("trigger.manual", { inputs: [{ name: "rid", type: "text", required: false }] });
  const all3 = node("action.record.update", { record: `{{${t.id}.inputs.rid}}`, values: { status: "Done", body: "z", secret: "z" } });
  const { pageId } = await workflow("Dry update", chain(t, all3), editor, false);
  for (const mode of ["dry", "test"]) {
    for (const rid of [priv, vis]) {
      const r = await act({ action: "workflow.run", pageId, mode, inputs: { rid } }, editor);
      await drainWorkflows();
      const { run: d, step } = await stepOf(r.runId, all3.id);
      assert.equal(d.status, "failed", `${mode} ${rid === priv ? "private" : "visible"}`);
      assert.equal(step?.status, "failed");
      const text = JSON.stringify(d);
      assert.equal(/PRIVATE-|FIELD-RULE-VALUE/.test(text), false, text);
    }
  }
  // Without the hidden field the visible record is updated (dry: shown) as before.
  const ok = node("action.record.update", { record: `{{${t.id}.inputs.rid}}`, values: { status: "Done" } });
  const t2 = { ...t };
  await act({ action: "workflow.draft", pageId, graph: chain(t2, ok) }, editor);
  const r = await act({ action: "workflow.run", pageId, mode: "dry", inputs: { rid: vis } }, editor);
  await drainWorkflows();
  const { step } = await stepOf(r.runId, ok.id);
  assert.equal(step?.status, "succeeded");
  const record = (step!.output as { record: { title: string; fields: Record<string, unknown> } }).record;
  assert.equal(record.title, "Visible");
  assert.equal("secret" in record.fields, false);
  // The private record in a dry run: not found, as in a test run.
  const p = await act({ action: "workflow.run", pageId, mode: "dry", inputs: { rid: priv } }, editor);
  await drainWorkflows();
  const failed = await stepOf(p.runId, ok.id);
  assert.equal(failed.step?.status, "failed");
  assert.equal(JSON.stringify(failed.run).includes("PRIVATE-"), false);
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", priv))!.cells).body, "PRIVATE-BODY");
});

/* ---------- #503: page nodes and the journal PIN ---------- */

test("#503: a placeholder page id never reaches a journal behind a PIN, in dry runs neither", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const jid = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Locked journal", kind: "journal" })).id as string;
  const jp = (await one<never>("SELECT * FROM pages WHERE id=?", jid))!;
  const { dayId } = await rollJournal(owner, jp, today, today);
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", "<p>JOURNAL-TEXT</p>", htmlState("<p>JOURNAL-TEXT</p>"), dayId);
  await act({ action: "journal.lock", pageId: jid, pin: "135790" });
  const t = node("trigger.manual", { inputs: [{ name: "p", type: "text", required: false }] });
  const append = node("action.page.append", { page: `{{${t.id}.inputs.p}}`, blocks: [{ type: "paragraph", text: "x" }] });
  const tag = node("action.page.tag", { page: `{{${t.id}.inputs.p}}`, op: "add", tags: ["x"] });
  for (const [graph, target] of [[chain(t, append), append], [chain(t, tag), tag]] as const) {
    const { pageId } = await workflow("PIN", graph, editor, false);
    for (const mode of ["dry", "test"]) {
      const r = await act({ action: "workflow.run", pageId, mode, inputs: { p: dayId } }, editor);
      await drainWorkflows();
      const { run: d, step } = await stepOf(r.runId, target.id);
      assert.equal(step?.status, "failed", mode);
      assert.equal(JSON.stringify(d).includes("JOURNAL-TEXT"), false);
    }
  }
  assert.equal((await html(dayId)).includes("x</p>"), false);
});

/* ---------- #509: "field:" recipients in the immediate part ---------- */

test("#509: the immediate part takes no recipients from a property hidden from the runner", async () => {
  const f = [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
    { id: "reviewer", name: "Reviewer", type: "person", access: { read: "owners" } },
    { id: "helper", name: "Helper", type: "person" },
  ];
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "HR" })).id as string;
  await act({ action: "database.update", pageId: db, version: (await database(db)).version, fields: f, views: (await database(db)).views });
  const trigger = node("trigger.record.changed", { database: db });
  const hidden = node("notify.person", { to: ["field:reviewer"], title: "hidden probe", message: "", link: "none", channels: ["inbox"] });
  const open = node("notify.person", { to: ["field:helper"], title: "open probe", message: "", link: "none", channels: ["inbox"] });
  const { pageId } = await workflow("Inline notify", chain(trigger, hidden, open), editor);
  assert.equal((await one<{ inline: number }>("SELECT inline FROM workflow_triggers WHERE page_id=?", pageId))!.inline, 1);
  const rid = (await act({ action: "row.create", pageId: db, cells: { title: "Case", status: "Open", reviewer: [owner.id], helper: [owner.id] } })).id as string;
  const v = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
  await act({ action: "row.update", pageId: db, rowId: rid, version: v, cells: { status: "Done" } });
  await drainWorkflows();
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal((await outputOf(r.id, hidden.id))?.notified, 0);
  assert.equal((await outputOf(r.id, open.id))?.notified, 1);
  const bodies = (await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='workflow'", owner.id)).map((n) => n.body);
  assert.equal(bodies.some((b) => b.includes("hidden probe")), false);
  assert.ok(bodies.some((b) => b.includes("open probe")));
});
