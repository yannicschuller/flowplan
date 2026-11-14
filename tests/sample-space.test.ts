// "Beispielbereich" from the introduction (lib/sample-space.ts): created
// with one click, removed with one click – exactly what it created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sample-space-"));
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");

async function person(name: string, extra: Partial<Identity> = {}): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "", ...extra } as Identity;
}
const count = async (sql: string, ...args: string[]) => Number((await one<{ n: number }>(sql, ...args))?.n || 0);

test("one click creates a private space with sample pages; a second click answers with the same one", async () => {
  const ada = await person("Ada");
  const wid = await createWorkspace(ada.id, "Ada");
  const before = await count("SELECT count(*) n FROM pages WHERE workspace_id=?", wid);
  const sample = (await command(ada, { action: "sample.create", workspaceId: wid })) as { spaceId: string; pages: number };
  assert.equal(sample.pages, 5);
  const space = await one<{ visibility: string; owner_id: string; name: string }>("SELECT * FROM spaces WHERE id=?", sample.spaceId);
  assert.equal(space?.visibility, "private");
  assert.equal(space?.owner_id, ada.id);
  const pages = await all<{ title: string; kind: string; parent_id: string | null }>("SELECT title,kind,parent_id FROM pages WHERE space_id=? ORDER BY position", sample.spaceId);
  assert.deepEqual(pages.map((p) => p.kind).sort(), ["database", "document", "document", "document", "whiteboard"]);
  // The project database comes with its example records, the welcome page with text.
  const project = await one<{ id: string }>("SELECT p.id FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.space_id=?", sample.spaceId);
  assert.ok((await count("SELECT count(*) n FROM rows WHERE page_id=?", project!.id)) > 0);
  assert.ok(pages.some((p) => p.parent_id), "a sub-page shows nesting");
  assert.equal(await count("SELECT count(*) n FROM pages WHERE workspace_id=?", wid), before + 5);
  const again = (await command(ada, { action: "sample.create", workspaceId: wid })) as { spaceId: string };
  assert.equal(again.spaceId, sample.spaceId);
  assert.equal((await bootstrap(ada, wid)).sampleSpace?.spaceId, sample.spaceId);
  // Removing takes the space with it when nothing else is in it.
  const removed = (await command(ada, { action: "sample.remove", workspaceId: wid })) as { removedPages: number; keptPages: number; spaceRemoved: boolean };
  assert.deepEqual(removed, { removedPages: 5, keptPages: 0, spaceRemoved: true });
  assert.equal(await one("SELECT 1 FROM spaces WHERE id=?", sample.spaceId), undefined);
  assert.equal(await count("SELECT count(*) n FROM pages WHERE workspace_id=?", wid), before);
  assert.equal((await bootstrap(ada, wid)).sampleSpace, null);
  await assert.rejects(async () => await command(ada, { action: "sample.remove", workspaceId: wid }), /Kein Beispielbereich/);
});

test("removing leaves what the person added: own pages keep the space, moved pages stay where they are", async () => {
  const ben = await person("Ben");
  const wid = await createWorkspace(ben.id, "Ben");
  const home = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
  const sample = (await command(ben, { action: "sample.create", workspaceId: wid })) as { spaceId: string };
  const tracked = await all<{ id: string; title: string; kind: string }>("SELECT id,title,kind FROM pages WHERE space_id=?", sample.spaceId);
  const welcome = tracked.find((p) => p.kind === "document" && !p.title.includes("Wiki") && !p.title.includes("Besprechung"))!;
  // Own page below a sample page, and a sample page moved to the first space.
  const own = (await command(ben, { action: "page.create", workspaceId: wid, spaceId: sample.spaceId, parentId: welcome.id, title: "Meine Notiz" })) as { id: string };
  const board = tracked.find((p) => p.kind === "whiteboard")!;
  await command(ben, { action: "page.move", workspaceId: wid, pageId: board.id, spaceId: home, placement: "inside" });
  assert.equal((await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", board.id))?.space_id, home);
  const removed = (await command(ben, { action: "sample.remove", workspaceId: wid })) as { removedPages: number; keptPages: number; spaceRemoved: boolean };
  assert.deepEqual(removed, { removedPages: 4, keptPages: 1, spaceRemoved: false });
  // The own page stays, now at the top of the space; the moved board too.
  const left = await one<{ space_id: string; parent_id: string | null }>("SELECT space_id,parent_id FROM pages WHERE id=?", own.id);
  assert.deepEqual(left, { space_id: sample.spaceId, parent_id: null });
  assert.ok(await one("SELECT 1 FROM pages WHERE id=?", board.id));
  assert.ok(await one("SELECT 1 FROM spaces WHERE id=?", sample.spaceId));
  // No longer a sample: the space is the person's own now.
  assert.equal((await bootstrap(ben, wid)).sampleSpace, null);
  for (const p of tracked.filter((p) => p.id !== board.id)) assert.equal(await one("SELECT 1 FROM pages WHERE id=?", p.id), undefined, p.title);
});

test("viewers and demo accounts cannot create one; each person has their own", async () => {
  const cleo = await person("Cleo");
  const wid = await createWorkspace(cleo.id, "Cleo");
  const dan = await person("Dan");
  await run("INSERT INTO members VALUES(?,?,?)", wid, dan.id, "viewer");
  await assert.rejects(async () => await command(dan, { action: "sample.create", workspaceId: wid }), /Berechtigung/);
  const eve = await person("Eve");
  await run("INSERT INTO members VALUES(?,?,?)", wid, eve.id, "editor");
  const mine = (await command(cleo, { action: "sample.create", workspaceId: wid })) as { spaceId: string };
  const hers = (await command(eve, { action: "sample.create", workspaceId: wid })) as { spaceId: string };
  assert.notEqual(mine.spaceId, hers.spaceId);
  // Her removal leaves mine alone.
  await command(eve, { action: "sample.remove", workspaceId: wid });
  assert.ok(await one("SELECT 1 FROM spaces WHERE id=?", mine.spaceId));
  const demo = await person("Demo", { demo: true } as Partial<Identity>);
  const dwid = await createWorkspace(demo.id, "Demo");
  await assert.rejects(async () => await command(demo, { action: "sample.create", workspaceId: dwid }), /Demo/);
});
