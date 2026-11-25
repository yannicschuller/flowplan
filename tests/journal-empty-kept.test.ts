// #547: empty journal days that stayed. The automatic tidying (lib/journal.ts
// rollJournal) judged only the newest day before the new one, once, and
// compared a day with its template node by node – so a day that only
// looked like the template, or one judged at a moment it was not empty,
// stayed for good. Here every way a day can come about or be "touched"
// without getting anything of its own, and the days that must stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-empty-kept-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, openJournalDay, ensureJournalDay } = await import("../lib/journal");

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const lena = await account("Lena");
const wid = await createWorkspace(lena.id, "Tagebuch");
const space = (await bootstrap(lena, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(lena, { workspaceId: wid, ...body });
const BERLIN = "Europe/Berlin";

const pageOf = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
const trashed = async (pid: string) => !!(await pageOf(pid)).deleted_at;
// Written as the editor does (document.sync).
const sync = async (pid: string, body: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pid))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pid);
  await act({ action: "document.sync", pageId: pid, generation, update: Buffer.from(htmlState(body)).toString("base64") });
};
const html = async (pid: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))?.html || "");
const item = (text: string, checked = false) => `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p></li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const roll = async (jid: string, date: string) => await rollJournal(lena, await pageOf(jid), date, date, false, { zone: BERLIN });
let n = 0;
async function journal(template = "") {
  const jid = (await act({ action: "page.create", spaceId: space, title: `Journal ${++n}`, kind: "journal" })).id as string;
  if (template) await act({ action: "journal.settings", pageId: jid, template });
  return jid;
}

const TEMPLATE = "<h3>Dankbar für</h3><p></p><h3>Fokus heute</h3><p></p>";

// ---- Only empty blocks or the unchanged template ----

const looksEmpty: [string, string, (day: string) => string][] = [
  ["a space in an empty line of the template", TEMPLATE, () => "<h3>Dankbar für</h3><p> </p><h3>Fokus heute</h3><p></p>"],
  ["a no-break space", TEMPLATE, () => "<h3>Dankbar für</h3><p>&nbsp;</p><h3>Fokus heute</h3><p></p>"],
  ["a line break in an empty line", TEMPLATE, () => "<h3>Dankbar für</h3><p><br></p><h3>Fokus heute</h3><p></p>"],
  ["empty lines added after the template", TEMPLATE, () => `${TEMPLATE}<p></p><p></p>`],
  ["a space after a heading of the template", TEMPLATE, () => "<h3>Dankbar für </h3><p></p><h3>Fokus heute</h3><p></p>"],
  ["a template heading made bold", TEMPLATE, () => "<h3><strong>Dankbar für</strong></h3><p></p><h3>Fokus heute</h3><p></p>"],
  [
    "two lists of the template joined by the editor",
    "<h3>Erledigt</h3><ul><li><p></p></li></ul><ul><li><p></p></li></ul>",
    () => "<h3>Erledigt</h3><ul><li><p></p></li><li><p></p></li></ul>",
  ],
  ["block ids the editor gave the template's blocks", TEMPLATE, () => '<h3 data-block-id="b1a2c3d4">Dankbar für</h3><p data-block-id="b2a2c3d4"></p><h3>Fokus heute</h3><p></p>'],
  ["an empty task (no template)", "", () => `${list(item(""))}<p></p>`],
  ["an empty task in the template", TEMPLATE, () => `${TEMPLATE}${list(item(""))}`],
  ["a zero-width space (no template)", "", () => "<p>​</p>"],
];
for (const [name, template, body] of looksEmpty)
  test(`a day with only ${name} goes to the trash`, async () => {
    const jid = await journal(template);
    const day = (await roll(jid, "2026-03-02")).dayId;
    await sync(day, body(day));
    await roll(jid, "2026-03-03");
    assert.ok(await trashed(day), await html(day));
  });

// ---- Days judged once, or never ----

test("a past day created from the day picker and left empty goes at the next new day", async () => {
  const jid = await journal(TEMPLATE);
  const first = (await roll(jid, "2026-04-01")).dayId;
  await sync(first, `${TEMPLATE}<p>Erster Tag</p>`);
  const later = (await roll(jid, "2026-04-03")).dayId;
  await sync(later, `${TEMPLATE}<p>Dritter Tag</p>`);
  // Opened from the calendar, nothing written.
  const picked = (await openJournalDay(lena, await pageOf(jid), "2026-04-02", "2026-04-03", "2026-04-03")).dayId;
  await roll(jid, "2026-04-04");
  assert.ok(await trashed(picked));
  assert.ok(!(await trashed(first)) && !(await trashed(later)), "the days with an entry stay");
});

test("an empty day brought back by opening its date goes again at the next new day", async () => {
  const jid = await journal();
  const day = (await roll(jid, "2026-04-11")).dayId;
  await roll(jid, "2026-04-12");
  assert.ok(await trashed(day));
  const reopened = await openJournalDay(lena, await pageOf(jid), "2026-04-11", "2026-04-12", "2026-04-12", BERLIN);
  assert.equal(reopened.dayId, day);
  assert.ok(!(await trashed(day)));
  await roll(jid, "2026-04-13");
  assert.ok(await trashed(day), "still empty: tidied away again");
});

test("a day a person took back out of the trash stays", async () => {
  const jid = await journal();
  const day = (await roll(jid, "2026-04-15")).dayId;
  await roll(jid, "2026-04-16");
  assert.ok(await trashed(day));
  await act({ action: "page.restore", pageId: day });
  await roll(jid, "2026-04-17");
  assert.ok(!(await trashed(day)));
});

test("a day that had text when the next day began, emptied later, goes at the next new day", async () => {
  const jid = await journal();
  const day = (await roll(jid, "2026-04-21")).dayId;
  await sync(day, "<p>Vielleicht</p>");
  await roll(jid, "2026-04-22");
  assert.ok(!(await trashed(day)));
  await sync(day, "<p></p>");
  await roll(jid, "2026-04-23");
  assert.ok(await trashed(day));
});

test("a day before one a workflow made is judged at the next new day", async () => {
  const jid = await journal();
  const day = (await roll(jid, "2026-05-01")).dayId;
  // "An Journaltag anhängen" made today: it never removes the day before.
  const made = await ensureJournalDay(lena, await pageOf(jid), "2026-05-02", "2026-05-02");
  await sync(made.dayId, "<p>Vom Workflow</p>");
  assert.ok(!(await trashed(day)));
  await roll(jid, "2026-05-03");
  assert.ok(await trashed(day));
  assert.ok(!(await trashed(made.dayId)));
});

test("a title changed only in spaces or capitals counts as unchanged", async () => {
  const jid = await journal();
  const day = (await roll(jid, "2026-05-11")).dayId;
  const title = (await pageOf(day)).title;
  await run("UPDATE pages SET title=? WHERE id=?", ` ${title.toLocaleLowerCase()} `, day);
  await roll(jid, "2026-05-12");
  assert.ok(await trashed(day));
});

// ---- Days with something of their own stay ----

const own: [string, string, string][] = [
  ["text in an empty line", TEMPLATE, "<h3>Dankbar für</h3><p>Sonne</p><h3>Fokus heute</h3><p></p>"],
  ["a heading of the template rewritten", TEMPLATE, "<h3>Dankbar für Tee</h3><p></p><h3>Fokus heute</h3><p></p>"],
  ["a template line twice", TEMPLATE, `${TEMPLATE}<h3>Fokus heute</h3>`],
  ["the template's lines in another order", TEMPLATE, "<h3>Fokus heute</h3><p></p><h3>Dankbar für</h3><p></p>"],
  ["a task of its own", "", `${list(item("Anrufen"))}<p></p>`],
  ["an empty task ticked off", "", `${list(item("", true))}<p></p>`],
  ["a template task ticked off", `${list(item("Meditieren"))}<p></p>`, `${list(item("Meditieren", true))}<p></p>`],
  ["a divider", "", "<p></p><hr><p></p>"],
  ["text only (no template)", "", "<p>Ein Wort</p>"],
];
for (const [name, template, body] of own)
  test(`a day with ${name} stays`, async () => {
    const jid = await journal(template);
    const day = (await roll(jid, "2026-06-02")).dayId;
    await sync(day, body);
    await roll(jid, "2026-06-03");
    assert.ok(!(await trashed(day)), await html(day));
    // Nor later, when the days before are judged again.
    await roll(jid, "2026-06-04");
    assert.ok(!(await trashed(day)));
  });

test("tracker values, comments and files keep a day, also when judged again", async () => {
  const jid = await journal();
  const tracked = (await roll(jid, "2026-06-11")).dayId;
  await act({ action: "journal.entry", pageId: tracked, entry: { values: { mood: 4 } } });
  const commented = (await roll(jid, "2026-06-12")).dayId;
  await run("INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)", id(), commented, lena.id, "Notiz");
  await roll(jid, "2026-06-13");
  await roll(jid, "2026-06-14");
  assert.ok(!(await trashed(tracked)));
  assert.ok(!(await trashed(commented)));
});

test("days more than a week back are not judged again", async () => {
  const jid = await journal();
  const old = (await roll(jid, "2026-07-01")).dayId;
  await sync(old, "<p>Notiz</p>");
  const next = (await roll(jid, "2026-07-02")).dayId;
  await sync(next, "<p>Etwas</p>");
  // Emptied later; the next new day is three weeks on.
  await sync(old, "<p></p>");
  await roll(jid, "2026-07-20");
  assert.ok(!(await trashed(old)), "outside the last week");
  assert.ok(!(await trashed(next)));
});
