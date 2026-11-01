import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
import {
  mapHtmlPlaceholders,
  mapPlaceholders,
  placeholderDate,
  placeholderTarget,
  placeholderValue,
  type PlaceholderFormat,
} from "../lib/record-placeholders";
import { emptyDocument } from "../lib/record-template-apply";
import { undoFor } from "../lib/undo";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-placeholders-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { replaceRowDocument } = await import("../lib/row-documents");

/* ---------- Parsing, escaping, formatting ---------- */

const props: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "company", name: "Company", type: "text" },
  { id: "date", name: "Date", type: "date" },
  { id: "tags", name: "Tags", type: "multiselect", options: ["a", "b"] },
  { id: "ok", name: "Approved", type: "checkbox" },
  { id: "price", name: "Price", type: "number", format: "eur" },
  { id: "owner", name: "Owner", type: "person" },
];
const fmt = (tag = "en-GB"): PlaceholderFormat => ({ tag, zone: "Europe/Berlin", person: (uid) => (uid === "u1" ? "Ada" : "") });

test("keys: stored id, name without regard to case, built-in, id", () => {
  assert.deepEqual(placeholderTarget("field:company", props), { field: props[1] });
  assert.deepEqual(placeholderTarget("field:gone", props), { gone: true });
  assert.deepEqual(placeholderTarget("  COMPANY ", props), { field: props[1] });
  // A property named like a built-in wins.
  assert.deepEqual(placeholderTarget("date", props), { field: props[2] });
  assert.deepEqual(placeholderTarget("Heute", props), { builtin: "today" });
  assert.deepEqual(placeholderTarget("Title", props), { builtin: "title" });
  assert.deepEqual(placeholderTarget("tags", props), { field: props[3] });
  assert.equal(placeholderTarget("Unknown thing", props), null);
});

test("text: only known placeholders change", () => {
  const resolve = (key: string) => (key.toLowerCase() === "company" ? "ACME" : undefined);
  assert.equal(mapPlaceholders("Kickoff {{Company}} – {{nope}} {{ company }}", resolve), "Kickoff ACME – {{nope}} ACME");
});

test("HTML: text nodes only, values escaped, never markup", () => {
  const resolve = (key: string) => (key === "Company" ? `<img src=x onerror=alert(1)> & "Co"` : key === "A&B" ? "ok" : undefined);
  const html = `<h2>Hi {{Company}}</h2><a href="https://x.test/{{Company}}" title="{{Company}}">{{Company}}</a><p>{{A&amp;B}}</p><table><tbody><tr><td><p>{{Company}}</p></td></tr></tbody></table>`;
  const out = mapHtmlPlaceholders(html, resolve);
  assert.equal(
    out,
    `<h2>Hi &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;</h2><a href="https://x.test/{{Company}}" title="{{Company}}">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;</a><p>ok</p><table><tbody><tr><td><p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;</p></td></tr></tbody></table>`,
  );
  assert.ok(!out.includes("<img"));
  // A placeholder split by a mark stays as written.
  assert.equal(mapHtmlPlaceholders("<p>{{<em>Company</em>}}</p>", resolve), "<p>{{<em>Company</em>}}</p>");
});

test("values per property type", () => {
  assert.equal(placeholderValue(props[2], "2026-03-05", fmt()), "5 Mar 2026");
  assert.equal(placeholderValue(props[2], "2026-03-05", fmt("de-DE")), "5. März 2026");
  assert.equal(placeholderValue({ ...props[2], format: "iso" }, "2026-03-05T08:30:00Z", fmt()), "2026-03-05, 09:30");
  assert.equal(placeholderValue(props[3], ["a", "b"], fmt()), "a, b");
  assert.equal(placeholderValue(props[4], true, fmt()), "✓");
  assert.equal(placeholderValue(props[4], undefined, fmt()), "✗");
  assert.equal(placeholderValue(props[5], 1234.5, fmt("de-DE")), "1.234,50 €");
  assert.equal(placeholderValue(props[6], ["u1"], fmt()), "Ada");
  assert.equal(placeholderValue(props[1], "", fmt()), "");
  assert.equal(placeholderValue(props[1], null, fmt()), "");
  assert.equal(placeholderDate("2026-03-01 08:00:00", fmt(), "eu"), "01.03.2026, 09:00");
});

test("empty documents", () => {
  assert.ok(emptyDocument(""));
  assert.ok(emptyDocument("<p></p><p> &nbsp;</p>"));
  assert.ok(!emptyDocument("<p>x</p>"));
  assert.ok(!emptyDocument('<p><img src="/api/files/x"></p>'));
});

/* ---------- Templates in a database ---------- */

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("Olivia"),
  viewer = user("Vic");
const wid = createWorkspace(owner.id, "Placeholders"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "company", name: "Company", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Draft", "Approved", "Done"] },
  { id: "tags", name: "Tags", type: "multiselect", options: ["red", "blue"] },
  { id: "note", name: "Note", type: "text" },
];
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Clients" }).id as string;
const schema = (next: Field[]) => act({ action: "database.update", pageId, version: database(pageId).version, fields: next, views: database(pageId).views });
schema(fields);
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const html = (rid: string) => one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rid)?.html || "";
const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;
const update = (rid: string, patch: Record<string, unknown>) => act({ action: "row.update", pageId, rowId: rid, version: version(rid), cells: patch });

// A template built in a record: placeholders in the title, a heading and a table.
const source = act({ action: "row.create", pageId, cells: { title: "Kickoff {{company}}", status: "Draft", note: "For {{Me}}" } }).id;
replaceRowDocument(
  source,
  "<h2>Welcome {{Company}}</h2><p>Tags: {{Tags}} · {{Database}} · {{Unknown}}</p><table><tbody><tr><td><p>{{Status}}</p></td></tr></tbody></table>",
  owner.id,
);
const kickoff = act({ action: "row.template.save", pageId, rowId: source, name: "Kickoff" }).id as string;

test("saving stores properties by id", () => {
  const t = one<{ html: string; cells: string }>("SELECT html,cells FROM row_templates WHERE id=?", kickoff)!;
  assert.match(t.html, /Welcome \{\{field:company\}\}/);
  assert.match(t.html, /\{\{Database\}\} · \{\{Unknown\}\}/);
  assert.equal(JSON.parse(t.cells).title, "Kickoff {{field:company}}");
});

test("a new record from a template gets its values, also after a rename", () => {
  schema(fields.map((f) => (f.id === "company" ? { ...f, name: "Firma" } : f)));
  const rid = act({ action: "row.create", pageId, templateId: kickoff, cells: { company: "ACME <b>", tags: ["red", "blue"] } }).id;
  assert.equal(cells(rid).title, "Kickoff ACME <b>");
  assert.equal(cells(rid).note, "For Olivia");
  const doc = html(rid);
  assert.match(doc, /<h2>Welcome ACME &lt;b&gt;<\/h2>/);
  assert.match(doc, /Tags: red, blue · Clients · \{\{Unknown\}\}/);
  // Inside a table too; the status came from the template.
  assert.match(doc, /<td[^>]*><p>Draft<\/p><\/td>/);
  // Opened for editing, the placeholders show the current names.
  const draft = act({ action: "row.create", pageId, templateId: kickoff, rawTemplate: true }).id;
  assert.equal(cells(draft).title, "Kickoff {{Firma}}");
  assert.match(html(draft), /Welcome \{\{Firma\}\}/);
  // Saved again over the template, it keeps the id.
  assert.equal(act({ action: "row.template.save", pageId, rowId: draft, name: "Kickoff", replaceId: kickoff }).id, kickoff);
  assert.equal(all("SELECT id FROM row_templates WHERE page_id=?", pageId).length, 1);
  schema(fields);
});

test("templates saved with names survive a rename", () => {
  const legacy = id();
  run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,created_by) VALUES(?,?,?,?,?,?)",
    legacy,
    pageId,
    "Old",
    JSON.stringify({ title: "{{Company}}" }),
    "<p>{{Company}}</p>",
    owner.id,
  );
  schema(fields.map((f) => (f.id === "company" ? { ...f, name: "Organisation" } : f)));
  const rid = act({ action: "row.create", pageId, templateId: legacy, cells: { company: "Initech" } }).id;
  assert.equal(cells(rid).title, "Initech");
  assert.match(html(rid), /<p>Initech<\/p>/);
  run("DELETE FROM row_templates WHERE id=?", legacy);
  schema(fields);
});

test("by hand: empty documents only, or appended; filled properties stay", () => {
  const rid = act({ action: "row.create", pageId, cells: { title: "Globex", company: "Globex", status: "Approved" } }).id;
  replaceRowDocument(rid, "<p>My notes</p>", owner.id);
  assert.throws(() => act({ action: "row.template.apply", pageId, rowId: rid, templateId: kickoff }), /schon Inhalt/);
  assert.equal(html(rid), "<p>My notes</p>");
  // Viewers may not.
  assert.throws(() => act({ action: "row.template.apply", pageId, rowId: rid, templateId: kickoff, mode: "append" }, viewer));
  const snapshotId = crypto.randomUUID();
  const result = act({ action: "row.template.apply", pageId, rowId: rid, templateId: kickoff, mode: "append", snapshotId });
  assert.equal(result.document, "appended");
  assert.match(html(rid), /^<p>My notes<\/p><h2>Welcome Globex<\/h2>/);
  // Its status stays; the empty note is filled.
  assert.equal(cells(rid).status, "Approved");
  assert.equal(cells(rid).title, "Globex");
  assert.equal(cells(rid).note, "For Olivia");
  assert.equal(one<{ html: string }>("SELECT html FROM row_snapshots WHERE id=?", snapshotId)?.html, "<p>My notes</p>");
  // An empty record gets the template's text.
  const fresh = act({ action: "row.create", pageId, cells: { title: "Empty", company: "Hooli" } }).id;
  assert.equal(act({ action: "row.template.apply", pageId, rowId: fresh, templateId: kickoff }).document, "applied");
  assert.match(html(fresh), /^<h2>Welcome Hooli<\/h2>/);
});

test("undo restores the text and empties what the template filled", () => {
  const plan = undoFor(
    { action: "row.template.apply", pageId, rowId: "r1", templateId: kickoff, snapshotId: "s1" },
    {
      boot: boot as never,
      data: { page: { id: pageId }, database: { fields }, rows: [{ id: "r1", version: 1, cells: { title: "X", status: "" } }] } as never,
    },
  );
  assert.ok(plan);
  const commands = plan!.commands({
    boot: boot as never,
    data: { page: { id: pageId }, rows: [{ id: "r1", version: 2, cells: { title: "X", status: "Draft", tags: ["red"] } }] } as never,
  });
  assert.deepEqual(commands, [
    { action: "row.snapshot.restore", pageId, rowId: "r1", snapshotId: "s1" },
    { action: "row.update", pageId, rowId: "r1", version: 2, cells: { status: "", tags: [] } },
  ]);
});

test("automation: when Status changes to Approved, apply once, only if the condition holds", () => {
  assert.throws(
    () => act({ action: "database.settings", pageId, settings: { automations: [{ id: "x", trigger: { type: "created" }, actions: [{ type: "template", template: "nope" }] }] } }),
    /vorlage nicht gefunden/,
  );
  act({
    action: "database.settings",
    pageId,
    settings: {
      automations: [
        {
          id: "kick",
          name: "Kickoff",
          trigger: { type: "changed", field: "status", to: "Approved" },
          conditions: [{ field: "company", op: "notempty", value: "" }],
          actions: [{ type: "template", template: kickoff }],
        },
      ],
    },
  });
  const rid = act({ action: "row.create", pageId, cells: { title: "Umbrella", company: "Umbrella", status: "Draft" } }).id;
  assert.equal(html(rid), "");
  update(rid, { status: "Approved" });
  const applied = html(rid);
  assert.match(applied, /<h2>Welcome Umbrella<\/h2>/);
  assert.match(applied, /<td[^>]*><p>Approved<\/p><\/td>/);
  assert.equal(cells(rid).note, "For Olivia");
  // Back and forth: not again (also not appended).
  update(rid, { status: "Draft" });
  update(rid, { status: "Approved" });
  assert.equal(html(rid), applied);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM automation_runs WHERE automation_id='kick' AND row_id=?", rid)?.n, 1);
  assert.ok(one("SELECT 1 FROM audit WHERE action='row.template.applied' AND resource_id=?", rid));
  // Without a company the rule does not fire.
  const other = act({ action: "row.create", pageId, cells: { title: "Nameless", status: "Draft" } }).id;
  update(other, { status: "Approved" });
  assert.equal(html(other), "");
  // A record with text keeps it in "empty only" mode.
  const busy = act({ action: "row.create", pageId, cells: { title: "Busy", company: "Busy", status: "Draft" } }).id;
  replaceRowDocument(busy, "<p>Mine</p>", owner.id);
  update(busy, { status: "Approved" });
  assert.equal(html(busy), "<p>Mine</p>");
  // Append mode puts it below.
  act({
    action: "database.settings",
    pageId,
    settings: { automations: [{ id: "kick2", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "template", template: kickoff, mode: "append" }] }] },
  });
  update(busy, { status: "Done" });
  assert.match(html(busy), /^<p>Mine<\/p><h2>Welcome Busy<\/h2>/);
});
