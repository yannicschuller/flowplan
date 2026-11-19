import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-text-links-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { textBacklinks } = await import("../lib/text-backlinks");
const { drainTextLinks, linkTargets, markAllTextLinks } = await import("../lib/text-links");
const { runDataSteps, TEXT_LINKS_STEP } = await import("../lib/data-steps");
const { pageLocationHash } = await import("../lib/page-location");

// The backlinks from the links table (#383) are the ones the scan over all
// HTML found: compared for every page and record of a workspace with links
// of all kinds, before and after edits, deletions and the trash.
async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const link = (pageId: string, rowId?: string) =>
  `<p><a href="/${pageLocationHash({ pageId, rowId }).replace(/&/g, "&amp;")}">Link</a></p>`;

const owner = await account("tl-owner"),
  member = await account("tl-member");
const wid = await createWorkspace(owner.id, "Verweise");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const spaces = (await bootstrap(owner, wid)).spaces;
const team = spaces[0].id;
const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
const page = async (title: string, kind = "document", spaceId = team) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId, title, kind })) as { id: string }).id;
const setHtml = async (pageId: string, html: string) =>
  await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pageId, html);
const rowText = async (rowId: string, html: string) =>
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET html=excluded.html",
    rowId,
    new Uint8Array(),
    html,
    "1",
  );

const notes = await page("Notizen", "database"),
  tasks = await page("Aufgaben", "database"),
  guide = await page("Anleitung"),
  overview = await page("Übersicht"),
  archive = await page("Archiv"),
  hidden = await page("Gehalt", "document", privateSpace),
  self = await page("Selbst");
const row = async (pageId: string, title: string) =>
  ((await command(owner, { action: "row.create", pageId, cells: { title } })) as { id: string }).id;
const heating = await row(notes, "Heizung"),
  log = await row(notes, "Protokoll"),
  secret = await row(notes, "Geheim"),
  legacy = await row(notes, "Alt"),
  todo = await row(tasks, "Erledigen");
await setHtml(overview, link(notes, heating) + link(guide) + `<p>#page=${archive} im Text</p>`);
await setHtml(archive, link(guide) + link(tasks, todo));
await setHtml(hidden, link(guide) + link(notes, heating));
await setHtml(self, link(self) + link(guide));
await setHtml(guide, "<p>Ohne Verweise</p>");
await rowText(log, link(notes, heating) + link(guide));
await rowText(secret, link(notes, heating) + link(guide) + link(overview));
await run("UPDATE rows SET access='private' WHERE id=?", secret);
// A record without a document: its legacy content counts.
await run("UPDATE rows SET content=? WHERE id=?", link(guide) + link(tasks, todo), legacy);
// A record link to a record of another database names only the record.
await rowText(todo, `<p><a href="/#row=${heating}">kaputt</a></p>` + link(notes, log));

const targets = async () => {
  const out: { pageId: string; rowId?: string }[] = [];
  for (const p of await all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=?", wid)) out.push({ pageId: p.id });
  for (const r of await all<{ id: string; page_id: string }>("SELECT r.id,r.page_id FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=?", wid))
    out.push({ pageId: r.page_id, rowId: r.id });
  return out;
};
const same = async (label: string) => {
  let found = 0;
  for (const user of [owner, member])
    for (const t of await targets()) {
      const target = { id: t.pageId, workspace_id: wid };
      const expected = await textBacklinks(user, target, t.rowId, 100, { scan: true });
      const actual = await textBacklinks(user, target, t.rowId);
      assert.deepStrictEqual(actual, expected, `${label}: ${user.name} → ${t.pageId}${t.rowId ? `/${t.rowId}` : ""}`);
      found += actual.length;
    }
  return found;
};

test("the links of a piece of HTML", () => {
  const a = "0f1e2d3c-0000-4000-8000-000000000001",
    b = "0f1e2d3c-0000-4000-8000-000000000002";
  assert.deepEqual(linkTargets(`<a href="/#page=${a}&amp;row=${b}">x</a> #page=${a} <a href="/#row=${b}&full=1">y</a>`).sort(), [`p:${a}`, `r:${b}`].sort());
  assert.deepEqual(linkTargets("<p>Nichts</p>"), []);
});

test("the table gives the backlinks the scan gives", async () => {
  assert.ok((await same("start")) > 10);
  // Edits: a link goes, another comes; a record's document replaces its content.
  await setHtml(overview, link(archive));
  await rowText(legacy, link(notes, heating));
  await run("UPDATE rows SET content=? WHERE id=?", link(overview), heating);
  await same("edited");
  // The trash and deletions.
  await run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", archive);
  await run("DELETE FROM rows WHERE id=?", log);
  await run("DELETE FROM row_documents WHERE row_id=?", legacy);
  await same("deleted");
  await run("UPDATE pages SET deleted_at=NULL WHERE id=?", archive);
  await same("restored");
  // Nothing marked afterwards, and the links of deleted sources are gone.
  await drainTextLinks();
  assert.equal(await one("SELECT 1 FROM text_link_dirty"), undefined);
  assert.equal(await one("SELECT 1 FROM text_links WHERE row_id=?", log), undefined);
});

test("the data step reads every source once", async () => {
  await run("DELETE FROM text_links");
  await run("DELETE FROM data_migrations WHERE name=?", TEXT_LINKS_STEP);
  await runDataSteps([TEXT_LINKS_STEP]);
  assert.equal(await one("SELECT 1 FROM text_link_dirty"), undefined);
  assert.ok(await one("SELECT 1 FROM text_links"));
  await same("rebuilt");
  // Marking all again changes nothing.
  await markAllTextLinks();
  await same("marked again");
});
