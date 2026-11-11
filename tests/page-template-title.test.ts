// #213: a page created from a template takes the title it is given – by
// hand, through the API or a workflow's "Create page" node with
// placeholders – and the template's name only when no title is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-template-title-"));
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { catalogFor } = await import("../lib/template-catalogs");
const { contentLocale } = await import("../lib/content-locale");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(owner.id, "Template titles");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const titleOf = async (pageId: string) => (await one<{ title: string }>("SELECT title FROM pages WHERE id=?", pageId))!.title;
const htmlOf = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

const source = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Meeting source", kind: "document" })).id as string;
await run("UPDATE documents SET html=? WHERE page_id=?", "<p>Agenda from the template</p>", source);
const template = (await act({ action: "template.save", pageId: source, name: "Weekly meeting", private: false })) as { id: string };
assert.ok(template.id);

test("page.create with a template keeps the given title and falls back to the template's name", async () => {
  const named = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Meeting 2026-11-11", templateId: template.id })).id;
  assert.equal(await titleOf(named), "Meeting 2026-11-11");
  assert.match(await htmlOf(named), /Agenda from the template/);
  // No title, or only blanks: the template's name.
  for (const title of [undefined, "", "   "]) {
    const created = (await act({ action: "page.create", workspaceId: wid, spaceId: space, templateId: template.id, ...(title === undefined ? {} : { title }) })).id;
    assert.equal(await titleOf(created), "Weekly meeting", JSON.stringify(title));
  }
  // A built-in template the same way.
  const starter = Object.entries(catalogFor(contentLocale())).find(([, t]) => t.kind === "document")!;
  const own = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Retro Q4", kind: "document", starterTemplate: starter[0] })).id;
  assert.equal(await titleOf(own), "Retro Q4");
  const fallback = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", starterTemplate: starter[0] })).id;
  assert.equal(await titleOf(fallback), starter[1].name);
  // Without a template a title is still required.
  await assert.rejects(act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document" }));
  await assert.rejects(act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "" }));
});

let seq = 0;
const node = (type: string, config: Record<string, unknown>) => ({ id: `n_t${String(++seq).padStart(5, "0")}`, type, typeVersion: 1, label: `Step ${seq}`, note: "", position: { x: seq * 10, y: 0 }, disabled: false, config });
async function runCreate(title: string, inputs: Record<string, string>) {
  const parent = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: `Reports ${seq}`, kind: "document" })).id as string;
  const trigger = node("trigger.manual", { inputs: [{ name: "Name", type: "text" }] });
  const create = node("action.page.create", { parent, title: title.replaceAll("TRIGGER", trigger.id), template: template.id });
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: `Flow ${seq}` })).id as string;
  await act({ action: "workflow.draft", pageId, graph: { nodes: [trigger, create], edges: [{ id: "e_1", from: { node: trigger.id, port: "out" }, to: { node: create.id, port: "in" } }] } });
  const activated = await act({ action: "workflow.activate", pageId });
  assert.equal(activated.ok, true, JSON.stringify(activated.issues));
  await act({ action: "workflow.run", pageId, inputs });
  await drainWorkflows();
  const child = await one<{ id: string; title: string }>("SELECT id,title FROM pages WHERE parent_id=? AND deleted_at IS NULL", parent);
  assert.ok(child, "the workflow created the page");
  return child;
}

test("the workflow node Create page uses its configured title with placeholders, not the template's", async () => {
  const page = await runCreate("Meeting {{TRIGGER.inputs.Name}}", { Name: "Kick-off" });
  assert.equal(page.title, "Meeting Kick-off");
  assert.match(await htmlOf(page.id), /Agenda from the template/);
});

test("the workflow node Create page falls back to the template's name when the title comes out empty", async () => {
  const page = await runCreate("{{TRIGGER.inputs.Name}}", { Name: "" });
  assert.equal(page.title, "Weekly meeting");
});
