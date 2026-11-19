// Every package for the marketplace leaves the people of this instance
// here (#345, lib/marketplace-public-template.ts, docs: Marketplace):
// documents, databases, workflows and whiteboard templates alike. Mentions
// become the plain text "@Person" (a task assigned that way loses its
// assignee, its due date stays), comment anchors go, ids and addresses of
// members go – also inside texts; a workflow's recipients keep their place
// under a new id without a name. Links to pages stay; the ones to the
// template's own page still work after the install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-marketplace-people-"));
const setup = await import("./helpers/workflow-setup");
const { owner, editor, wid, space, act, node, chain, workflow, user } = setup;
const { one, all, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { readZip } = await import("../lib/archive");
const pkgs = await import("../lib/marketplace-package");
const { withoutMentions, peopleCleaner, publicTemplateContent, PERSON_PLACEHOLDER } = await import("../lib/marketplace-public-template");
const { saveBoardTemplate } = await import("../lib/whiteboard-user-templates");

// A member with a name and an address that occur nowhere else.
const erika = { id: randomUUID(), name: "Erika Mustermann", email: "erika.mustermann@example.org" };
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", erika.id, erika.id, erika.name, erika.email);
await run("INSERT INTO members VALUES(?,?,?)", wid, erika.id, "editor");

const other = await user("market-taker");
const target = await createWorkspace(other.id, "Ziel");
const targetSpace = (await bootstrap(other, target)).spaces[0].id;
const meta = (title: string) => ({ titles: { en: title }, summary: { de: `${title}.`, en: `${title}.` }, category: "projects", tags: [], language: "de" });

// Everything in a package as text, nested ZIPs unpacked.
async function packageText(bytes: Buffer) {
  const outer = await readZip(bytes, { foreign: true });
  const parts: string[] = [];
  for (const [name, data] of outer) {
    if (name.endsWith(".zip")) for (const inner of (await readZip(data, { foreign: true })).values()) parts.push(inner.toString("utf8"));
    else parts.push(data.toString("utf8"));
  }
  return { outer, text: parts.join("\n") };
}
function assertNoPeople(text: string) {
  for (const who of [erika, owner, editor]) {
    assert.ok(!text.toLowerCase().includes(who.id.toLowerCase()), `no id of ${who.name}`);
    assert.ok(!text.toLowerCase().includes(who.email!.toLowerCase()), `no address of ${who.name}`);
  }
  assert.ok(!text.includes("Erika") && !text.includes("Mustermann"), "no name");
  assert.ok(!text.includes("data-mention"), "no mention");
  assert.ok(!text.includes("data-comment-thread"), "no comment anchor");
}

test("the cleaner: mentions become @Person, ids and addresses go, also inside texts", () => {
  const uid = randomUUID();
  const people = { ids: new Set([uid]), emails: new Set(["anna@example.org"]) };
  assert.deepEqual(withoutMentions(`<p>Frag <span data-mention="${uid}" class="mention">@Anna</span>.</p>`), { html: `<p>Frag ${PERSON_PLACEHOLDER}.</p>`, count: 1 });
  const cleaner = peopleCleaner(people);
  assert.equal(cleaner.clean(uid), "");
  assert.equal(cleaner.clean("ANNA@example.org"), "");
  assert.equal(cleaner.clean(`Frag [@Anna Berg]{data-mention=${uid}} oder schreib an Anna@Example.org.`), "Frag @Person oder schreib an .");
  assert.equal(cleaner.clean('<a href="mailto:anna@example.org">Mail</a>'), '<a href="">Mail</a>');
  assert.deepEqual(cleaner.walk({ to: [uid, "@runner", "other@example.org"] }), { to: ["@runner", "other@example.org"] });
  assert.equal(cleaner.cleared(), 6);
  // A document template's content.
  const { content, cleared } = publicTemplateContent(
    {
      html: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Bericht <span data-mention="${uid}" class="mention">@Anna</span></p></li></ul><p data-comment-thread="t1">Schreib an anna@example.org</p>`,
      meta: { properties: [{ name: "Wer", type: "person", value: uid }, { name: "Stand", type: "text", value: "offen" }] as never[] },
    },
    people,
  );
  assert.equal(content.html, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Bericht ${PERSON_PLACEHOLDER}</p></li></ul><p>Schreib an </p>`);
  assert.deepEqual(content.meta!.properties!.map((p) => (p as { name: string }).name), ["Stand"]);
  assert.equal(cleared, 4);
});

test("a document template: no member id, name or address in the package; the task keeps its due date; links stay and work after the install", async () => {
  const list = await setup.makeDatabase("Liste");
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Wochenplan" })).id as string;
  const html =
    `<h1>Woche</h1>` +
    `<p>Frag <span data-mention="${erika.id}" class="mention">@${erika.name}</span>, sie weiß Bescheid.</p>` +
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Bericht schreiben <span data-mention="${erika.id}" class="mention">@${erika.name}</span></p></li></ul>` +
    `<p>Fragen an <a href="mailto:${erika.email}">${erika.email}</a> oder ${erika.email.toUpperCase()}.</p>` +
    `<p><span class="inline-comment-mark" data-comment-thread="${randomUUID()}">markiert</span> und <a href="/#page=${list}">Liste</a></p>`;
  await run("UPDATE documents SET html=? WHERE page_id=?", html, pageId);
  await act({ action: "comment.create", pageId, body: `Danke ${erika.email} – geheimer Kommentar` });
  const templateId = (await act({ action: "template.save", pageId, name: "Wochenplan" })).id as string;

  const draft = await pkgs.packageDraft(owner, { kind: "document", workspaceId: wid, id: templateId });
  const note = draft.notes.find((n) => n.code === "people-cleared");
  assert.ok(note && note.count! >= 5, "the dialog says details about people stay here");
  const built = await pkgs.buildPackage(owner, { kind: "document", workspaceId: wid, id: templateId }, meta("Weekly plan"), []);
  const { outer, text } = await packageText(built.bytes);
  assertNoPeople(text);
  assert.ok(!text.includes("geheimer Kommentar"), "comments never travel");
  const inner = await readZip(outer.get("payload/template.zip")!, { foreign: true });
  const doc = JSON.parse(JSON.parse(inner.get("template.json")!.toString("utf8")).payload).html as string;
  assert.ok(doc.includes(`Frag ${PERSON_PLACEHOLDER}, sie weiß Bescheid.`));
  assert.match(doc, /<li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Bericht schreiben @Person<\/p><\/li>/, "the task without its assignee, with its due date");
  assert.ok(doc.includes(`href="/#page=${list}"`), "a link to a page stays as it was");

  // Installed elsewhere: the same text, the task open with its date, no one assigned.
  const parsed = await pkgs.readPackage(built.bytes);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  const copy = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, title: "Vom Marketplace", templateId: result.templateId }, other)).id as string;
  const installed = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", copy))!.html;
  assert.ok(installed.includes(PERSON_PLACEHOLDER) && installed.includes('data-due="2026-12-01"'));
  assert.ok(!installed.includes("data-mention") && !installed.includes(erika.email));
});

test("a database template: the link to its own page is rewritten on install, people stay here", async () => {
  const db = await setup.makeDatabase("Projekte", [
    { id: "title", name: "Name", type: "text" },
    { id: "who", name: "Zuständig", type: "person" },
  ] as never);
  const rowId = (await act({ action: "row.create", pageId: db, cells: { title: "Start", who: erika.id } })).id as string;
  const { replaceRowDocument } = await import("../lib/row-documents");
  await replaceRowDocument(rowId, `<p>Siehe <a href="/#page=${db}">Projekte</a>, frag <span data-mention="${erika.id}" class="mention">@${erika.name}</span> (${erika.email}).</p>`, owner.id);
  const templateId = (await act({ action: "template.save", pageId: db, name: "Projekte" })).id as string;
  const built = await pkgs.buildPackage(owner, { kind: "database", workspaceId: wid, id: templateId }, meta("Projects"), []);
  const { text } = await packageText(built.bytes);
  assertNoPeople(text);
  const result = await pkgs.importPackage(other, await pkgs.readPackage(built.bytes), { workspaceId: target, spaceId: targetSpace });
  const copy = (await act({ action: "page.create", workspaceId: target, spaceId: targetSpace, kind: "database", title: "Kopie", templateId: result.templateId }, other)).id as string;
  const rows = await all<{ content: string; cells: string }>("SELECT content,cells FROM rows WHERE page_id=?", copy);
  const start = rows.find((r) => JSON.parse(r.cells).title === "Start")!;
  assert.ok(start.content.includes(`href="/#page=${copy}"`), "the link to the database's own page leads to the copy");
  assert.ok(start.content.includes(PERSON_PLACEHOLDER));
  assert.equal(JSON.parse(start.cells).who, undefined);
});

test("a workflow: recipients keep their place without id or name, addresses and mentions of members go", async () => {
  const graph = chain(
    node("trigger.manual", {}, "Start"),
    node("notify.person", { to: [erika.id, "@runner"], title: "Hallo", message: `Frag [@${erika.name}]{data-mention=${erika.id}} oder schreib an ${erika.email}.` }, "Melden"),
    node("notify.email", { to: [erika.email, "extern@example.org"], subject: "Bericht", message: "Text" }, "Mail"),
  );
  const { pageId } = await workflow("Bericht", graph, owner, false);
  const draft = await pkgs.packageDraft(owner, { kind: "workflow", workspaceId: wid, id: pageId });
  assert.ok(draft.notes.some((n) => n.code === "people-cleared"));
  const built = await pkgs.buildPackage(owner, { kind: "workflow", workspaceId: wid, id: pageId }, meta("Report"), []);
  const { outer, text } = await packageText(built.bytes);
  assertNoPeople(text);
  const file = JSON.parse(outer.get("payload/workflow.json")!.toString("utf8"));
  const people = Object.entries(file.references as Record<string, { kind: string; title: string }>).filter(([, r]) => r.kind === "person");
  assert.equal(people.length, 1, "the recipient is still a person reference");
  const [placeholder, ref] = people[0];
  assert.equal(ref.title, "");
  const notify = file.graph.nodes.find((n: { type: string }) => n.type === "notify.person");
  assert.deepEqual(notify.config.to, [placeholder, "@runner"]);
  assert.equal(notify.config.message, "Frag @Person oder schreib an .");
  assert.deepEqual(file.graph.nodes.find((n: { type: string }) => n.type === "notify.email").config.to, ["extern@example.org"], "other addresses stay");
  // Installed: the person is open (or chosen), never someone of this instance.
  const parsed = await pkgs.readPackage(built.bytes);
  const result = await pkgs.importPackage(other, parsed, { workspaceId: target, spaceId: targetSpace });
  assert.ok((result.unresolved as number) >= 1);
});

test("a whiteboard template: no addresses or ids of members in its texts", async () => {
  const board = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "whiteboard", title: "Board" })).id;
  const saved = await saveBoardTemplate(owner, board, {
    name: "Retro",
    items: [
      { id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: `Moderation: ${erika.email}` },
      { id: "s2", type: "text", x: 240, y: 0, w: 200, h: 40, text: "Titel" },
    ],
  });
  const draft = await pkgs.packageDraft(owner, { kind: "whiteboard", workspaceId: wid, id: saved.id });
  assert.deepEqual(draft.notes, [{ code: "people-cleared", count: 1 }]);
  const built = await pkgs.buildPackage(owner, { kind: "whiteboard", workspaceId: wid, id: saved.id }, meta("Retro"), []);
  const { text } = await packageText(built.bytes);
  assertNoPeople(text);
  assert.ok(text.includes("Moderation: ") && text.includes("Titel"));
});
