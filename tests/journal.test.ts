import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, dayTitle, hasOwnEntry } = await import("../lib/journal");
const { documentSchema } = await import("../lib/document-schema");
const { Node: PMNode } = await import("@tiptap/pm/model");
const { yDocToProsemirrorJSON } = await import("y-prosemirror");

const uid = id();
await run(
  "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
  uid,
  uid,
  "Jana",
  "jana@example.test",
);
const user = {
  id: uid,
  name: "Jana",
  email: "jana@example.test",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
} as Identity;
const wid = await createWorkspace(user.id, "Journal");
const space = (await bootstrap(user, wid)).spaces[0].id;
const journalId = (
  (await command(user, {
    action: "page.create",
    workspaceId: wid,
    spaceId: space,
    title: "Mein Journal",
    kind: "journal",
  })) as { id: string }
).id;
const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;
const roll = async (day: string) => await rollJournal(user, await journal(), day, day);
const days = async () =>
  ((await pageData(user, journalId)) as { journal: { days: { id: string; journal_date: string }[] } })
    .journal.days;
const html = async (pageId: string) =>
  String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
// Writes a document as a user would (a full Yjs state).
const write = async (pageId: string, body: string) =>
  await run(
    "UPDATE documents SET state=?,html=? WHERE page_id=?",
    htmlState(body),
    body,
    pageId,
  );
const task = (text: string, checked = false, since?: string) =>
  `<li data-type="taskItem" data-checked="${checked}"${since ? ` data-journal-since="${since}"` : ""}><p>${text}</p></li>`;
const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

test("day titles are German and dates outside the server day are refused", async () => {
  assert.equal(dayTitle("2026-09-26"), "Samstag, 26. September 2026");
  await assert.rejects(
    async () => await rollJournal(user, await journal(), "2026-09-20", "2026-09-26"),
    /Serverzeit/,
  );
});

test("a new day gets its page once; open tasks move over, done ones stay", async () => {
  const first = await roll("2026-09-01");
  assert.equal(first.changed, true);
  assert.equal((await roll("2026-09-01")).changed, false, "same day: nothing new");
  const monday = first.dayId;
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", monday))!;
  assert.equal(page.title, "Dienstag, 1. September 2026");
  assert.equal(page.parent_id, journalId);
  assert.equal(page.journal_date, "2026-09-01");
  await write(
    monday,
    `<p>Heute viel geschafft</p>${tasks(task("Bericht schreiben"), task("Mails", true))}`,
  );
  const tuesday = (await roll("2026-09-02")).dayId;
  // Open task moved (not copied), done task and text stay on Monday.
  assert.match(await html(monday), /Heute viel geschafft/);
  assert.match(await html(monday), /Mails/);
  assert.doesNotMatch(await html(monday), /Bericht schreiben/);
  assert.match(await html(tuesday), /Bericht schreiben/);
  assert.match(await html(tuesday), /data-journal-since="2026-09-01"/);
  assert.doesNotMatch(await html(tuesday), /Mails/);
  // The stored Yjs state matches the html (editors load the state).
  const state = (await one<{ state: Uint8Array }>(
    "SELECT state FROM documents WHERE page_id=?",
    monday,
  ))!.state;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  assert.doesNotMatch(JSON.stringify(yDocToProsemirrorJSON(ydoc, "default")), /Bericht/);
  assert.deepEqual(
    (await days()).map((d) => d.journal_date),
    ["2026-09-02", "2026-09-01"],
  );
});

test("a day with only carried tasks is removed; the tasks keep moving", async () => {
  const before = (await days())[0];
  assert.equal(before.journal_date, "2026-09-02");
  // Nobody wrote anything on the 2nd; two days later the journal is opened.
  const thursday = (await roll("2026-09-04")).dayId;
  assert.equal(await one("SELECT id FROM pages WHERE id=?", before.id), undefined);
  assert.deepEqual(
    (await days()).map((d) => d.journal_date),
    ["2026-09-04", "2026-09-01"],
  );
  // The task still remembers the day it was first written down.
  assert.match(await html(thursday), /Bericht schreiben/);
  assert.match(await html(thursday), /data-journal-since="2026-09-01"/);
});

test("new tasks, completed carried tasks and text all count as an entry", async () => {
  const schema = documentSchema();
  const docOf = (body: string) => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, htmlState(body));
    return PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
  };
  const day = "2026-09-04";
  assert.equal(hasOwnEntry(docOf(tasks(task("Alt", false, "2026-09-01"))), day), false);
  assert.equal(hasOwnEntry(docOf(`${tasks(task("Alt", false, "2026-09-01"))}<p> </p>`), day), false);
  assert.equal(hasOwnEntry(docOf(tasks(task("Alt", true, "2026-09-01"))), day), true);
  assert.equal(hasOwnEntry(docOf(tasks(task("Neu"))), day), true);
  assert.equal(hasOwnEntry(docOf("<p>Notiz</p>"), day), true);
  assert.equal(hasOwnEntry(docOf("<hr>"), day), true);
  // A completed carried task keeps its day; the open ones move on.
  const current = (await days())[0];
  await write(
    current.id,
    tasks(task("Bericht schreiben", true, "2026-09-01"), task("Anrufen", false, "2026-09-01")),
  );
  const friday = (await roll("2026-09-05")).dayId;
  assert.ok(await one("SELECT id FROM pages WHERE id=?", current.id));
  assert.match(await html(current.id), /Bericht schreiben/);
  assert.doesNotMatch(await html(current.id), /Anrufen/);
  assert.match(await html(friday), /Anrufen/);
});

test("the command rolls every journal of the workspace for today", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const result = (await command(user, {
    action: "journal.roll",
    workspaceId: wid,
    date: today,
  })) as { changed: boolean };
  assert.equal(result.changed, true);
  assert.equal((await days())[0].journal_date, today);
  const again = (await command(user, {
    action: "journal.roll",
    workspaceId: wid,
    date: today,
  })) as { changed: boolean };
  assert.equal(again.changed, false);
  await assert.rejects(
    async () => await command(user, { action: "journal.roll", workspaceId: wid, date: "2026-02-30" }),
    /Datum/,
  );
});

test("a deleted day is reported and can be created anew", async () => {
  const day = "2026-11-02";
  const first = (await roll(day)).dayId;
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), first);
  const again = (await rollJournal(user, await journal(), day, day)) as { dayId: string; changed: boolean; trashed?: boolean };
  assert.equal(again.trashed, true);
  assert.equal(again.dayId, first);
  const fresh = (await rollJournal(user, await journal(), day, day, true)) as { dayId: string; changed: boolean };
  assert.equal(fresh.changed, true);
  assert.notEqual(fresh.dayId, first);
  // The deleted page stays in the trash as an ordinary page.
  assert.equal((await one<{ journal_date: string | null }>("SELECT journal_date FROM pages WHERE id=?", first))!.journal_date, null);
});
