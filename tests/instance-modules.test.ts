// Features switched off for the whole instance (#386, lib/instance-modules.ts):
// stored strictly, audited, in the bootstrap next to the person's own
// switches (#378); the server refuses their commands, routes and MCP tools,
// their background work skips, and what exists is kept – read-only – and
// back as it was once they are on again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-instance-modules-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI = "on";
process.env.FLOWPLAN_WORKFLOW_POLL_MS = "50";
delete process.env.OIDC_ISSUER;
const { id, one, all, run, transaction } = await import("../lib/db");
const { command, bootstrap, database, pageData } = await import("../lib/api");
const { identityFromToken, HttpError } = await import("../lib/auth");
const { createWorkspace } = await import("../lib/seed");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const modules = await import("../lib/instance-modules");
const client = await import("../lib/feature-modules-client");
const { effectiveHidden } = await import("../lib/feature-modules");
const { emitWorkflowEvent } = await import("../lib/workflows/events");
const { workflowSchedulesPaused } = await import("../lib/workflows/schedules");
const { startWorkflowWorker, stopWorkflowWorker } = await import("../lib/workflows/queue");
const { receiveWorkflowHook } = await import("../lib/workflows/inbound");
const { aiWorkerRound } = await import("../lib/ai/database");
const { resolveAi } = await import("../lib/ai/resolve");
const { studyReminderRound } = await import("../lib/study-reminders");
const { meetingReminderRound } = await import("../lib/meeting-reminders");
const { getForm } = await import("../lib/forms");
const { handleMcpMessage } = await import("../lib/mcp");

async function account(name: string, admin = false) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,1)", uid, `local:${uid}`, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  const identity = (await identityFromToken(token))!;
  return { ...identity, isAdmin: admin } as Identity;
}
const status = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    if ((error as Error).name === "ZodError") return 400;
    throw error;
  }
};
const message = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const admin = await account("Admin", true);
const anna = await account("Anna");
const wid = await createWorkspace(anna.id, "Instanz");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(anna, body);
const setOff = async (off: string[]) => await command(admin, { action: "admin.settings", settings: { modulesOff: off } });

test("stored strictly, read leniently, audited per change, admins only", async () => {
  assert.deepEqual((await instanceSettings()).modulesOff, []);
  assert.equal(await status(() => setOff(["workflows", "nonsense"])), 400);
  assert.equal(await status(() => setOff(["workflows", "workflows"])), 400);
  assert.equal(await status(() => command(anna, { action: "admin.settings", settings: { modulesOff: ["ai"] } })), 403);
  await setOff(["workflows", "flashcards"]);
  assert.deepEqual((await instanceSettings()).modulesOff, ["flashcards", "workflows"]);
  await setOff(["flashcards", "ai"]);
  const entries = await all<{ detail: string }>("SELECT detail FROM audit WHERE action='admin.modulesOff' AND actor_id=?", admin.id);
  assert.deepEqual(entries.map((e) => e.detail).sort(), ["off: ai; on: workflows", "off: flashcards, workflows"].sort());
  // Saving something else writes no entry.
  await command(admin, { action: "admin.settings", settings: { name: "Test" } });
  assert.equal((await all("SELECT 1 FROM audit WHERE action='admin.modulesOff'")).length, 2);
  // A value of a later version read leniently.
  await run("UPDATE instance_settings SET value=? WHERE key='modulesOff'", JSON.stringify(["ai", "gone-later"]));
  assert.deepEqual((await instanceSettings()).modulesOff, ["ai"]);
  assert.equal(modules.modulesOffChange(["ai"], ["ai"]), "");
  await saveInstanceSettings({ modulesOff: [] });
});

test("the person's switches and the instance's: effective = on for the instance and not hidden by the person", async () => {
  await act({ action: "profile.modules", hidden: ["journal"] });
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: ["journal"], own: true, standard: [] });
  await saveInstanceSettings({ modulesOff: ["workflows"] });
  const boot = (await bootstrap(anna, wid)).modules!;
  assert.deepEqual(boot, { hidden: ["journal"], own: true, standard: [], off: ["workflows"] });
  // The person's own choice stays theirs; the instance's comes on top.
  assert.deepEqual(effectiveHidden(boot.hidden, boot.off), ["journal", "workflows"]);
  client.setFeatureModulesFromServer(boot);
  assert.deepEqual(client.hiddenModules(), ["journal", "workflows"]);
  assert.ok(!client.moduleShown("workflows"));
  assert.ok(client.moduleOffHere("workflows"));
  assert.ok(!client.moduleOffHere("journal"));
  // Showing everything again does not bring back what the instance switched off.
  await client.saveFeatureModules(async () => undefined, []);
  assert.deepEqual(client.hiddenModules(), ["workflows"]);
  client.setFeatureModulesOff([]);
  assert.deepEqual(client.hiddenModules(), []);
  // The answer of profile.modules carries `off` as well.
  const saved = (await act({ action: "profile.modules", hidden: null })) as { modules: unknown };
  assert.deepEqual(saved.modules, { hidden: [], own: false, standard: [], off: ["workflows"] });
  await saveInstanceSettings({ modulesOff: [] });
  assert.deepEqual((await bootstrap(anna, wid)).modules, { hidden: [], own: false, standard: [] });
});

test("nothing new of a switched-off kind; their commands answer 403 with a clear message", async () => {
  await saveInstanceSettings({ modulesOff: ["whiteboards", "notebooks", "journal", "dashboards", "workflows", "flashcards", "forms", "meetings"] });
  for (const kind of ["whiteboard", "notebook", "journal", "dashboard", "workflow"]) {
    assert.equal(await status(() => act({ action: "page.create", workspaceId: wid, spaceId: space, kind, title: kind })), 403, kind);
  }
  assert.equal(await message(() => act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "whiteboard" })), "Whiteboards sind auf dieser Instanz ausgeschaltet.");
  // Documents and databases always stay.
  assert.equal(await status(() => act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Doc" })), 200);
  for (const action of ["study.settings", "study.review", "dashboard.save", "workflow.run", "workflow.draft", "notebook.sheet.add", "journal.entry", "whiteboard.sync", "form.update", "form.submit", "survey.save", "meeting.note"])
    assert.equal(await status(() => act({ action })), 403, action);
  // The English of every refusal (lib/i18n-errors.ts).
  const { localizedMessage } = await import("../lib/i18n-errors");
  for (const text of Object.values(modules.MODULE_OFF_TEXT)) assert.notEqual(localizedMessage(text, "en"), text, text);
  await saveInstanceSettings({ modulesOff: [] });
});

test("database views: no new view of a switched-off type, the existing ones stay", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Aufgaben" })).id as string;
  const d = await database(pageId);
  const gallery = { ...d.views[0], id: id(), name: "Galerie", type: "gallery" };
  await act({ action: "database.update", pageId, version: d.version, fields: d.fields, views: [...d.views, gallery] });
  await saveInstanceSettings({ modulesOff: ["views"] });
  const now = await database(pageId);
  const types = now.views.map((v) => v.type);
  // Another gallery: refused; the one there is kept on every save.
  const second = { ...now.views[0], id: id(), name: "Zweite", type: "gallery" };
  assert.equal(await status(() => act({ action: "database.update", pageId, version: now.version, fields: now.fields, views: [...now.views, second] })), 403);
  // Switching the table to a gallery: refused as well.
  assert.equal(await status(() => act({ action: "database.update", pageId, version: now.version, fields: now.fields, views: now.views.map((v, i) => (i ? v : { ...v, type: "gallery" })) })), 403);
  await act({ action: "database.update", pageId, version: now.version, fields: now.fields, views: now.views.map((v) => ({ ...v, name: `${v.name}!` })) });
  assert.deepEqual((await database(pageId)).views.map((v) => v.type), types);
  await saveInstanceSettings({ modulesOff: [] });
  const after = await database(pageId);
  await act({ action: "database.update", pageId, version: after.version, fields: after.fields, views: [...after.views, second] });
  assert.equal((await database(pageId)).views.length, types.length + 1);
});

test("existing pages of a switched-off kind are kept read-only and come back as they were", async () => {
  const board = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "whiteboard", title: "Tafel" })).id as string;
  await pageData(anna, board);
  const before = await one<{ state: unknown }>("SELECT state FROM whiteboards WHERE page_id=?", board);
  await saveInstanceSettings({ modulesOff: ["whiteboards"] });
  // Listed and readable.
  assert.ok((await bootstrap(anna, wid)).pages.some((p) => p.id === board));
  assert.equal((await pageData(anna, board)).page.id, board);
  // Not changed through general commands either; no copy of it.
  assert.equal(await status(() => act({ action: "page.duplicate", pageId: board })), 403);
  assert.equal(await status(() => act({ action: "page.properties", pageId: board, properties: {} })), 403);
  // Renaming, moving to the trash and back stay.
  await act({ action: "page.update", pageId: board, patch: { title: "Tafel 2" } });
  await act({ action: "page.delete", pageId: board });
  await act({ action: "page.restore", pageId: board });
  assert.equal((await one<{ deleted_at: unknown }>("SELECT deleted_at FROM pages WHERE id=?", board))!.deleted_at, null);
  const during = await one<{ state: unknown }>("SELECT state FROM whiteboards WHERE page_id=?", board);
  assert.deepEqual(during, before, "the board itself is untouched");
  // On again: as before.
  await saveInstanceSettings({ modulesOff: [] });
  assert.equal(await status(() => act({ action: "page.duplicate", pageId: board })), 200);
});

test("workflows off: no events recorded, no schedules, no hook, the queue waits and resumes", async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Effekte" })).id as string;
  const graph = {
    nodes: [
      { id: "n_trig00", type: "trigger.manual", label: "Start", config: { inputs: [{ name: "i", type: "text" }] } },
      { id: "n_make00", type: "action.record.create", label: "Make", config: { database: db, values: { title: "{{n_trig00.inputs.i}}" } } },
    ],
    edges: [{ id: "e_1", from: { node: "n_trig00", port: "out" }, to: { node: "n_make00", port: "in" } }],
  };
  const wf = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Effekte" })).id as string;
  await act({ action: "workflow.draft", pageId: wf, graph });
  assert.equal((await act({ action: "workflow.activate", pageId: wf })).ok, true);
  const event = (i: string) => ({ workspaceId: wid, scopeId: wf, actorId: anna.id, payload: { workflow: wf, node: "n_trig00", inputs: { i }, source: "api" }, checked: true });
  // Queued while on, before any worker runs.
  await transaction(async () => {
    assert.ok(await emitWorkflowEvent("manual", event("queued")));
  });
  await saveInstanceSettings({ modulesOff: ["workflows"] });
  // While off: nothing new is recorded (no backlog for later) …
  await transaction(async () => {
    assert.equal(await emitWorkflowEvent("manual", event("while off")), null);
  });
  assert.equal((await all("SELECT 1 FROM workflow_events")).length, 1);
  assert.ok(await workflowSchedulesPaused());
  assert.equal(await status(() => receiveWorkflowHook({ token: "x".repeat(40), headers: new Headers(), body: Buffer.from(""), query: new URLSearchParams() } as never)), 403);
  // … and the queue does not take what waits.
  startWorkflowWorker();
  try {
    await sleep(400);
    assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_events WHERE dispatched_at IS NULL"))!.n, 1);
    assert.equal((await all("SELECT 1 FROM rows WHERE page_id=?", db)).length, 0);
    // On again: the queued event runs, the workflow is as it was.
    await saveInstanceSettings({ modulesOff: [] });
    assert.ok(!(await workflowSchedulesPaused()));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await all("SELECT 1 FROM rows WHERE page_id=?", db)).length) await sleep(50);
    const titles = (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", db)).map((r) => JSON.parse(r.cells).title);
    assert.deepEqual(titles, ["queued"]);
    assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", wf))!.status, "active");
  } finally {
    await stopWorkflowWorker(1000);
  }
});

test("AI off: the AI is refused and its background round pauses with its queue kept", async () => {
  const before = await resolveAi(anna, "ask", { workspaceId: wid });
  assert.ok(!before.ok && before.reason !== "off", "on: something else is missing (no provider)");
  await saveInstanceSettings({ modulesOff: ["ai"] });
  const off = await resolveAi(anna, "ask", { workspaceId: wid });
  assert.ok(!off.ok && off.reason === "off");
  await run("INSERT INTO ai_auto_dirty(row_id,page_id,changed_at) VALUES(?,?,0)", id(), id());
  assert.equal(await aiWorkerRound(), false);
  assert.equal((await all("SELECT 1 FROM ai_auto_dirty")).length, 1, "kept while paused");
  await saveInstanceSettings({ modulesOff: [] });
  assert.equal(await aiWorkerRound(), true);
});

test("flashcards and meetings off: their reminders skip", async () => {
  assert.notEqual(await studyReminderRound(), null);
  assert.notEqual(await meetingReminderRound(), null);
  await saveInstanceSettings({ modulesOff: ["flashcards", "meetings"] });
  assert.equal(await studyReminderRound(), null);
  assert.equal(await meetingReminderRound(), null);
  await saveInstanceSettings({ modulesOff: [] });
});

test("forms off: every form is closed with a message", async () => {
  // Without forms on, an unknown token is just not found.
  assert.equal(await status(() => getForm("unknown-token", null)), 404);
  await saveInstanceSettings({ modulesOff: ["forms"] });
  assert.equal(await status(() => getForm("unknown-token", null)), 403);
  assert.equal(await message(() => getForm("unknown-token", null)), "Formulare sind auf dieser Instanz ausgeschaltet.");
  await saveInstanceSettings({ modulesOff: [] });
});

test("MCP: tools of a switched-off feature are left out and refused", async () => {
  const token = { ...anna, apiScope: "read" } as Identity;
  const names = async () => ((await handleMcpMessage(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as unknown as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok((await names()).includes("list_workflows"));
  await saveInstanceSettings({ modulesOff: ["workflows", "flashcards"] });
  const listed = await names();
  assert.ok(!listed.includes("list_workflows") && !listed.includes("study_decks"));
  assert.ok(listed.includes("list_pages"));
  const call = (await handleMcpMessage(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_workflows", arguments: { workspaceId: wid } } })) as unknown as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /Workflows/);
  await saveInstanceSettings({ modulesOff: [] });
});

test("which commands and tools belong to a feature", () => {
  assert.equal(modules.commandModule("study.review"), "flashcards");
  assert.equal(modules.commandModule("workflow.run.retry"), "workflows");
  assert.equal(modules.commandModule("form.submit"), "forms");
  assert.equal(modules.commandModule("page.delete"), undefined);
  assert.equal(modules.commandModule("admin.workflowLimits"), undefined);
  assert.equal(modules.toolModule("run_workflow"), "workflows");
  assert.equal(modules.toolModule("get_meeting_note"), "meetings");
  assert.equal(modules.toolModule("set_flashcard_parameters"), "flashcards");
  assert.equal(modules.toolModule("list_pages"), undefined);
  assert.equal(modules.pageModule({ kind: "document", journal_date: "2026-11-19" }), "journal");
  assert.equal(modules.pageModule({ kind: "database" }), undefined);
});
