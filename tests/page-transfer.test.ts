import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-transfer-"));
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: "", disabled: 0, created_at: "", groups: [], isAdmin: false } as Identity;
}
const owner = account("Olga"),
  colleague = account("Carl"),
  stranger = account("Sven");
const from = createWorkspace(owner.id, "Alt"),
  to = createWorkspace(owner.id, "Neu");
run("INSERT INTO members VALUES(?,?,?)", from, colleague.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", from, stranger.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", to, colleague.id, "editor");
const fromSpace = bootstrap(owner, from).spaces[0].id,
  toSpace = bootstrap(owner, to).spaces[0].id;
const create = (title: string, kind = "document", parentId?: string) =>
  (command(owner, { action: "page.create", workspaceId: from, spaceId: fromSpace, title, kind, parentId }) as { id: string }).id;
const page = (pid: string) => one<Page>("SELECT * FROM pages WHERE id=?", pid)!;

test("a page moves with its sub pages; rights and favourites of the old workspace go", () => {
  const top = create("Projekt"),
    child = create("Unterseite", "document", top);
  const group = id();
  run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", group, from, "Team Alt");
  run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", top, null, group, "editor");
  run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", top, stranger.id, null, "viewer");
  run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", top, colleague.id, null, "viewer");
  run("INSERT INTO favorites VALUES(?,?)", stranger.id, child);
  run("INSERT INTO favorites VALUES(?,?)", colleague.id, child);
  command(owner, { action: "page.move", workspaceId: from, pageId: top, spaceId: toSpace, parentId: null });
  for (const pid of [top, child]) {
    assert.equal(page(pid).workspace_id, to);
    assert.equal(page(pid).space_id, toSpace);
  }
  assert.equal(page(child).parent_id, top, "the tree stays intact");
  const grants = all<{ user_id: string | null; group_id: string | null }>("SELECT user_id,group_id FROM grants WHERE resource_id=?", top);
  assert.deepEqual(grants.map((g) => g.user_id), [colleague.id]);
  assert.deepEqual(
    all<{ user_id: string }>("SELECT user_id FROM favorites WHERE page_id=?", child).map((f) => f.user_id),
    [colleague.id],
  );
  // Carl is in both workspaces and still reads it; Sven only in the old one.
  assert.ok(pageData(colleague, child));
  assert.throws(() => pageData(stranger, child), /Keine Berechtigung|nicht gefunden/);
  assert.ok(bootstrap(owner, to).pages.some((p: Page) => p.id === top));
  assert.ok(!bootstrap(owner, from).pages.some((p: Page) => p.id === top));
});

test("relations to databases staying behind block the move; moving both together works", () => {
  const target = create("Kunden", "database"),
    source = create("Aufträge", "database");
  const d = one<{ views: string; version: number }>("SELECT views,version FROM databases WHERE page_id=?", source)!;
  command(owner, {
    action: "database.update",
    pageId: source,
    version: d.version,
    fields: [
      { id: "title", name: "Titel", type: "text" },
      { id: "kunde", name: "Kunde", type: "relation", relationPage: target },
    ],
    views: JSON.parse(d.views),
  });
  assert.throws(
    () => command(owner, { action: "page.move", workspaceId: from, pageId: source, spaceId: toSpace }),
    /Kunde.*nicht mitverschoben/,
  );
  assert.equal(page(source).workspace_id, from, "nothing changed");
  // With the related database inside the moved tree it is fine.
  const folder = create("Vertrieb");
  command(owner, { action: "page.move", workspaceId: from, pageId: source, parentId: folder });
  command(owner, { action: "page.move", workspaceId: from, pageId: target, parentId: folder });
  command(owner, { action: "page.move", workspaceId: from, pageId: folder, spaceId: toSpace });
  assert.equal(page(source).workspace_id, to);
  assert.equal(page(target).workspace_id, to);
});

test("moving needs write access in the target workspace", () => {
  const mine = (command(colleague, { action: "page.create", workspaceId: from, spaceId: fromSpace, title: "Carls Seite", kind: "document" }) as { id: string }).id;
  const foreign = createWorkspace(stranger.id, "Fremd");
  const foreignSpace = bootstrap(stranger, foreign).spaces[0].id;
  assert.throws(
    () => command(colleague, { action: "page.move", workspaceId: from, pageId: mine, spaceId: foreignSpace }),
    /Keine Schreibrechte|Berechtigung/,
  );
  assert.equal(page(mine).workspace_id, from);
});
