// Rights around page tags (lib/page-properties-server.ts): tags for the
// whole workspace are created only by its owners, also through an archive
// import, and tagging a page behind a journal PIN needs the PIN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-taxonomy-rights-"));
const { all, run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { exportArchive, importArchive } = await import("../lib/archive");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  editor = await account("Emil");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (as: Identity, input: Record<string, unknown>) => (await command(as, input)) as { id: string } & Record<string, unknown>;

test("an editor's archive import creates no tags for the whole workspace", async () => {
  // The editor may not create workspace tags directly.
  await assert.rejects(async () => await act(editor, { action: "tag.save", workspaceId: wid, name: "Kündigungswelle", spaceId: null }), /Eigentümer/);
  // Their own workspace, where they are the owner: a workspace tag on a page.
  const own = await createWorkspace(editor.id, "Eigenes");
  const ownSpace = (await bootstrap(editor, own)).spaces[0].id;
  const pid = (await act(editor, { action: "page.create", workspaceId: own, spaceId: ownSpace, title: "Notiz", kind: "document" })).id;
  await act(editor, { action: "tag.save", workspaceId: own, name: "Kündigungswelle", spaceId: null });
  await act(editor, { action: "page.properties", pageId: pid, tags: ["Kündigungswelle"] });
  const bytes = await exportArchive(editor, own);
  // Imported into the team's workspace by the editor.
  await importArchive(editor, wid, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array));
  const workspaceWide = await all<{ name: string }>("SELECT name FROM page_tags WHERE workspace_id=? AND space_id IS NULL", wid);
  assert.deepEqual(workspaceWide, [], "an editor created a tag for the whole workspace");
  // The imported page keeps its tag, as one of its (imported) space.
  const restored = (await one<{ id: string; space_id: string }>("SELECT id,space_id FROM pages WHERE workspace_id=? AND title='Notiz'", wid))!;
  const tags = await all<{ name: string; space_id: string | null }>(
    "SELECT t.name,t.space_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=?",
    restored.id,
  );
  assert.deepEqual(tags, [{ name: "Kündigungswelle", space_id: restored.space_id }]);
});

test("an owner's archive import still brings workspace tags", async () => {
  const other = await createWorkspace(owner.id, "Quelle");
  const space = (await bootstrap(owner, other)).spaces[0].id;
  const pid = (await act(owner, { action: "page.create", workspaceId: other, spaceId: space, title: "Plan", kind: "document" })).id;
  await act(owner, { action: "tag.save", workspaceId: other, name: "Strategie", spaceId: null });
  await act(owner, { action: "page.properties", pageId: pid, tags: ["Strategie"] });
  const target = await createWorkspace(owner.id, "Ziel");
  const bytes = await exportArchive(owner, other);
  await importArchive(owner, target, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array));
  assert.deepEqual(await all<{ name: string }>("SELECT name FROM page_tags WHERE workspace_id=? AND space_id IS NULL", target), [{ name: "Strategie" }]);
});

test("tagging several pages needs the PIN of a locked journal", async () => {
  const journal = (await act(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Tagebuch", kind: "journal" })).id;
  await act(owner, { action: "journal.lock", pageId: journal, pin: "135790" });
  // One page at a time is refused without the PIN …
  await assert.rejects(async () => await act(editor, { action: "page.properties", pageId: journal, addTags: ["Gelesen"] }), /gesperrt/);
  // … and so is the batch.
  await assert.rejects(async () => await act(editor, { action: "pages.tag", workspaceId: wid, pageIds: [journal], addTags: ["Gelesen"] }), /gesperrt/);
  assert.deepEqual(await all("SELECT 1 FROM page_tag_links WHERE page_id=?", journal), []);
});

test("meta.usage names only pages the owner may read", async () => {
  const tag = (await act(owner, { action: "tag.save", workspaceId: wid, name: "Bewerbung", spaceId: null })).id;
  // A page in the editor's private space carries the workspace tag.
  const own = (await act(editor, { action: "space.create", workspaceId: wid, name: "Emils Ecke", private: true })).id;
  const secret = (await act(editor, { action: "page.create", workspaceId: wid, spaceId: own, title: "Bewerbung bei der Konkurrenz", kind: "document" })).id;
  await act(editor, { action: "page.properties", pageId: secret, tags: ["Bewerbung"] });
  // The workspace owner cannot open it …
  await assert.rejects(async () => await act(owner, { action: "page.properties", pageId: secret, addTags: [] }), /Berechtigung/);
  // … and the usage of the tag outside the team space counts it without its title.
  const answer = (await act(owner, { action: "meta.usage", workspaceId: wid, kind: "tag", id: tag, spaceId: team })) as unknown as {
    usage: { spaceId: string; pages: number; titles: string[] }[];
  };
  const there = answer.usage.find((u) => u.spaceId === own)!;
  assert.equal(there.pages, 1);
  assert.deepEqual(there.titles, [], "meta.usage reveals the title of a page the owner may not read");
});
