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

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner");
const wid = createWorkspace(owner.id, "History"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Notes" }).id as string;
const seed = (html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const html = () => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;

test("single paragraphs come back from an older version", () => {
  seed("<p>Intro</p><p>Keep <strong>this</strong> one</p><p>Middle text</p><p>End</p>");
  act({ action: "page.snapshot", pageId });
  const snapshotId = one<{ id: string }>("SELECT id FROM snapshots WHERE page_id=? ORDER BY created_at DESC", pageId)!.id;
  seed("<p>Intro</p><p>Middle text changed</p><p>End</p>");
  const changes = snapshotChanges(owner, pageId, snapshotId).changes as { type: string }[];
  assert.deepEqual(changes.map((c) => c.type), ["same", "removed", "changed", "same"]);
  // The removed paragraph returns after "Intro", with its formatting.
  act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Keep this one", after: "Intro" });
  assert.match(html(), /<p>Intro<\/p><p>Keep <strong>this<\/strong> one<\/p><p>Middle text changed<\/p>/);
  // A changed paragraph is replaced by its old wording.
  act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Middle text", after: "Keep this one", replace: "Middle text changed" });
  assert.match(html(), /<p>Keep <strong>this<\/strong> one<\/p><p>Middle text<\/p><p>End<\/p>/);
  assert.throws(() => act({ action: "snapshot.restoreBlock", pageId, snapshotId, text: "Never there" }), /nicht in dieser Version/);
});
