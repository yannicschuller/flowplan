// "Neue Unterseiten automatisch veröffentlichen": sub-pages that appear
// below a published page later join the publication with its settings –
// only those publishing by hand would allow (lib/publication.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-publication-auto-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { publicPage, publicTree, publicationSettings } = await import("../lib/publication");
const access = await import("../lib/share-access");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  colleague = await user("colleague"),
  wid = await createWorkspace(owner.id, "Publishing"),
  boot = await bootstrap(owner, wid),
  space = boot.spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, colleague.id, "editor");
const create = async (who: Identity, title: string, parentId?: string | null, extra: Record<string, unknown> = {}) =>
  ((await command(who, { action: "page.create", workspaceId: wid, spaceId: space, title, parentId, ...extra })) as { id: string }).id;
const publish = async (pageId: string, autoChildren: boolean, includeChildren = true) =>
  await command(owner, { action: "page.publish", pageId, enabled: true, includeChildren, autoChildren });
const token = async (pageId: string) => (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pageId))!.public_token;
const published = async (root: string) => new Set((await publicTree(await token(root))).pages.map((p) => p.id));
const stored = async (root: string) =>
  new Set((await all<{ page_id: string }>("SELECT page_id FROM publication_pages WHERE root_id=?", root)).map((x) => x.page_id));

test("a new sub-page joins with the publication's settings, also deeper down and from others", async () => {
  const root = await create(owner, "Handbuch"),
    before = await create(owner, "Vorher", root);
  await publish(root, true);
  assert.deepEqual(await publicationSettings(root).then((s) => [s.includeChildren, s.autoChildren, s.count]), [true, true, 2]);
  const child = await create(colleague, "Neu von Kollegin", root),
    deeper = await create(owner, "Tiefer", child),
    deepest = await create(colleague, "Noch tiefer", deeper);
  const pages = await published(root);
  for (const p of [root, before, child, deeper, deepest]) assert.ok(pages.has(p));
  // The count line follows.
  assert.equal((await publicationSettings(root)).count, 5);
  // Not written into the stored list: that stays what was chosen by hand.
  assert.deepEqual([...(await stored(root))].sort(), [root, before].sort());
  // Same password and end date as the published page.
  await command(owner, { action: "publication.protect", pageId: root, password: "geheim-123" });
  const t = await token(root);
  await assert.rejects(async () => await publicPage(t, deepest), (e: { status?: number }) => e.status === 401);
  const { value } = await access.unlockShare(t, "geheim-123", "10.0.0.9");
  await access.withShareCookie(value, async () => assert.equal((await publicPage(t, deepest)).page.title, "Noch tiefer"));
  // The count in the dialog does not need the password.
  assert.equal((await publicationSettings(root)).count, 5);
});

test("moving in publishes, moving out ends it; explicit choices elsewhere stay", async () => {
  const root = await create(owner, "Wiki");
  await publish(root, true);
  const outside = await create(owner, "Draußen"),
    below = await create(owner, "Darunter", outside);
  // Its own publication, chosen by hand.
  await publish(outside, false);
  assert.ok(!(await published(root)).has(outside));
  await command(owner, { action: "page.move", pageId: outside, targetId: root, placement: "inside" });
  assert.ok((await published(root)).has(outside) && (await published(root)).has(below), "moved in: published with what is below it");
  await command(owner, { action: "page.move", pageId: outside, parentId: null, spaceId: space });
  assert.ok(!(await published(root)).has(outside) && !(await published(root)).has(below), "moved out: no longer part of it");
  // Its own publication is untouched.
  assert.ok((await published(outside)).has(outside));
  // A page chosen by hand in the stored list is not removed by moving it out.
  const explicit = await create(owner, "Von Hand", root);
  await publish(root, true); // takes the current sub-pages into the stored list
  assert.ok((await stored(root)).has(explicit));
  await command(owner, { action: "page.move", pageId: explicit, parentId: null, spaceId: space });
  assert.ok((await stored(root)).has(explicit), "the stored choice stays");
  assert.ok(!(await published(root)).has(explicit), "but is not served outside the tree");
});

test("duplicated into and restored from the trash into the published tree", async () => {
  const root = await create(owner, "Doku"),
    child = await create(owner, "Kapitel", root);
  await publish(root, true);
  const copy = ((await command(owner, { action: "page.duplicate", pageId: child })) as { id: string }).id;
  assert.ok((await published(root)).has(copy));
  const trashed = await create(owner, "Gelöscht", root);
  await command(owner, { action: "page.delete", pageId: trashed });
  assert.ok(!(await published(root)).has(trashed));
  await command(owner, { action: "page.restore", pageId: trashed });
  assert.ok((await published(root)).has(trashed));
});

test("switched off: new sub-pages stay private; switching off keeps what joined", async () => {
  const root = await create(owner, "Blog");
  await publish(root, false);
  const later = await create(owner, "Später", root);
  assert.ok(!(await published(root)).has(later));
  assert.equal((await publicationSettings(root)).autoChildren, false);
  // Without the sub-pages, it cannot be on.
  const single = await create(owner, "Einzeln");
  await publish(single, true, false);
  assert.equal((await publicationSettings(single)).autoChildren, false);
  await create(owner, "Unter einzeln", single);
  assert.equal((await published(single)).size, 1);
  // On, then off again (the dialog sends the current selection along).
  await publish(root, true);
  const joined = await create(owner, "Dazugekommen", root);
  await publish(root, false);
  assert.ok((await published(root)).has(joined), "what had joined is now in the stored list");
  const after = await create(owner, "Danach", root);
  assert.ok(!(await published(root)).has(after));
});

test("never pages the publisher could not publish by hand: no edit right, PIN journal, encrypted, workflow", async () => {
  const root = await create(owner, "Team");
  await publish(root, true);
  // A sub-page the publisher may only read (a narrower page grant).
  const restricted = await create(colleague, "Nur lesen für Owner", root);
  await run(
    "INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)",
    restricted,
    owner.id,
    null,
    "viewer",
    "page",
    wid,
  );
  const underRestricted = await create(colleague, "Darunter", restricted);
  // A journal with a PIN and its days.
  const journal = await create(owner, "Tagebuch", root, { kind: "journal" });
  const day = await create(owner, "Tag", journal);
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET lock_hash=excluded.lock_hash", journal, "salt:hash");
  const visible = await create(owner, "Sichtbar", root);
  let pages = await published(root);
  assert.ok(pages.has(visible));
  for (const p of [restricted, underRestricted, journal, day]) assert.ok(!pages.has(p), "not published");
  // A publisher who left the instance publishes nothing new.
  await run("UPDATE users SET disabled=1 WHERE id=?", owner.id);
  assert.ok(!(await published(root)).has(visible));
  await run("UPDATE users SET disabled=0 WHERE id=?", owner.id);
  // An encrypted space (defence in depth: pages never move into one).
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  try {
    pages = await published(root);
    assert.ok(!pages.has(visible), "encrypted: nothing joins");
  } finally {
    await run("UPDATE spaces SET encrypted=0 WHERE id=?", space);
  }
  // Workflow pages (written directly: the feature may be off here).
  const workflow = id();
  await run(
    "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,created_by,position) VALUES(?,?,?,?,?,?,?,?)",
    workflow, wid, space, root, "Ablauf", "workflow", owner.id, 99,
  );
  assert.ok(!(await published(root)).has(workflow));
});
