import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-text-backlinks-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { recordBacklinks } = await import("../lib/relation-backlinks");
const { pageLocationHash } = await import("../lib/page-location");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
// Links as the editor stores them: "&" in an attribute becomes "&amp;".
const link = (pageId: string, rowId?: string) =>
  `<p><a href="/${pageLocationHash({ pageId, rowId }).replace(/&/g, "&amp;")}">Link</a></p>`;

test("pages and records whose text links to a page or record are backlinks, as far as readable", async () => {
  const owner = await account("tb-owner"),
    member = await account("tb-member");
  const wid = await createWorkspace(owner.id, "Wissen");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const team = (await bootstrap(owner, wid)).spaces[0].id;
  const page = async (title: string, kind = "document") =>
    ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title, kind })) as { id: string }).id;
  const notes = await page("Notizen", "database"),
    guide = await page("Anleitung"),
    overview = await page("Übersicht");
  const row = async (title: string) =>
    ((await command(owner, { action: "row.create", pageId: notes, cells: { title } })) as { id: string }).id;
  const heating = await row("Heizung – Wartung"),
    log = await row("Protokoll"),
    secret = await row("Geheim");
  const text = async (rowId: string, html: string) =>
    await run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET html=excluded.html",
      rowId,
      new Uint8Array(),
      html,
      "1",
    );
  // A page links to the record, two records link to the guide page.
  await run("UPDATE documents SET html=? WHERE page_id=?", link(notes, heating), overview);
  await text(log, link(notes, heating) + link(guide));
  await text(secret, link(notes, heating) + link(guide));
  await run("UPDATE rows SET access='private' WHERE id=?", secret);

  const ownerLinks = (await recordBacklinks(owner, notes, heating)).map((l) => [l.title, l.rowId ?? null, l.field]);
  assert.deepEqual(ownerLinks, [
    ["Übersicht", null, ""],
    ["Protokoll", log, ""],
    ["Geheim", secret, ""],
  ]);
  // The private record stays hidden from the member.
  assert.deepEqual(
    (await recordBacklinks(member, notes, heating)).map((l) => l.title),
    ["Übersicht", "Protokoll"],
  );
  // Page backlinks include records whose text links to the page.
  assert.deepEqual(
    (await pageData(member, guide)).backlinks.map(({ id, rowId, pageTitle, title }) => ({ id, rowId, pageTitle, title })),
    [{ id: notes, rowId: log, pageTitle: "Notizen", title: "Protokoll" }],
  );
  assert.equal((await pageData(owner, guide)).backlinks.length, 2);
  // A link to another record of the same database is not a backlink.
  assert.deepEqual(await recordBacklinks(owner, notes, log), []);
});
