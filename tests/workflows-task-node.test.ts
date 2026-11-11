// The workflow node "Aufgabe erstellen" (#208, action.task.create in
// lib/workflows/nodes/pages.ts): a task with placeholders, a person and a
// due date in a chosen page or the own task page of the person it runs as,
// with that person's rights; dry runs change nothing; locked pages,
// journals behind a PIN and encrypted spaces are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workflow-task-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { workflowGet } = await import("../lib/workflows/commands");
const { withReadMemo } = await import("../lib/read-memo");
const { myTasks } = await import("../lib/doc-tasks");
const { personalTaskPage } = await import("../lib/personal-tasks");
const { nodeSpec } = await import("../lib/workflows/catalog");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await user("Olga"),
  editor = await user("Emil"),
  outsider = await user("Otto");
const wid = await createWorkspace(owner.id, "Flows");
const space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const get = async (path: string, who = owner) => {
  const url = new URL(`http://x/api/${path}`);
  return (await withReadMemo(async () => await workflowGet(who, url.pathname.slice(5).split("/"), url))) as any;
};
let seq = 0;
const nid = () => `n_k${String(++seq).padStart(5, "0")}`;
const node = (type: string, config: Record<string, unknown>, label?: string) => ({ id: nid(), type, typeVersion: 1, label: label || `${type.split(".").pop()} ${seq}`, note: "", position: { x: seq * 10, y: 0 }, disabled: false, config });
const chain = (...nodes: ReturnType<typeof node>[]) => ({
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ id: `e_${i + 1}`, from: { node: nodes[i].id, port: "out" }, to: { node: n.id, port: "in" } })),
});
async function workflow(title: string, graph: Record<string, unknown>, who = owner, activate = true) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title }, who)).id as string;
  const saved = await act({ action: "workflow.draft", pageId, graph }, who);
  if (activate) {
    const result = await act({ action: "workflow.activate", pageId }, who);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
  }
  return { pageId, issues: saved.issues as { code: string; level: string }[] };
}
const lastRun = async (pageId: string) =>
  (await all<{ id: string; status: string; error: string | null }>("SELECT id,status,error FROM workflow_runs WHERE page_id=? ORDER BY created_at,seq", pageId)).at(-1)!;
const html = async (pid: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))!.html;
const page = async (title: string, spaceId = space) => (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind: "document" })).id as string;
const manual = () => node("trigger.manual", { inputs: [{ name: "Was", type: "text", required: false }, { name: "Wann", type: "date", required: false }] });
const step = async (runId: string, nodeId: string, who = owner) => (await get(`workflow-runs/${runId}`, who)).timeline.find((s: { nodeId: string }) => s.nodeId === nodeId);

test("the catalogue knows the node, its settings check what they need", async () => {
  const spec = nodeSpec("action.task.create")!;
  assert.equal(spec.category, "pages");
  assert.equal(spec.name[0], "Aufgabe erstellen");
  assert.ok(!spec.config.safeParse({ text: "x", assignee: ["a", "b"] }).success, "one person at most");
  const trigger = manual();
  const { issues } = await workflow("Ohne Ziel", chain(trigger, node("action.task.create", { target: "page", page: "", text: " " })), owner, false);
  assert.ok(issues.some((i) => i.code === "no_target_page"));
  assert.ok(issues.some((i) => i.code === "no_task_text"));
  // A new node (the form's start) is only incomplete, not invalid.
  assert.ok(spec.config.safeParse({ target: "page", page: "", text: "", assignee: [] }).success);
  const stranger = await workflow("Fremde Person", chain(manual(), node("action.task.create", { target: "personal", text: "x", assignee: [outsider.id] })), owner, false);
  assert.ok(stranger.issues.some((i) => i.code === "unknown_person"));
});

test("a task with placeholders, a person and a due date below a heading; dry runs change nothing", async () => {
  const target = await page("Sprint");
  const trigger = manual();
  const task = node("action.task.create", {
    target: "page",
    page: target,
    text: `Bericht: {{${trigger.id}.inputs.Was}}`,
    assignee: [editor.id],
    due: `{{${trigger.id}.inputs.Wann}}`,
    heading: "Offen",
  });
  const { pageId } = await workflow("Aufgabe", chain(trigger, task));
  // Dry run: the output says what would happen, the page stays as it was.
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { Was: "Q3", Wann: "2026-12-01" } } } });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  await drainWorkflows();
  const dryStep = await step(dry.runId, task.id);
  assert.deepEqual(
    { text: dryStep.output.wouldCreate.text, due: dryStep.output.wouldCreate.due, assignee: dryStep.output.wouldCreate.assignee, page: dryStep.output.wouldCreate.page },
    { text: "Bericht: Q3", due: "2026-12-01", assignee: editor.id, page: target },
  );
  assert.ok(!/Bericht/.test(await html(target)));
  // Live.
  await act({ action: "workflow.run", pageId, inputs: { Was: "Q3", Wann: "2026-12-01" } });
  await drainWorkflows();
  const live = await lastRun(pageId);
  assert.equal(live.status, "succeeded", live.error || "");
  const body = await html(target);
  assert.match(body, /<h2>Offen<\/h2><ul data-type="taskList"><li[^>]*data-due="2026-12-01"/);
  assert.match(body, new RegExp(`Bericht: Q3 <span data-mention="${editor.id}"`));
  // A second run joins the same list under the heading.
  await act({ action: "workflow.run", pageId, inputs: { Was: "Q4" } });
  await drainWorkflows();
  const again = await html(target);
  assert.equal((again.match(/data-type="taskList"/g) || []).length, 1);
  assert.equal((again.match(/<h2>Offen<\/h2>/g) || []).length, 1);
  // Emil has it in My tasks, given by Olga (the person it runs as): new for him.
  const mine = (await myTasks(editor, wid)).filter((t) => t.pageId === target).map((t) => [t.text, t.due, t.fresh]);
  assert.deepEqual(mine, [["Bericht: Q3 @Emil", "2026-12-01", true], ["Bericht: Q4 @Emil", null, true]]);
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND body LIKE '%Aufgabe%Bericht: Q3%'", editor.id));
});

test("the own task page: made for the person it runs as, never written for someone else", async () => {
  const trigger = manual();
  const task = node("action.task.create", { target: "personal", text: "Rückruf {{" + trigger.id + ".inputs.Was}}" });
  const { pageId } = await workflow("Eigene", chain(trigger, task), editor);
  // Dry run: not even the page is made.
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { Was: "Kunde" } } } }, editor);
  await drainWorkflows();
  assert.equal((await step(dry.runId, task.id, editor)).output.wouldCreate.newPage, true);
  assert.equal(await personalTaskPage(editor, wid), null);
  await act({ action: "workflow.run", pageId, inputs: { Was: "Kunde" } }, editor);
  await drainWorkflows();
  assert.equal((await lastRun(pageId)).status, "succeeded");
  const own = (await personalTaskPage(editor, wid))!;
  assert.ok(own);
  assert.deepEqual((await myTasks(editor, wid)).filter((t) => t.own).map((t) => t.text), ["Rückruf Kunde"]);
  // Private: Olga does not see it; a workflow giving her a task there is refused.
  assert.ok(!(await myTasks(owner, wid)).some((t) => t.text === "Rückruf Kunde"));
  const other = node("action.task.create", { target: "personal", text: "Für Olga", assignee: [owner.id] });
  const refused = await workflow("Fremde Seite", chain(manual(), other), editor);
  await act({ action: "workflow.run", pageId: refused.pageId }, editor);
  await drainWorkflows();
  const failed = await lastRun(refused.pageId);
  assert.equal(failed.status, "failed");
  assert.match(failed.error || "", /privat/);
  assert.ok(!/Für Olga/.test(await html(own.id)));
});

test("refused: a person who cannot open the page, locked pages, journals behind a PIN, encrypted spaces", async () => {
  // A page only Olga can open (her private space).
  const secret = (await act({ action: "space.create", workspaceId: wid, name: "Olgas", private: true })).id as string;
  const hidden = await page("Geheim", secret);
  const forEmil = node("action.task.create", { target: "page", page: hidden, text: "Heimlich", assignee: [editor.id] });
  const a = await workflow("Unsichtbar", chain(manual(), forEmil));
  await act({ action: "workflow.run", pageId: a.pageId });
  await drainWorkflows();
  assert.match((await lastRun(a.pageId)).error || "", /Emil kann die Seite „Geheim“ nicht öffnen/);
  assert.ok(!/Heimlich/.test(await html(hidden)));
  // Locked.
  const locked = await page("Gesperrt");
  const b = await workflow("Gesperrt", chain(manual(), node("action.task.create", { target: "page", page: locked, text: "Nein" })));
  await run("UPDATE pages SET locked=1 WHERE id=?", locked);
  await act({ action: "workflow.run", pageId: b.pageId });
  await drainWorkflows();
  assert.match((await lastRun(b.pageId)).error || "", /gesperrt/);
  // Behind a journal PIN (a day page of a journal with a PIN).
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" })).id as string;
  const day = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Notizen", kind: "document", parentId: journal })).id as string;
  const c = await workflow("PIN", chain(manual(), node("action.task.create", { target: "page", page: day, text: "Nein" })));
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET lock_hash=excluded.lock_hash", journal, "salt:hash");
  await act({ action: "workflow.run", pageId: c.pageId });
  await drainWorkflows();
  assert.match((await lastRun(c.pageId)).error || "", /Journal ist gesperrt/);
  assert.ok(!/Nein/.test(await html(day)));
  await run("UPDATE journal_settings SET lock_hash=NULL WHERE page_id=?", journal);
  // An encrypted space.
  const vault = (await act({ action: "space.create", workspaceId: wid, name: "Tresor", private: true })).id as string;
  const sealed = await page("Versiegelt", vault);
  const d = await workflow("E2EE", chain(manual(), node("action.task.create", { target: "page", page: sealed, text: "Nein" })));
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", vault);
  await act({ action: "workflow.run", pageId: d.pageId });
  await drainWorkflows();
  assert.match((await lastRun(d.pageId)).error || "", /verschlüsselt/);
  // The person it runs as may only read the page: refused before activating.
  await run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, editor.id);
  const readOnly = await page("Nur lesen");
  await run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, editor.id);
  await run("INSERT INTO grants(resource_id,resource_kind,workspace_id,user_id,role) VALUES(?,?,?,?,?)", readOnly, "page", wid, editor.id, "viewer");
  const e = await workflow("Lesen", chain(manual(), node("action.task.create", { target: "page", page: readOnly, text: "Nein" })), editor, false);
  assert.ok(e.issues.some((i) => i.code === "page_not_writable"), JSON.stringify(e.issues));
});
