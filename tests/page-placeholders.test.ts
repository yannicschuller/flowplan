// #653: placeholders in saved page (document) templates – filled once, when
// a page is created from the template, from its title and properties; the
// same names and formatting as record templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { placeholderTarget, placeholderDate } from "../lib/record-placeholders";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-placeholders-"));
const { id, one, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { Temporal } = await import("../lib/date-values");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ada Lovelace", "ada@test.invalid");
const owner: Identity = { id: uid, name: "Ada Lovelace", email: "ada@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(owner.id, "Page placeholders");
const space = (await bootstrap(owner, wid)).spaces[0];
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const titleOf = async (pageId: string) => (await one<{ title: string }>("SELECT title FROM pages WHERE id=?", pageId))!.title;
const htmlOf = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;
const valuesOf = async (pageId: string) =>
  (await act({ action: "page.properties", pageId })).values as Record<string, unknown>;

const property = async (name: string, type: string) =>
  ((await act({ action: "property.save", workspaceId: wid, name, type })) as { id: string }).id;
const customer = await property("Customer", "text");
const budget = await property("Budget", "number");
const due = await property("Due", "date");
const lead = await property("Lead", "person");
const notes = await property("Notes", "text");
await property("Contact", "text");

const source = (await act({ action: "page.create", workspaceId: wid, spaceId: space.id, title: "Kickoff {{Customer}}", kind: "document" })).id as string;
await run(
  "UPDATE documents SET html=? WHERE page_id=?",
  "<h1>{{Title}}</h1><p>For {{ customer }} by {{Creator}} in {{Bereich}}, {{Unknown}} and {{Database}} stay.</p>" +
    "<table><tbody><tr><td>{{Budget}}</td><td>{{Due}}</td></tr></tbody></table>" +
    '<div data-callout="info"><p>Lead: {{Lead}}, contact: [{{Contact}}], made {{Heute}}</p></div>',
  source,
);
await act({
  action: "page.properties",
  pageId: source,
  values: { Customer: "ACME <b>&</b> Co", Budget: 1500, Due: "2026-12-01", Lead: owner.id, Notes: "Call {{Customer}} on {{Due}}" },
});
const template = (await act({ action: "template.save", pageId: source, name: "Kickoff {{Customer}}", private: false })) as { id: string };

test("a page from a saved template: title, headings, text, tables, callouts and text properties are filled", async () => {
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space.id, templateId: template.id, timeZone: "Europe/Berlin" })).id as string;
  assert.equal(await titleOf(page), "Kickoff ACME <b>&</b> Co");
  const html = await htmlOf(page);
  const today = placeholderDate(Temporal.Now.plainDateISO("Europe/Berlin").toString(), { tag: "de-DE", zone: "Europe/Berlin" });
  // Values are text, never markup.
  assert.match(html, /<h1[^>]*>Kickoff ACME &lt;b&gt;&amp;&lt;\/b&gt; Co<\/h1>/);
  assert.ok(html.includes(`For ACME &lt;b&gt;&amp;&lt;/b&gt; Co by Ada Lovelace in ${space.name}, {{Unknown}} and {{Database}} stay.`), html);
  assert.ok(html.includes("1.500") || html.includes("1500"), html);
  assert.ok(html.includes("1. Dez. 2026"), html);
  // Empty properties become empty text.
  assert.ok(html.includes(`Lead: Ada Lovelace, contact: [], made ${today}`), html);
  assert.ok(!html.includes("<b>"));
  const values = await valuesOf(page);
  assert.equal(values[notes], "Call ACME <b>&</b> Co on 1. Dez. 2026");
  assert.equal(values[customer], "ACME <b>&</b> Co");
  assert.equal(values[budget], 1500);
  assert.equal(values[due], "2026-12-01");
  assert.equal(values[lead], owner.id);
  // The template keeps its placeholders.
  assert.equal(await titleOf(source), "Kickoff {{Customer}}");
});

test("the title given in the New page dialog is {{Title}}, and is filled itself", async () => {
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space.id, templateId: template.id, title: "{{Customer}} – {{Heute}}" })).id as string;
  const title = await titleOf(page);
  assert.match(title, /^ACME <b>&<\/b> Co – \d/);
  assert.ok((await htmlOf(page)).includes(`<h1>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</h1>`));
});

test("a property named like a built-in wins", async () => {
  const other = await createWorkspace(owner.id, "Own title");
  const otherSpace = (await bootstrap(owner, other)).spaces[0].id;
  await act({ action: "property.save", workspaceId: other, name: "Title", type: "text" });
  const p = (await act({ action: "page.create", workspaceId: other, spaceId: otherSpace, title: "Source", kind: "document" })).id as string;
  await run("UPDATE documents SET html=? WHERE page_id=?", "<p>{{Title}} / {{Titel}} / {{Space}}</p>", p);
  await act({ action: "page.properties", pageId: p, values: { Title: "From the property" } });
  const t = (await act({ action: "template.save", pageId: p, name: "Own", private: false })) as { id: string };
  const page = (await act({ action: "page.create", workspaceId: other, spaceId: otherSpace, templateId: t.id, title: "Given" })).id as string;
  const space2 = (await bootstrap(owner, other)).spaces[0].name;
  assert.equal(await htmlOf(page), `<p>From the property / Given / ${space2}</p>`);
});

test("a draft of the template (to edit it) keeps the placeholders", async () => {
  const draft = (await act({ action: "template.draft", workspaceId: wid, templateId: template.id, version: 1, spaceId: space.id })).id as string;
  assert.ok((await htmlOf(draft)).includes("For {{ customer }} by {{Creator}}"));
  assert.equal(await titleOf(draft), "Kickoff {{Customer}}");
});

test("{{Space}} and {{Bereich}} are built in, for record templates too", () => {
  assert.deepEqual(placeholderTarget("Space", []), { builtin: "space" });
  assert.deepEqual(placeholderTarget("bereich", []), { builtin: "space" });
  assert.deepEqual(placeholderTarget("Espace", []), { builtin: "space" });
  assert.deepEqual(placeholderTarget("Bereich", [{ id: "b", name: "Bereich", type: "text" }]), { field: { id: "b", name: "Bereich", type: "text" } });
});
