// My tasks → "Alle Arbeitsbereiche" (#564, lib/all-workspace-tasks.ts): the
// tasks and task records of all the person's workspaces in one answer –
// never of a workspace they left, never from a page they cannot read; the
// workspace filter and the caps; and a constant number of statements per
// workspace (no query per task), measured with 10 and 20 workspaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { sqliteOnly } from "./helpers/backend";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-all-tasks-"));
// Counts the SQL statements (lib/runtime-metrics.ts).
process.env.FLOWPLAN_METRICS_LOOP = "1";
const { run, id } = await import("../lib/db");
const { startRuntimeMetrics } = await import("../lib/runtime-metrics");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { allWorkspaceTasks, ALL_WORKSPACES_MAX } = await import("../lib/all-workspace-tasks");
const { crossRecords } = await import("../lib/cross-records");
startRuntimeMetrics();

const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const taskList = (...items: [string, string?][]) =>
  `<ul data-type="taskList">${items.map(([text, due]) => `<li data-type="taskItem" data-checked="false"${due ? ` data-due="${due}"` : ""}><p>${text}</p></li>`).join("")}</ul>`;
const page = async (user: Identity, workspaceId: string, spaceId: string, title: string, html: string) =>
  ((await command(user, { action: "page.import", workspaceId, spaceId, title, content: html, format: "html" })) as { id: string }).id;
const firstSpace = async (user: Identity, workspaceId: string) => (await bootstrap(user, workspaceId)).spaces[0].id;
const taskDatabase = async (user: Identity, workspaceId: string, spaceId: string, title: string) => {
  const pageId = ((await command(user, { action: "page.create", workspaceId, spaceId, kind: "database", title })) as { id: string }).id;
  await command(user, {
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
      { id: "who", name: "Assignee", type: "person" },
      { id: "due", name: "Due", type: "date" },
    ],
    views: (await database(pageId)).views,
  });
  return pageId;
};

const anna = await person("Anna");
const ben = await person("Ben");
// Ben's own workspace, a team workspace of Anna's he is in, and one he left.
const alpha = await createWorkspace(ben.id, "Alpha");
const beta = await createWorkspace(anna.id, "Beta");
const gamma = await createWorkspace(anna.id, "Gamma");
await run("INSERT INTO members VALUES(?,?,?)", beta, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", gamma, ben.id, "editor");
const alphaSpace = await firstSpace(ben, alpha);
const betaSpace = await firstSpace(anna, beta);
const gammaSpace = await firstSpace(anna, gamma);
await page(ben, alpha, alphaSpace, "Umzug", taskList(["Kartons kaufen", "2020-01-01"]));
const betaPage = await page(anna, beta, betaSpace, "Sprint", taskList([`Angebot schreiben ${mention(ben)}`, "2030-01-10"]));
// Anna's private space in Beta: a task given to Ben he cannot open.
const privateSpace = ((await command(anna, { action: "space.create", workspaceId: beta, name: "Privat", private: true })) as { id: string }).id;
const secret = await page(anna, beta, privateSpace, "Kündigungen", taskList([`Ben-Kündigung ${mention(ben)}`, "2020-01-01"]));
const gammaPage = await page(anna, gamma, gammaSpace, "Alt", taskList([`Altlast ${mention(ben)}`, "2020-01-01"]));
const tasks = await taskDatabase(anna, beta, betaSpace, "Aufgaben");
const rowId = ((await command(anna, { action: "row.create", pageId: tasks, cells: { title: "Pläne prüfen", status: "Open", who: ben.id, due: "2030-02-01" } })) as { id: string }).id;
await command(anna, { action: "row.create", pageId: tasks, cells: { title: "Annas Eintrag", status: "Open", who: anna.id } });
// Ben left Gamma.
await run("DELETE FROM members WHERE workspace_id=? AND user_id=?", gamma, ben.id);

test("tasks and records of all workspaces, each with its workspace", async () => {
  const result = await allWorkspaceTasks(ben, {});
  assert.deepEqual(result.workspaces.map((w) => w.name), ["Alpha", "Beta"]);
  assert.deepEqual(result.shown, [alpha, beta]);
  assert.deepEqual(
    result.tasks.map((t) => [t.text, t.workspaceId]).sort(),
    [["Angebot schreiben @Ben", beta], ["Kartons kaufen", alpha]],
  );
  assert.deepEqual(result.records.map((r) => [r.title, r.workspaceId, r.dueField, typeof r.version]), [["Pläne prüfen", beta, "due", "number"]]);
  assert.equal(result.limited, false);
  assert.equal(result.workspacesLimited, false);
});

test("a workspace the person left and a page they cannot read never appear", async () => {
  const result = await allWorkspaceTasks(ben, { filter: { mine: false } });
  const texts = result.tasks.map((t) => t.text);
  assert.ok(!texts.some((t) => t.startsWith("Ben-Kündigung")), "a task in someone else's private page");
  assert.ok(!texts.some((t) => t.startsWith("Altlast")), "a task of a workspace he left");
  assert.ok(!result.workspaces.some((w) => w.id === gamma));
  // Asking for the workspace he left by id changes nothing.
  const asked = await allWorkspaceTasks(ben, { workspaces: [gamma] });
  assert.deepEqual([asked.shown, asked.tasks, asked.records], [[], [], []]);
  // "Alle" for records widens to every record he can read – Anna's one in
  // Beta – never beyond his workspaces.
  assert.deepEqual(result.records.map((r) => r.title).sort(), ["Annas Eintrag", "Pläne prüfen"]);
  // Changing such tasks is refused as before (the endpoints check the page).
  await assert.rejects(command(ben, { action: "task.update", pageId: secret, rowId: null, index: 0, text: `Ben-Kündigung @Ben`, checked: true }));
  await assert.rejects(command(ben, { action: "task.update", pageId: gammaPage, rowId: null, index: 0, text: `Altlast @Ben`, checked: true }));
});

test("the workspace filter, records left out, completed tasks", async () => {
  const onlyAlpha = await allWorkspaceTasks(ben, { workspaces: [alpha] });
  assert.deepEqual(onlyAlpha.shown, [alpha]);
  assert.deepEqual(onlyAlpha.tasks.map((t) => t.text), ["Kartons kaufen"]);
  assert.deepEqual(onlyAlpha.records, []);
  // All workspaces are still listed, for the chips.
  assert.equal(onlyAlpha.workspaces.length, 2);
  assert.deepEqual((await allWorkspaceTasks(ben, { records: false })).records, []);
  // A task of another workspace is ticked off and moved like one of the current one.
  const offer = (await allWorkspaceTasks(ben, { workspaces: [beta] })).tasks[0];
  await command(ben, { action: "task.update", pageId: betaPage, rowId: null, index: offer.index, text: offer.text, due: "2030-01-12" });
  await command(ben, { action: "task.update", pageId: betaPage, rowId: null, index: offer.index, text: offer.text, checked: true });
  assert.deepEqual((await allWorkspaceTasks(ben, { workspaces: [beta] })).tasks, []);
  const done = (await allWorkspaceTasks(ben, { workspaces: [beta], done: true, filter: { open: false } })).tasks;
  assert.deepEqual(done.map((t) => [t.text, t.checked, t.due]), [["Angebot schreiben @Ben", true, "2030-01-12"]]);
});

test("a record moved on the board: its due date property, with the record's version", async () => {
  const [record] = (await allWorkspaceTasks(ben, { workspaces: [beta] })).records;
  await command(ben, { action: "row.update", pageId: record.pageId, rowId: record.rowId, version: record.version, cells: { [record.dueField!]: "2030-03-01" } });
  assert.equal((await allWorkspaceTasks(ben, { workspaces: [beta] })).records[0].due, "2030-03-01");
  await command(ben, { action: "row.update", pageId: record.pageId, rowId, version: record.version + 1, cells: { [record.dueField!]: "" } });
  assert.equal((await allWorkspaceTasks(ben, { workspaces: [beta] })).records[0].due, null);
  // A stale version is refused, not applied over a newer change.
  await assert.rejects(
    command(ben, { action: "row.update", pageId: record.pageId, rowId, version: record.version, cells: { [record.dueField!]: "2030-04-01" } }),
    /geändert/,
  );
});

test("caps: records per call, workspaces per request", async () => {
  const limited = await crossRecords(ben, beta, { mine: false, tasks: true }, 1);
  assert.equal(limited.records.length, 1);
  assert.equal(limited.limited, true);
  const carl = await person("Carl");
  for (let i = 0; i < ALL_WORKSPACES_MAX + 2; i++) await createWorkspace(carl.id, `W${String(i).padStart(2, "0")}`);
  const result = await allWorkspaceTasks(carl, {});
  assert.equal(result.workspaces.length, ALL_WORKSPACES_MAX + 2);
  assert.equal(result.shown.length, ALL_WORKSPACES_MAX);
  assert.equal(result.workspacesLimited, true);
});

const statements = () => (globalThis as { flowplanRuntimeMetrics?: { sqlCount: number } }).flowplanRuntimeMetrics!.sqlCount;
test("20 workspaces: the same few statements per workspace, none per task", { skip: sqliteOnly }, async () => {
  const dora = await person("Dora");
  const seed = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const w = await createWorkspace(dora.id, `Büro ${Date.now()}-${i}`);
      const space = await firstSpace(dora, w);
      await page(dora, w, space, `Projekt ${i}`, taskList([`Plan ${i}a`, "2030-01-01"], [`Plan ${i}b`, "2020-01-01"], [`Plan ${i}c`, "2030-05-01"]));
      const db = await taskDatabase(dora, w, space, `Aufgaben ${i}`);
      for (let r = 0; r < 3; r++) await command(dora, { action: "row.create", pageId: db, cells: { title: `Eintrag ${i}.${r}`, status: "Open", who: dora.id } });
    }
  };
  const measure = async () => {
    const before = statements();
    const started = performance.now();
    const result = await allWorkspaceTasks(dora, {});
    return { result, count: statements() - before, ms: performance.now() - started };
  };
  await seed(10);
  const ten = await measure();
  assert.equal(ten.result.tasks.length, 30);
  assert.equal(ten.result.records.length, 30);
  await seed(10);
  const twenty = await measure();
  assert.equal(twenty.result.shown.length, 20);
  assert.equal(twenty.result.tasks.length, 60);
  assert.equal(twenty.result.records.length, 60);
  // Ten more workspaces with 30 more tasks and records: at most 40
  // statements each (membership, its databases, their rows and settings,
  // the page rights at once) – nothing per task.
  const perWorkspace = (twenty.count - ten.count) / 10;
  console.log(`statements: 10 workspaces ${ten.count}, 20 workspaces ${twenty.count} (${perWorkspace} per workspace), ${Math.round(twenty.ms)} ms`);
  assert.ok(perWorkspace <= 40, `${perWorkspace} statements per workspace`);
  // 30 more records and 30 more tasks (in one more page) in one workspace:
  // a few statements for the new page, none per task or record.
  const [last] = twenty.result.records.slice(-1);
  for (let r = 0; r < 30; r++) await command(dora, { action: "row.create", pageId: last.pageId, cells: { title: `Mehr ${r}`, status: "Open", who: dora.id } });
  await page(dora, last.workspaceId, (await bootstrap(dora, last.workspaceId)).spaces[0].id, "Viele", taskList(...Array.from({ length: 30 }, (_, i): [string, string] => [`Viel ${i}`, "2030-06-01"])));
  const more = await measure();
  assert.equal(more.result.tasks.length, 90);
  assert.equal(more.result.records.length, 90);
  assert.ok(more.count - twenty.count <= 10, `${more.count - twenty.count} more statements for 60 more tasks and records`);
});
