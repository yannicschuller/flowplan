// The workflow node "An Journaltag anhängen" (#250, action.journal.append in
// lib/workflows/nodes/journal.ts): Markdown with placeholders into today's,
// yesterday's or a given day of a journal – at the end or below a heading –
// the day made with the journal's template (and carried tasks) when it is
// missing; as the person it runs as, journals behind a PIN refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workflow-journal-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { workflowGet } = await import("../lib/workflows/commands");
const { withReadMemo } = await import("../lib/read-memo");
const { nodeSpec, catalogJson } = await import("../lib/workflows/catalog");
const { compactCatalog } = await import("../lib/workflows/ai-builder");
const { rollJournal } = await import("../lib/journal");
const { pageRole } = await import("../lib/permissions");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await user("Olga"),
  editor = await user("Emil");
const wid = await createWorkspace(owner.id, "Flows");
const space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const get = async (path: string, who = owner) => {
  const url = new URL(`http://x/api/${path}`);
  return (await withReadMemo(async () => await workflowGet(who, url.pathname.slice(5).split("/"), url))) as any;
};
let seq = 0;
const nid = () => `n_j${String(++seq).padStart(5, "0")}`;
const node = (type: string, config: Record<string, unknown>, label?: string) => ({ id: nid(), type, typeVersion: 1, label: label || `${type.split(".").pop()} ${seq}`, note: "", position: { x: seq * 10, y: 0 }, disabled: false, config });
// A far-east time zone: its day is often not the UTC day – "today" must be the workflow's.
const ZONE = "Pacific/Kiritimati";
const chain = (...nodes: ReturnType<typeof node>[]) => ({
  settings: { timeZone: ZONE, triggerOnOwnChanges: false, limits: {} },
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
const step = async (runId: string, nodeId: string, who = owner) => (await get(`workflow-runs/${runId}`, who)).timeline.find((s: { nodeId: string }) => s.nodeId === nodeId);
const html = async (pid: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))!.html;
const write = async (pid: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pid);
const manual = () => node("trigger.manual", { inputs: [{ name: "Was", type: "text", required: false }, { name: "Wann", type: "date", required: false }] });
const zoned = (offset = 0) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const newJournal = async (title: string, template = "") => {
  const jid = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title, kind: "journal" })).id as string;
  if (template) await act({ action: "journal.settings", pageId: jid, template });
  return jid;
};
const dayOf = async (jid: string, date: string) => await one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", jid, date);
const runIt = async (pageId: string, inputs: Record<string, unknown> = {}, who = owner) => {
  await act({ action: "workflow.run", pageId, inputs }, who);
  await drainWorkflows();
  return await lastRun(pageId);
};
// The order of a day's blocks: headings by text, other blocks by their text.
const outline = (body: string) =>
  [...body.matchAll(/<h3[^>]*>(.*?)<\/h3>|<li[^>]*data-type="taskItem"[^>]*>.*?<p>(.*?)<\/p>|<li><p>(.*?)<\/p>|<p>(.*?)<\/p>/g)]
    .map((m) => (m[1] !== undefined ? `# ${m[1]}` : m[2] !== undefined ? `[ ] ${m[2]}` : m[3] !== undefined ? `- ${m[3]}` : m[4]))
    .filter(Boolean);
const TEMPLATE = "<h3>Log</h3><p></p><h3>Notizen</h3><p>Gedanken</p>";

test("the catalogue, the AI builder and the API list the node; the check finds what is missing", async () => {
  const spec = nodeSpec("action.journal.append")!;
  assert.equal(spec.category, "pages");
  assert.deepEqual(spec.name, ["An Journaltag anhängen", "Append to journal day"]);
  assert.deepEqual(spec.outputs.map((o) => o.key), ["day", "date", "journal", "created", "completed"]);
  assert.ok(catalogJson().some((n) => n.type === "action.journal.append"));
  assert.match(compactCatalog(), /action\.journal\.append \[out\].*journal:string.*day:today\|yesterday\|date/);
  // A new node (the form's start) is incomplete, not invalid.
  assert.ok(spec.config.safeParse({ journal: "", content: "" }).success);
  assert.ok(!spec.config.safeParse({ journal: "", content: "", day: "tomorrow" }).success);
  const doc = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Kein Journal", kind: "document" })).id as string;
  const empty = await workflow("Leer", chain(manual(), node("action.journal.append", { journal: "", day: "date", date: "", content: " " })), owner, false);
  assert.deepEqual(empty.issues.map((i) => i.code).sort(), ["no_journal", "no_journal_content", "no_journal_date"]);
  const wrong = await workflow("Falsch", chain(manual(), node("action.journal.append", { journal: doc, content: "x", place: "heading", heading: "" })), owner, false);
  assert.ok(wrong.issues.some((i) => i.code === "unknown_journal" && i.level === "error"));
  assert.ok(wrong.issues.some((i) => i.code === "no_journal_heading" && i.level === "warning"));
});

test("today's day is made like opening it (template, carried tasks below the chosen heading); appended below a heading, values stay text", async () => {
  const jid = await newJournal("Arbeit", TEMPLATE);
  await act({ action: "journal.settings", pageId: jid, options: { carried: "heading", carriedHeading: "Notizen" } });
  // A day before, with an open task that moves over.
  const before = (await rollJournal(owner, (await one<Page>("SELECT * FROM pages WHERE id=?", jid))!, zoned(-2), zoned(-2))).dayId;
  await write(before, `<p>Eintrag</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Offen</p></li></ul>`);
  const trigger = manual();
  const append = node("action.journal.append", {
    journal: jid,
    day: "today",
    content: `- Lauf **{{${trigger.id}.inputs.Was}}**\n- [ ] Prüfen`,
    place: "heading",
    heading: "Log",
  });
  const { pageId } = await workflow("Log", chain(trigger, append));
  // A dry run makes no day.
  const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "custom", output: { inputs: { Was: "A" } } } });
  await drainWorkflows();
  const dryStep = await step(dry.runId, append.id);
  assert.deepEqual({ date: dryStep.output.wouldAppend.date, newDay: dryStep.output.wouldAppend.newDay }, { date: zoned(), newDay: true });
  assert.equal(await dayOf(jid, zoned()), undefined);
  // Live: the value holds Markdown, which stays text.
  const live = await runIt(pageId, { Was: "*eins* <b>x</b>" });
  assert.equal(live.status, "succeeded", live.error || "");
  const day = (await dayOf(jid, zoned()))!;
  assert.ok(day, "today's day was made");
  const body = await html(day.id);
  assert.deepEqual(outline(body), ["# Log", "- Lauf <strong>*eins* &lt;b&gt;x&lt;/b&gt;</strong>", "[ ] Prüfen", "# Notizen", "[ ] Offen", "Gedanken"]);
  assert.match(body, /<strong>\*eins\* &lt;b&gt;x&lt;\/b&gt;<\/strong>/, "the author's bold applies, the value is text");
  assert.doesNotMatch(await html(before), /Offen/, "the open task moved over");
  const out = (await step(live.id, append.id)).output;
  assert.deepEqual({ day: out.day.id, date: out.date, journal: out.journal.id, created: out.created }, { day: day.id, date: zoned(), journal: jid, created: true });
  // A second run joins the section, after the first.
  const again = await runIt(pageId, { Was: "zwei" });
  assert.equal(again.status, "succeeded", again.error || "");
  assert.deepEqual(outline(await html(day.id)).slice(0, 5), ["# Log", "- Lauf <strong>*eins* &lt;b&gt;x&lt;/b&gt;</strong>", "[ ] Prüfen", "- Lauf <strong>zwei</strong>", "[ ] Prüfen"]);
  assert.equal((await step(again.id, append.id)).output.created, false);
  // The heading is gone from the day: at the end.
  await act({ action: "workflow.draft", pageId, graph: chain(trigger, { ...append, config: { ...append.config, heading: "Gibt es nicht", content: "Ende" } }) });
  await act({ action: "workflow.activate", pageId });
  assert.equal((await runIt(pageId)).status, "succeeded");
  assert.equal(outline(await html(day.id)).at(-1), "Ende");
});

test("yesterday before an existing today: made with the template only; a given date from a placeholder; no future days", async () => {
  const jid = await newJournal("Privat", TEMPLATE);
  const journal = (await one<Page>("SELECT * FROM pages WHERE id=?", jid))!;
  const older = (await rollJournal(owner, journal, zoned(-3), zoned(-3))).dayId;
  await write(older, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Bleibt offen</p></li></ul><p>x</p>`);
  const today = (await rollJournal(owner, journal, zoned(), zoned())).dayId;
  assert.match(await html(today), /Bleibt offen/);
  const trigger = manual();
  const append = node("action.journal.append", { journal: jid, day: "yesterday", content: "Spät noch: {{" + trigger.id + ".inputs.Was}}" });
  const { pageId } = await workflow("Gestern", chain(trigger, append));
  const r = await runIt(pageId, { Was: "Lesen" });
  assert.equal(r.status, "succeeded", r.error || "");
  const yesterday = (await dayOf(jid, zoned(-1)))!;
  // The template, then the entry at the end of the day.
  assert.deepEqual(outline(await html(yesterday.id)), ["# Log", "# Notizen", "Gedanken", "Spät noch: Lesen"]);
  assert.doesNotMatch(await html(yesterday.id), /Bleibt offen/, "no task moves back into an earlier day");
  assert.match(await html(today), /Bleibt offen/);
  // A given date (an existing day) from a placeholder, at the end.
  const dated = node("action.journal.append", { journal: jid, day: "date", date: `{{${trigger.id}.inputs.Wann}}`, content: "Nachtrag" });
  const d = await workflow("Datum", chain(trigger, dated));
  assert.equal((await runIt(d.pageId, { Wann: zoned(-3) })).status, "succeeded");
  assert.equal(outline(await html(older)).at(-1), "Nachtrag");
  // A day in the future is refused, nothing made.
  const future = await runIt(d.pageId, { Wann: zoned(5) });
  assert.equal(future.status, "failed");
  assert.match(future.error || "", /künftigen Tag/);
  assert.equal(await dayOf(jid, zoned(5)), undefined);
  // No date given at all.
  const none = await runIt(d.pageId, {});
  assert.match(none.error || "", /Kein Datum/);
});

test("an empty template: the entry replaces the empty line; 'create on first write' journals get the day", async () => {
  const jid = await newJournal("Leer");
  await act({ action: "journal.settings", pageId: jid, options: { create: "write" } });
  const { pageId } = await workflow("Leer", chain(manual(), node("action.journal.append", { journal: jid, content: "## Abend\nAlles gut" })));
  assert.equal((await runIt(pageId)).status, "succeeded");
  const day = (await dayOf(jid, zoned()))!;
  assert.match(await html(day.id), /^<h2[^>]*>Abend<\/h2><p>Alles gut<\/p>$/);
});

test("refused: a person who may only read the journal, a journal behind a PIN", async () => {
  const jid = await newJournal("Team", TEMPLATE);
  // Emil may only read the journal (changed after activating).
  const a = await workflow("Lesen", chain(manual(), node("action.journal.append", { journal: jid, content: "Nein" })), editor);
  await run("INSERT INTO grants(resource_id,resource_kind,workspace_id,user_id,role) VALUES(?,?,?,?,?)", jid, "page", wid, editor.id, "viewer");
  assert.equal(await pageRole(editor, (await one<Page>("SELECT * FROM pages WHERE id=?", jid))!), "viewer");
  const r = await runIt(a.pageId, {}, editor);
  assert.equal(r.status, "failed");
  assert.match(r.error || "", /Emil darf das Journal „Team“ nicht bearbeiten/);
  assert.equal(await dayOf(jid, zoned()), undefined);
  // …and the check says so before activating.
  const check = await workflow("Lesen 2", chain(manual(), node("action.journal.append", { journal: jid, content: "Nein" })), editor, false);
  assert.ok(check.issues.some((i) => i.code === "page_not_writable"), JSON.stringify(check.issues));
  await run("DELETE FROM grants WHERE resource_id=?", jid);
  // A PIN set after activating: refused, nothing written or made.
  const b = await workflow("PIN", chain(manual(), node("action.journal.append", { journal: jid, content: "Geheim" })));
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET lock_hash=excluded.lock_hash", jid, "salt:hash");
  const p = await runIt(b.pageId);
  assert.equal(p.status, "failed");
  assert.match(p.error || "", /PIN/);
  assert.equal(await dayOf(jid, zoned()), undefined);
  // …and is refused by the check.
  const c = await workflow("PIN 2", chain(manual(), node("action.journal.append", { journal: jid, content: "x" })), owner, false);
  assert.ok(c.issues.some((i) => i.code === "unknown_journal"));
});

test("Markdown with placeholders: page values become page links, addresses take values only after a fixed scheme", async () => {
  const { markdownBlocks } = await import("../lib/workflows/nodes/journal");
  const scope = {
    values: { v: { page: { type: "page", id: "11111111-2222-4333-8444-555555555555", title: "Plan" }, url: "javascript:alert(1)", path: "a b/c", lines: "eins\nzwei" } },
    timeZone: "UTC",
    locale: "de" as const,
  };
  const json = JSON.stringify(markdownBlocks("Siehe {{v.page}} · [hier]({{v.url}}) · [Suche](https://example.org/q={{v.path}})\n\n{{v.lines}}", scope));
  assert.match(json, /"text":"Plan","marks":\[\{"type":"link","attrs":\{"href":"\/#page=11111111-2222-4333-8444-555555555555"/);
  assert.doesNotMatch(json, /javascript/, "an address from a value alone is no link");
  assert.match(json, /"text":"hier"\}/);
  assert.match(json, /https:\/\/example\.org\/q=a%20b%2Fc/);
  assert.match(json, /"text":"eins"\},\{"type":"hardBreak"\},\{"type":"text","text":"zwei"/);
  assert.deepEqual(markdownBlocks("", scope), []);
});
