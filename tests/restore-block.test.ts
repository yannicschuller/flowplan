import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-restore-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { snapshotChanges } = await import("../lib/version-history");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "History"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Notes" })).id as string;
const seed = async (html: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const html = async () => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

test("single paragraphs come back from an older version", async () => {
  await seed("<p>Intro</p><p>Keep <strong>this</strong> one</p><p>Middle text</p><p>End</p>");
  await act({ action: "page.snapshot", pageId });
  const snapshotId = (await one<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY created_at DESC", pageId))!.id;
  await seed("<p>Intro</p><p>Middle text changed</p><p>End</p>");
  const changes = (await snapshotChanges(owner, pageId, snapshotId)).changes as { type: string }[];
  assert.deepEqual(changes.map((c) => c.type), ["same", "removed", "changed", "same"]);
  // The removed paragraph returns after "Intro", with its formatting.
  await act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Keep this one", after: "Intro" });
  assert.match(await html(), /<p>Intro<\/p><p>Keep <strong>this<\/strong> one<\/p><p>Middle text changed<\/p>/);
  // A changed paragraph is replaced by its old wording.
  await act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Middle text", after: "Keep this one", replace: "Middle text changed" });
  assert.match(await html(), /<p>Keep <strong>this<\/strong> one<\/p><p>Middle text<\/p><p>End<\/p>/);
  await assert.rejects(async () => await act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Never there" }), /nicht in dieser Version/);
});

// What the version history sends for a change (components/version-changes.tsx).
type Change = { type: string; text?: string; parts?: { type: string; text: string }[] };
const oldText = (c: Change) => (c.type === "changed" ? c.parts!.filter((p) => p.type !== "added").map((p) => p.text).join("") : c.type === "added" ? null : c.text!);
const newText = (c: Change) => (c.type === "changed" ? c.parts!.filter((p) => p.type !== "removed").map((p) => p.text).join("") : null);
async function restoreFirst(old: string, now: string) {
  await seed(old);
  const snapshotId = (await act({ action: "page.snapshot", pageId })).id as string;
  await seed(now);
  const changes = (await snapshotChanges(owner, pageId, snapshotId)).changes as Change[];
  const i = changes.findIndex((c) => c.type === "removed" || c.type === "changed");
  let after: string | null = null;
  for (let j = i - 1; j >= 0 && !after; j--) after = oldText(changes[j]);
  await act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: oldText(changes[i]), after, replace: newText(changes[i]) });
  return await html();
}

test("paragraphs with line breaks or formulas, list items and repeated text are restored in place", async () => {
  // A line break splits the paragraph in the comparison; the whole paragraph returns.
  assert.match(await restoreFirst("<p>Intro</p><p>line one<br>line two</p><p>End</p>", "<p>Intro</p><p>End</p>"), /<p>Intro<\/p><p>line one<br ?\/?>line two<\/p><p>End<\/p>/);
  assert.match(await restoreFirst("<p>Intro</p><p>line one<br>line two</p>", "<p>Intro</p><p>line one<br>line 2</p>"), /<p>Intro<\/p><p>line one<br ?\/?>line two<\/p>$/);
  // The second line of a paragraph that kept its first: the paragraph is whole again, once.
  assert.match(await restoreFirst("<p>Intro</p><p>line one<br>line two</p>", "<p>Intro</p><p>line one</p>"), /<p>Intro<\/p><p>line one<br ?\/?>line two<\/p>$/);
  // Inline formulas are part of the compared text.
  assert.match(
    await restoreFirst('<p>Intro</p><p>Energy <span data-math="E=mc^2" class="math-inline">E=mc^2</span> rules</p><p>End</p>', "<p>Intro</p><p>End</p>"),
    /<p>Intro<\/p><p>Energy <span[^>]*data-math="E=mc\^2"[^>]*>[^<]*<\/span> rules<\/p><p>End<\/p>/,
  );
  // A list item comes back as a list item, not as a paragraph in the one before.
  assert.match(await restoreFirst("<ul><li><p>a</p></li><li><p>b</p></li></ul><p>End</p>", "<ul><li><p>a</p></li></ul><p>End</p>"), /<ul><li><p>a<\/p><\/li><li><p>b<\/p><\/li><\/ul><p>End<\/p>/);
  // A paragraph after a list goes after the list.
  assert.match(await restoreFirst("<ul><li><p>a</p></li></ul><p>End</p>", "<ul><li><p>a</p></li></ul>"), /<ul><li><p>a<\/p><\/li><\/ul><p>End<\/p>/);
  // With repeated text, the paragraph goes after the right one.
  assert.match(await restoreFirst("<p>Note</p><p>x</p><p>Note</p><p>second kept</p>", "<p>Note</p><p>x</p><p>Note</p>"), /<p>Note<\/p><p>x<\/p><p>Note<\/p><p>second kept<\/p>/);
});

// created_at has whole seconds: versions saved within one second came in
// table order (oldest first on SQLite, any order on PostgreSQL), so "the
// newest version" in the history could be an older one. seq breaks the tie.
test("versions saved within one second are listed newest first", async () => {
  const page = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Quick saves" })).id as string;
  const made: string[] = [];
  for (const text of ["one", "two", "three"]) {
    await run("UPDATE documents SET html=?,state=? WHERE page_id=?", `<p>${text}</p>`, htmlState(`<p>${text}</p>`), page);
    made.push((await act({ action: "page.snapshot", pageId: page })).id);
  }
  await run("UPDATE snapshots SET created_at='2026-11-07 12:00:00' WHERE page_id=?", page);
  const { pageData } = await import("../lib/api");
  const listed = ((await pageData(owner, page)) as { snapshots: { id: string }[] }).snapshots.map((s) => s.id);
  assert.deepEqual(listed, [...made].reverse());
});
