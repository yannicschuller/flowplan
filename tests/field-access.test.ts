import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-field-access-"));
const { id, run, one } = await import("../lib/db");
const { command, pageData, publicRows, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { searchWorkspace } = await import("../lib/search-index");
const { sharedContent, mutateSharedContent } = await import("../lib/shared-content");
const { getForm, saveFormSubmission, formSettings } = await import("../lib/forms");
const { handleMcpMessage } = await import("../lib/mcp");
const { sourceText } = await import("../lib/ai/sources");
const { exportMarkdown } = await import("../lib/markdown-export");
const { hiddenFieldsFor, visibleFields, publicHiddenFieldIds } = await import("../lib/field-access");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 3600_000,
  );
  return (await identityFromToken(token))!;
}
const fails = async (fn: () => unknown, status: number, message?: RegExp) =>
  assert.rejects(async () => fn(), (e: { status?: number; message?: string }) => e.status === status && (!message || message.test(e.message || "")));

// Ana owns the workspace; Ben and Dora are editors, Cara reads. Dora is in
// the HR group.
const ana = await person("Ana"),
  ben = await person("Ben"),
  cara = await person("Cara"),
  dora = await person("Dora");
const wid = await createWorkspace(ana.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, cara.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, dora.id, "editor");
const hr = id();
await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", hr, wid, "HR");
await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", hr, dora.id);
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const pid = (
  (await command(ana, { action: "page.create", workspaceId: wid, spaceId: space, title: "Personal", kind: "database" })) as { id: string }
).id;
const page = async () => (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", pid))!;

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "salary", name: "Gehalt", type: "number", access: { read: { groups: [hr] }, write: { groups: [hr] } } },
  { id: "note", name: "Interne Notiz", type: "text", access: { read: "editors", write: "owners" } },
  { id: "role", name: "Rolle", type: "text" },
  { id: "double", name: "Doppelt", type: "formula", formula: 'prop("Gehalt") * 2' },
  { id: "length", name: "Länge", type: "formula", formula: 'length(prop("Rolle"))' },
];
const schema = async (who: Identity, next: Field[]) =>
  await command(who, {
    action: "database.update",
    pageId: pid,
    version: (await database(pid)).version,
    fields: next,
    views: (await database(pid)).views,
  });
await schema(ana, fields);
const rowId = (
  (await command(ana, {
    action: "row.create",
    pageId: pid,
    cells: { title: "Erika", salary: 987654, note: "vertraulich-xyz", role: "Entwicklerin" },
  })) as { id: string }
).id;
const version = async () => Number((await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version);
const update = async (who: Identity, cells: Record<string, unknown>) =>
  await command(who, { action: "row.update", pageId: pid, rowId, version: await version(), cells });
const view = async (who: Identity) => {
  const data = (await pageData(who, pid)) as unknown as {
    database: { fields: Field[] };
    rows: { id: string; cells: Record<string, unknown> }[];
    readOnlyFields: string[];
  };
  return {
    fields: data.database.fields.map((f) => f.id),
    cells: data.rows.find((r) => r.id === rowId)!.cells,
    readOnly: data.readOnlyFields,
  };
};

test("pageData leaves out hidden properties and their cells", async () => {
  const owner = await view(ana);
  assert.deepEqual(owner.fields, ["title", "salary", "note", "role", "double", "length"]);
  assert.equal(owner.cells.salary, 987654);
  assert.deepEqual(owner.readOnly, []);

  const editor = await view(ben);
  assert.deepEqual(editor.fields, ["title", "note", "role", "length"]);
  assert.equal(editor.cells.salary, undefined);
  assert.equal(editor.cells.note, "vertraulich-xyz");
  // Visible, but only owners change the note.
  assert.deepEqual(editor.readOnly, ["note"]);

  const reader = await view(cara);
  assert.deepEqual(reader.fields, ["title", "role", "length"]);
  assert.equal(reader.cells.note, undefined);
  assert.equal(JSON.stringify(await pageData(cara, pid)).includes("987654"), false);
  assert.equal(JSON.stringify(await pageData(cara, pid)).includes("vertraulich-xyz"), false);
});

test("group rules: members of the group read and write", async () => {
  const hrView = await view(dora);
  assert.deepEqual(hrView.fields, ["title", "salary", "note", "role", "double", "length"]);
  assert.equal(hrView.cells.salary, 987654);
  await update(dora, { salary: 1000 });
  assert.equal((await view(ana)).cells.salary, 1000);
  // Removed from the group, Dora loses both.
  await run("DELETE FROM group_members WHERE group_id=? AND user_id=?", hr, dora.id);
  assert.equal((await view(dora)).cells.salary, undefined);
  await fails(async () => await update(dora, { salary: 2000 }), 403, /Gehalt/);
  await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", hr, dora.id);
  await update(ana, { salary: 987654 });
});

test("write paths refuse properties the person may not change", async () => {
  await fails(async () => await update(ben, { salary: 1 }), 403);
  await fails(async () => await update(ben, { note: "neu" }), 403, /Interne Notiz/);
  await update(ben, { role: "Leitung" });
  await fails(async () => await command(ben, { action: "row.create", pageId: pid, cells: { title: "X", salary: 5 } }), 403);
  // Bulk changes and imports.
  await fails(
    async () =>
      await command(ben, {
        action: "rows.bulk",
        pageId: pid,
        operation: "update",
        rows: [{ id: rowId, version: await version() }],
        cells: { note: "x" },
      }),
    403,
  );
  await fails(async () => await command(ben, { action: "rows.import", pageId: pid, rows: [{ title: "Import", salary: 3 }] }), 403);
  const before = Number((await one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", pid))!.n);
  await command(ben, { action: "rows.import", pageId: pid, rows: [{ title: "Import", role: "Gast" }] });
  assert.equal(Number((await one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", pid))!.n), before + 1);
  assert.equal((await view(ana)).cells.salary, 987654);
});

test("schema changes keep hidden properties; only owners set rules", async () => {
  // Ben saves the schema as he sees it: the hidden ones stay.
  const seen = ((await pageData(ben, pid)) as unknown as { database: { fields: Field[] } }).database.fields;
  await schema(ben, seen.map((f) => (f.id === "role" ? { ...f, name: "Funktion" } : f)));
  const stored = (await database(pid)).fields;
  assert.deepEqual(
    stored.map((f) => f.id),
    ["title", "salary", "note", "role", "double", "length"],
  );
  assert.equal(stored.find((f) => f.id === "role")!.name, "Funktion");
  assert.deepEqual(stored.find((f) => f.id === "salary")!.access, fields[1].access);
  // Rules are the owners' business, and so is deleting what Ben cannot write.
  await fails(async () => await schema(ben, seen.map((f) => (f.id === "role" ? { ...f, access: { read: "owners" } } : f))), 403);
  await fails(async () => await schema(ben, seen.filter((f) => f.id !== "note")), 403);
  await fails(async () => await schema(ana, [{ ...stored[0], access: { read: "owners" } }, ...stored.slice(1)]), 400);
  await fails(async () => await schema(ana, stored.map((f) => (f.id === "role" ? { ...f, access: { read: { groups: [id()] } } } : f))), 400);
  await schema(ana, stored.map((f) => (f.id === "role" ? { ...f, name: "Rolle" } : f)));
});

test("formulas reading a hidden property are hidden as well", async () => {
  const p = await page();
  assert.ok((await hiddenFieldsFor(ben, p)).has("double"));
  assert.ok(!(await hiddenFieldsFor(ben, p)).has("length"));
  assert.ok(!(await hiddenFieldsFor(dora, p)).has("double"));
  // A formula with a computed prop() argument could read anything.
  const stored = (await database(pid)).fields;
  const dynamic: Field = { id: "dyn", name: "Dynamisch", type: "formula", formula: 'prop("Ro" + "lle")' };
  assert.ok(!(await visibleFields(ben, p, [...stored, dynamic])).some((f) => f.id === "dyn"));
  assert.ok((await visibleFields(ana, p, [...stored, dynamic])).some((f) => f.id === "dyn"));
  // Public readers never see restricted properties or what derives from them.
  assert.deepEqual([...publicHiddenFieldIds(stored)].sort(), ["double", "note", "salary"]);
});

test("rollups over a hidden property in another database are hidden", async () => {
  const projects = (
    (await command(ana, { action: "page.create", workspaceId: wid, spaceId: space, title: "Projekte", kind: "database" })) as { id: string }
  ).id;
  const target = await database(projects);
  await command(ana, {
    action: "database.update",
    pageId: projects,
    version: target.version,
    views: target.views,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "people", name: "Personen", type: "relation", relationPage: pid },
      { id: "budget", name: "Budget", type: "rollup", relationField: "people", rollupField: "salary", aggregate: "sum" },
      { id: "roles", name: "Rollen", type: "rollup", relationField: "people", rollupField: "role", aggregate: "count" },
    ],
  });
  const projectPage = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", projects))!;
  const hidden = await hiddenFieldsFor(ben, projectPage);
  assert.ok(hidden.has("budget"));
  assert.ok(!hidden.has("roles"));
  assert.ok(!(await hiddenFieldsFor(dora, projectPage)).has("budget"));
  // The related rows Ben gets for computing rollups lack the cells too.
  const data = (await pageData(ben, projects)) as unknown as { related: Record<string, { cells: Record<string, unknown> }[]>; relatedSchemas: Record<string, Field[]> };
  assert.ok(data.related[pid].every((r) => r.cells.salary === undefined));
  assert.ok(!data.relatedSchemas[pid].some((f) => f.id === "salary"));
});

test("search indexes no restricted property", async () => {
  assert.equal((await searchWorkspace(ana, wid, "987654")).length, 0);
  assert.equal((await searchWorkspace(ana, wid, "vertraulich-xyz")).length, 0);
  assert.ok((await searchWorkspace(ben, wid, "Erika")).some((r) => r.rowId === rowId));
  assert.ok((await searchWorkspace(ben, wid, "Entwicklerin")).some((r) => r.rowId === rowId) || (await searchWorkspace(ben, wid, "Leitung")).some((r) => r.rowId === rowId));
});

test("exports leave hidden properties out", async () => {
  const text = (exported: { bytes: Uint8Array | Buffer }) => Buffer.from(exported.bytes).toString("utf8");
  const forBen = text(await exportMarkdown(ben, { pageId: pid, format: "markdown", includeSubpages: false }));
  assert.ok(forBen.includes("Erika"));
  assert.ok(!forBen.includes("987654"));
  assert.ok(!forBen.includes("Gehalt"));
  assert.ok(forBen.includes("vertraulich-xyz"));
  const forCara = text(await exportMarkdown(cara, { pageId: pid, format: "markdown", includeSubpages: false }));
  assert.ok(!forCara.includes("vertraulich-xyz"));
  const forAna = text(await exportMarkdown(ana, { pageId: pid, format: "markdown", includeSubpages: false }));
  assert.ok(forAna.includes("987654"));
});

test("share links and publications never show restricted properties", async () => {
  const token = ((await command(ana, { action: "share.create", pageId: pid, role: "editor", includeChildren: false, name: "Gäste" })) as { token: string }).token;
  const shared = await sharedContent(token, pid, rowId);
  assert.ok(!shared.fields.some((f) => ["salary", "note", "double"].includes(f.id)));
  assert.equal(JSON.stringify(shared).includes("987654"), false);
  assert.ok((await publicRows(pid)).every((r) => r.cells.salary === undefined && r.cells.note === undefined));
  await fails(
    async () => await mutateSharedContent(token, { action: "cells", pageId: pid, rowId, version: shared.version, cells: { salary: 1 } }),
    403,
  );
  await fails(async () => await mutateSharedContent(token, { action: "create", pageId: pid, cells: { title: "Gast", note: "x" } }), 403);
});

test("forms never ask for restricted properties", async () => {
  await command(ana, { action: "form.update", pageId: pid, enabled: true, internal: false, anonymous: true });
  const form = await getForm((await formSettings(pid))!.token, null);
  assert.ok(form.fields.some((f) => f.id === "role"));
  assert.ok(!form.fields.some((f) => ["salary", "note"].includes(f.id)));
  await fails(async () => await saveFormSubmission(pid, null, { title: "Bewerbung", salary: 5 }), 403);
  await saveFormSubmission(pid, null, { title: "Bewerbung", role: "Praktikum" });
});

test("MCP tools read and write only what the person may", async () => {
  const tokenFor = async (user: Identity) => {
    const { token } = (await command(user, { action: "token.create", name: "MCP", scope: "write" })) as { token: string };
    return (await identityFromApiToken(`Bearer ${token}`))!;
  };
  let seq = 0;
  const call = async (user: Identity, name: string, args: Record<string, unknown>) => {
    const answer = (await handleMcpMessage(user, { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } })) as unknown as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    return { error: !!answer.result.isError, text: answer.result.content[0].text };
  };
  const benToken = await tokenFor(ben),
    anaToken = await tokenFor(ana);
  const query = await call(benToken, "query_database", { databaseId: pid });
  assert.equal(query.error, false);
  assert.ok(query.text.includes("Erika"));
  assert.ok(!query.text.includes("987654"));
  assert.ok(!query.text.includes("Gehalt"));
  const record = await call(benToken, "get_record", { databaseId: pid, recordId: rowId });
  assert.ok(!record.text.includes("987654"));
  assert.ok((await call(anaToken, "get_record", { databaseId: pid, recordId: rowId })).text.includes("987654"));
  const write = await call(benToken, "update_record", { databaseId: pid, recordId: rowId, properties: { Gehalt: 1 } });
  assert.equal(write.error, true);
  const note = await call(benToken, "update_record", { databaseId: pid, recordId: rowId, properties: { "Interne Notiz": "x" } });
  assert.equal(note.error, true);
  assert.equal((await view(ana)).cells.salary, 987654);
});

test("AI sources leave restricted properties out", async () => {
  const text = JSON.stringify(await sourceText(pid, rowId));
  assert.ok(text.includes("Erika"));
  assert.ok(!text.includes("987654"));
  assert.ok(!text.includes("vertraulich-xyz"));
  assert.ok(!JSON.stringify(await sourceText(pid)).includes("Gehalt"));
});

test("share links, guest writes and publication copies leave out properties derived from a restricted one", async () => {
  const db = ((await command(ana, { action: "page.create", workspaceId: wid, spaceId: space, title: "Bewertungen", kind: "database" })) as { id: string }).id;
  const defs: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "secret", name: "Intern", type: "text", access: { read: "owners" } },
    { id: "summary", name: "Zusammenfassung", type: "text", ai: { prompt: "Fasse {Intern} zusammen" } },
    { id: "open", name: "Offen", type: "text" },
  ];
  await command(ana, { action: "database.update", pageId: db, version: (await database(db)).version, fields: defs, views: (await database(db)).views });
  const rid = ((await command(ana, { action: "row.create", pageId: db, cells: { title: "Erika", secret: "geheim-123", open: "sichtbar" } })) as { id: string }).id;
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ title: "Erika", secret: "geheim-123", summary: "abgeleitet-456", open: "sichtbar" }), rid);
  assert.ok(publicHiddenFieldIds(defs).has("summary"));
  const token = ((await command(ana, { action: "share.create", pageId: db, role: "editor", includeChildren: false, name: "Gäste" })) as { token: string }).token;
  const shared = await sharedContent(token, db, rid);
  assert.ok(!shared.fields.some((f) => f.id === "summary" || f.id === "secret"));
  assert.ok(shared.fields.some((f) => f.id === "open"));
  assert.equal(JSON.stringify(shared).includes("abgeleitet-456"), false);
  // Neither an edit nor a new record writes the derived property; other properties still change.
  await fails(async () => await mutateSharedContent(token, { action: "cells", pageId: db, rowId: rid, version: shared.version, cells: { summary: "überschrieben" } }), 403);
  await fails(async () => await mutateSharedContent(token, { action: "create", pageId: db, cells: { title: "Gast", summary: "x" } }), 403);
  await mutateSharedContent(token, { action: "cells", pageId: db, rowId: rid, version: shared.version, cells: { open: "neu" } });
  const kept = JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
  assert.deepEqual({ open: kept.open, summary: kept.summary, secret: kept.secret }, { open: "neu", summary: "abgeleitet-456", secret: "geheim-123" });
  // A copy of the publication carries neither the property nor its values.
  await command(ana, { action: "page.publish", pageId: db, enabled: true, allowCopy: true });
  const visitorWorkspace = await createWorkspace(ben.id, "Besuch");
  const visitorSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", visitorWorkspace))!.id;
  const publicToken = (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", db))!.public_token;
  const copy = ((await command(ben, { action: "publication.copy", token: publicToken, workspaceId: visitorWorkspace, spaceId: visitorSpace })) as { id: string }).id;
  const copied = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", copy))!.fields) as Field[];
  assert.deepEqual(copied.map((f) => f.id), ["title", "open"]);
  const copiedCells = (await one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", copy))!.cells;
  assert.doesNotMatch(copiedCells, /abgeleitet-456|geheim-123/);
  await command(ana, { action: "page.publish", pageId: db, enabled: false });
});
